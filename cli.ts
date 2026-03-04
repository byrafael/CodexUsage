import { createLogUpdate } from "log-update";

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  resetDescription: string | null;
  usedTokens: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
};

type CostSummary = {
  dayTokens: number | null;
  dayCostUSD: number | null;
  todayTokens: number | null;
  weeklyTokens: number | null;
  dayDate: string | null;
  dayResetsAt: string | null;
  todayCostUSD: number | null;
  weeklyCostUSD: number | null;
  weeklyWindowDays: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  sourceFetchedAt: string | null;
};

type MonitorSuccessResponse = {
  ok: true;
  stale: boolean;
  fetchedAt: string;
  sourceFetchedAt: string | null;
  accountEmail: string | null;
  loginMethod: string | null;
  session: UsageWindow;
  weekly: UsageWindow;
  cost: CostSummary;
  error?: string;
};

type MonitorErrorResponse = {
  ok: false;
  stale: boolean;
  fetchedAt: string;
  error: string;
};

type MonitorResponse = MonitorSuccessResponse | MonitorErrorResponse;

type CliMode = "all" | "day" | "week";

const POLL_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 3000;

function parseArgs(): { serverUrl: string; intervalMs: number; mode: CliMode; showRange: boolean } {
  let serverUrl =
    Bun.env.CODEX_MONITOR_SERVER ??
    Bun.env.CLI_SERVER_URL ??
    `http://localhost:${DEFAULT_PORT}`;
  let intervalMs = POLL_INTERVAL_MS;
  let mode: CliMode = "all";
  let showRange = false;

  const setMode = (value: string): void => {
    const candidate = value.toLowerCase();
    if (candidate === "all" || candidate === "day" || candidate === "week") {
      mode = candidate;
    }
  };

  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith("--server=")) {
      serverUrl = arg.split("=", 2)[1] ?? serverUrl;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      setMode(arg.split("=", 2)[1] ?? "");
      continue;
    }
    if (arg.startsWith("--interval=")) {
      const value = Number.parseInt(arg.split("=", 2)[1] ?? "", 10);
      if (Number.isFinite(value) && value > 0) {
        intervalMs = value;
      }
      continue;
    }
    if (arg === "--range") {
      showRange = true;
      continue;
    }
    if (arg.startsWith("--range=")) {
      const value = (arg.split("=", 2)[1] ?? "").toLowerCase();
      showRange = value === "1" || value === "true" || value === "yes";
      continue;
    }
    if (arg === "week" || arg === "day" || arg === "all") {
      setMode(arg);
      continue;
    }
    if (/^\d+$/.test(arg)) {
      serverUrl = `http://localhost:${arg}`;
      continue;
    }
  }

  if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
    serverUrl = `http://${serverUrl}`;
  }

  return {
    serverUrl,
    mode,
    showRange,
    intervalMs: Math.max(250, intervalMs),
  };
}

const { serverUrl, intervalMs, mode, showRange } = parseArgs();
const apiUrl = new URL("/api/usage", serverUrl).toString();
const log = createLogUpdate(process.stdout, { showCursor: false });

function formatInt(value: number | null): string {
  return value === null || Number.isNaN(value) ? "N/A" : Math.max(0, Math.round(value)).toLocaleString();
}

function formatPercent(value: number | null): string {
  return value === null || Number.isNaN(value) ? "N/A" : `${value.toFixed(1)}%`;
}

function formatCurrency(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "$N/A";
  }
  return `$${Math.max(0, value).toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "N/A";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function secondsFromNow(timestamp: string | null): number {
  if (!timestamp) {
    return NaN;
  }
  const target = new Date(timestamp).getTime();
  if (Number.isNaN(target)) {
    return NaN;
  }
  return (target - Date.now()) / 1000;
}

function formatCountdown(timestamp: string | null): string {
  const seconds = secondsFromNow(timestamp);
  if (!Number.isFinite(seconds)) {
    return "N/A";
  }
  if (seconds <= 0) {
    return "reset due";
  }

  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${secs}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  return `${minutes}m ${secs}s`;
}

function formatWindowReset(windowData: UsageWindow): string {
  return `${formatCountdown(windowData.resetsAt)} (${formatDate(windowData.resetDescription ?? windowData.resetsAt)})`;
}

function formatReset(timestamp: string | null): string {
  return `${formatCountdown(timestamp)} (${formatDate(timestamp)})`;
}

function formatAge(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(ageMs)) {
    return "N/A";
  }
  const secs = Math.floor(Math.max(0, ageMs / 1000));
  if (secs < 5) {
    return "just now";
  }
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    return `${hrs}h ago`;
  }
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function pad(label: string, width = 17): string {
  return `${label.padEnd(width, " ")}: `;
}

function render(payload: MonitorResponse | null, fetchError: string | null): void {
  const lines: string[] = [];
  const titlePrefix = mode === "week" ? "Weekly" : mode === "day" ? "Daily" : "Overview";
  const titleAccount = payload?.ok ? (payload.accountEmail ?? "Unknown") : null;
  lines.push(titleAccount ? `${titlePrefix} - ${titleAccount}` : titlePrefix);
  lines.push("");

  if (payload === null) {
    lines.push("Waiting for first sample...");
    if (fetchError) {
      lines.push(`Error: ${fetchError}`);
    }
    lines.push("");
    lines.push("Last fetched: --");
    logUpdate(lines);
    return;
  }

  const staleSuffix = payload.stale ? " - stale fallback" : "";

  if (payload.ok) {
    if (mode === "week") {
      lines.push(pad("Tokens") + formatInt(payload.cost.weeklyTokens));
      lines.push(pad("Cost") + formatCurrency(payload.cost.weeklyCostUSD));
      lines.push(pad("Used") + formatPercent(payload.weekly.usedPercent));
      lines.push(pad("Remaining") + formatPercent(payload.weekly.remainingPercent));
      lines.push(pad("Resets") + formatWindowReset(payload.weekly));
      if (showRange && payload.cost.rangeStart && payload.cost.rangeEnd) {
        lines.push(pad("Range") + `${formatDate(payload.cost.rangeStart)} -> ${formatDate(payload.cost.rangeEnd)}`);
      }
    } else if (mode === "day") {
      lines.push(pad("Tokens") + formatInt(payload.cost.dayTokens ?? payload.cost.todayTokens));
      lines.push(pad("Cost") + formatCurrency(payload.cost.dayCostUSD ?? payload.cost.todayCostUSD));
      lines.push(pad("Resets") + formatReset(payload.cost.dayResetsAt));
      if (showRange && payload.cost.rangeStart && payload.cost.rangeEnd) {
        lines.push(pad("Range") + `${formatDate(payload.cost.rangeStart)} -> ${formatDate(payload.cost.rangeEnd)}`);
      }
    } else {
      lines.push("");
      lines.push("Core counters");
      lines.push(pad("Today tokens") + formatInt(payload.cost.todayTokens));
      lines.push(pad("Weekly tokens") + formatInt(payload.cost.weeklyTokens));
      lines.push(pad("Today cost") + formatCurrency(payload.cost.todayCostUSD));
      lines.push(pad("Weekly cost") + formatCurrency(payload.cost.weeklyCostUSD));
      lines.push("");

      lines.push("Session window");
      lines.push(pad("Used") + formatPercent(payload.session.usedPercent));
      lines.push(pad("Remaining") + formatPercent(payload.session.remainingPercent));
      lines.push(pad("Resets") + formatWindowReset(payload.session));
      lines.push("");

      lines.push("Weekly window");
      lines.push(pad("Used") + formatPercent(payload.weekly.usedPercent));
      lines.push(pad("Remaining") + formatPercent(payload.weekly.remainingPercent));
      lines.push(pad("Resets") + formatWindowReset(payload.weekly));
    }
  }

  if (fetchError) {
    lines.push("");
    lines.push(`Error: ${fetchError}`);
  }

  lines.push("");
  lines.push(`Last fetched: ${formatDate(payload.fetchedAt)} (${formatAge(payload.fetchedAt)})${staleSuffix}`);

  logUpdate(lines);
}

function logUpdate(lines: string[]): void {
  log(lines.join("\n") + "\n");
}

async function fetchUsage(): Promise<MonitorResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json()) as MonitorResponse;

    if (payload === null || typeof payload !== "object") {
      throw new Error(`Unexpected response from ${apiUrl}`);
    }

    if (!response.ok && (payload as MonitorErrorResponse).ok !== false) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

let latest: MonitorResponse | null = null;
let latestError: string | null = null;
let inFlight = false;

async function refresh(): Promise<void> {
  if (inFlight) {
    return;
  }

  inFlight = true;
  try {
    latest = await fetchUsage();
    latestError = latest.ok ? null : latest.error;
  } catch (error) {
    latestError = error instanceof Error ? error.message : String(error);
  } finally {
    render(latest, latestError);
    inFlight = false;
  }
}

process.on("SIGINT", () => {
  log.done();
  process.stdout.write("\nExiting\n");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.done();
  process.stdout.write("\nExiting\n");
  process.exit(0);
});

process.on("exit", () => {
  log.done();
});

await refresh();
setInterval(() => {
  void refresh();
}, intervalMs);
