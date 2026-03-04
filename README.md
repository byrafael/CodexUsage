# Codex Usage Monitor

A side project to monitor ChatGPT Codex usage limits.

## Features

- Monitor daily and weekly token usage
- Track session and weekly limit progress
- Built with Bun and TypeScript
- Built on top of the Codex App-Server, local Codex session logs, and LiteLLM pricing

## Getting Started

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start the server:

   ```bash
   bun start
   ```

3. Open the dashboard in your browser.
4. Focus pages are available:

   - `/day` for daily token/cost view (from local Codex session logs, USD estimated with LiteLLM pricing)
   - `/week` for weekly token/cost and weekly window status
   - `/session` for short-window session status

   The main dashboard remains at `/`.

   Tip: if `codex app-server` is slow on startup in your environment, set

   ```bash
   APP_SERVER_TIMEOUT_MS=20000 bun start
   ```

   Token/cost scans from local Codex logs refresh every second by default. You can tune it with:

   ```bash
   TOKEN_USAGE_REFRESH_MS=500 bun start
   ```

## CLI mode

You can also run a terminal dashboard that refreshes every second without a browser:

```bash
bun cli
```

By default it reads from `http://localhost:3000/api/usage` and refreshes every second.
Timestamps use 24-hour time by default; pass `--12hr` to show 12-hour time.

CLI options:

```bash
# Point at a different server/port
bun cli --server=http://localhost:3001
bun cli 4000

# Change refresh interval (milliseconds)
bun cli --interval=500

# Show only weekly info (same dataset as /week)
bun cli week
bun cli --mode=week

# Show only daily info (same dataset as /day)
bun cli day
bun cli --mode=day

# Include billing range line in day/week modes
bun cli week --range
bun cli day --range

# Optional env var
CODEX_MONITOR_SERVER=http://localhost:3000 bun cli
```
