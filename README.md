# pi-model-failover

Pi Agent extenstion that auto-switches to a preconfigured failover model when the primary model fails with a transient or connection error. Inspired by the "AI resilience" pattern in OpenAI-failover setups and operational runbooks for unreliable upstream APIs.

## Features

**Context replay** — On model failover, captures the most recent user message from the session and re-queues it as a `followUp` after the swap. The failed turn is not lost, and prior assistant context upstream of the switch is preserved.

**Modeled on the primary's failure** — Inspects the last assistant message's `errorMessage` for shape and only switches when it matches a configured pattern. A successful primary never triggers a failover.

**Reason surfacing** — Distinguishes *no target registered* (`model not in models.json`), *no API key for failover* (`setModel` refused), and *no prior user message to replay*. Each gets its own level (`error`/`error`/`warning`) so they show up differently in the UI.

**Two pattern sets** —
- `transient` (default) — delegates to pi-ai's `isRetryableAssistantError`: connection, 5xx, 429, timeout, `fetch failed`, etc.
- `connection` — narrow `/connection error/i` regex for tunnels and proxies that bubble up as plain strings.
Note: `transient` deliberately **does not** switch on hard quota/billing errors (`insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, `Monthly
usage limit reached`, `available balance`, OpenCode `GoUsageLimitError` / `FreeUsageLimitError`). Those signal the user needs to top up, not that the network is
flaky, and silently falling back would hide the real problem.


## Installation

Install from npm:

```bash
pi install npm:pi-model-failover
```

Install into the current project only:

```bash
pi install npm:pi-model-failover -l
```

Or install from GitHub:

```bash
pi install git:github.com/eiei114/pi-model-fallback
```

Try it without permanently installing:

```bash
pi -e npm:pi-model-failover
```


## Configuration
Copy model-failover.example.json to:
`<cwd>/.pi/model-failover.json` (project) or `~/.pi/agent/model-failover.json` (global):

```json
{
  "failover": { "provider": "providerID", "model": "modelID" },
  "patterns": "transient"
}
```

- `failover.provider` / `failover.model` — **required.** Must resolve in your `models.json` or the failover is skipped with an error.
- `patterns` — `"transient"` (default) or `"connection"`.

## Usage

Activates automatically. No slash command; tuning is by config file.

Notification levels in Pi's UI:
- `info` — config active on session start (`model-failover: → provider/modelID`)
- `warning` — failover engaged, or switched model with no prior user message to replay
- `error` — failover model not found in registry, or `setModel` refused the switch (e.g. missing API key)


## Links

- npm: https://www.npmjs.com/package/pi-model-failover
- GitHub: https://github.com/eiei114/pi-model-failover
- Pi Agent: https://github.com/earendil-works/pi

## License
MIT
