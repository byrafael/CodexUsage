# Codex Usage Monitor

A side project to monitor ChatGPT Codex usage limits.

## Features

- Monitor daily and weekly token usage
- Track session and weekly limit progress
- Built with Bun and TypeScript
- Built on top of the Codex App-Server and LiteLM (for token costs)

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

   - `/day` for daily token/cost view (based on `codexbar cost` daily data)
   - `/week` for weekly token/cost and weekly window status
   - `/session` for short-window session status

   The main dashboard remains at `/`.

   Tip: if `codex app-server` is slow on startup in your environment, set

   ```bash
   APP_SERVER_TIMEOUT_MS=20000 bun start
   ```
