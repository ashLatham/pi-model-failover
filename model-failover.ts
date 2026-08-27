/**
 * model-failover — auto-switch to a preconfigured failover when the primary
 * model fails to connect.
 *
 * Trigger: agent_settled (pi will not auto-retry/compact/continue after this).
 * Detection: stopReason === "error" on the last assistant message, with an
 * errorMessage matching the configured pattern set.
 *
 * Config (first match wins):
 *   cwd/.pi/model-failover.json     (project override)
 *   ~/.pi/agent/model-failover.json (global)
 *
 *   {
 *     "failover": { "provider": "openai", "model": "gpt-5.4" },
 *     "patterns": "transient" | "connection"
 *   }
 *
 * "transient"   — pi-ai's isRetryableAssistantError (connection, 5xx, 429,
 *                 timeout, fetch failed, etc.). Default.
 * "connection"  — narrow regex /connection error/i.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type TextBlock = { type: "text"; text: string };

// Minimal message shape; real entries carry richer fields we don't need here.
type Message = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: string | TextBlock[];
};

type Entry = { message?: Message };

type FailoverConfig = {
  failover: { provider: string; model: string };
  patterns?: "transient" | "connection";
};

const HOME = homedir();
const CONFIG_NAME = "model-failover.json";
type NotifyLevel = "info" | "warning" | "error";
type NotifyLike = { notify: (msg: string, level?: NotifyLevel) => void };
// Ctx-compatible: any object whose `ui` field exposes a notify() method.
const CONFIG_NOTIFY = (
  ctx: { ui: NotifyLike },
  level: NotifyLevel,
  msg: string,
) => ctx.ui.notify(`model-failover: ${msg}`, level);

async function readConfig(
  cwd: string,
  notify?: { ui: NotifyLike },
): Promise<FailoverConfig | null> {
  const candidates = [
    join(cwd, ".pi", CONFIG_NAME),
    join(HOME, ".pi", "agent", CONFIG_NAME),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as FailoverConfig;
      if (parsed?.failover?.provider && parsed?.failover?.model) return parsed;
      notify?.ui.notify(
        `bad config at ${path}: missing failover.provider or failover.model`,
        "warning",
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ENOENT = file simply not present → silently try the next location.
      // Anything else (JSON parse, permission, etc.) is a user-facing problem.
      if (err?.code !== "ENOENT") {
        notify?.ui.notify(
          `could not read ${path}: ${err?.message ?? String(e)}`,
          "warning",
        );
      }
    }
  }
  return null;
}

function matchesPattern(
  msg: Message,
  patterns: "transient" | "connection",
): boolean {
  if (patterns === "connection") {
    const err = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    return /connection error/i.test(err);
  }
  // "transient" — pi-ai owns the stopReason+errorMessage classification.
  return isRetryableAssistantError(msg as Parameters<typeof isRetryableAssistantError>[0]);
}

// Find the most recent message whose role matches `role`. Scans from newest.
function findLastMessage(
  entries: Entry[],
  role: "assistant" | "user",
): Message | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]?.message;
    if (m?.role === role) return m;
  }
  return undefined;
}

function userMessageText(msg: Message): string | undefined {
  const c = msg.content;
  if (typeof c === "string") return c || undefined;
  if (Array.isArray(c)) {
    const text = c
      .filter(
        (b): b is TextBlock =>
          !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let cfg: FailoverConfig | null = null;
  let cfgLoaded = false;
  // Single-flight guard: blocks a re-entrant agent_settled that fires before
  // sendUserMessage has fully returned. Does NOT cover arbitrary concurrent
  // firings — pi's event loop is sequential, but extension handlers queue.
  let busy = false;

  async function ensureCfg(ctx: { ui: NotifyLike; cwd: string }): Promise<FailoverConfig | null> {
    if (cfgLoaded) return cfg;
    cfg = await readConfig(ctx.cwd, ctx);
    cfgLoaded = true;
    return cfg;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Re-read on each session so config edits take effect without /reload.
    cfg = await readConfig(ctx.cwd, ctx);
    cfgLoaded = true;
    if (cfg) {
      CONFIG_NOTIFY(ctx, "info", `→ ${cfg.failover.provider}/${cfg.failover.model}`);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (busy) return;
    busy = true;
    try {
      const c = await ensureCfg(ctx);
      if (!c) return; // no config — silently inactive

      const entries = ctx.sessionManager.getEntries() as Entry[];
      const last = findLastMessage(entries, "assistant");
      if (!last || !matchesPattern(last, c.patterns ?? "transient")) return;

      const current = ctx.model;
      if (!current) return;

      const target = ctx.modelRegistry.find(c.failover.provider, c.failover.model);
      if (!target) {
        CONFIG_NOTIFY(
          ctx,
          "error",
          `${c.failover.provider}/${c.failover.model} not in models.json`,
        );
        return;
      }
      if (current.provider === target.provider && current.id === target.id) return;

      const ok = await pi.setModel(target);
      if (!ok) {
        CONFIG_NOTIFY(ctx, "error", `no API key for ${target.provider}/${target.id}`);
        return;
      }

      const original = userMessageText(findLastMessage(entries, "user") ?? {});
      if (!original) {
        CONFIG_NOTIFY(ctx, "warning", "switched model but no prior user message to replay");
        return;
      }

      pi.appendEntry("model_failover", {
        from: `${current.provider}/${current.id}`,
        to: `${target.provider}/${target.id}`,
        errorMessage: last.errorMessage,
        ts: Date.now(),
      });

      CONFIG_NOTIFY(
        ctx,
        "warning",
        `Primary ${current.provider}/${current.id} failed — switched to ${target.provider}/${target.id}`,
      );

      // Re-queue the failed turn as a new user message; existing assistant
      // context is preserved upstream of the switch.
      pi.sendUserMessage(original, { deliverAs: "followUp" });
    } catch (e) {
      CONFIG_NOTIFY(ctx, "error", String(e));
    } finally {
      busy = false;
    }
  });
}