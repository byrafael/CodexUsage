import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

const PUBLIC_DIR = join(import.meta.dir, "public");
const PORT = Number(Bun.env.PORT ?? 3000);
const COMMAND_TIMEOUT_MS = 10000;
const SNAPSHOT_REFRESH_MS = 1000;
const WEEKLY_WINDOW_DAYS = 7;
const APP_SERVER_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(Bun.env.APP_SERVER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 15000;
})();
const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_REFRESH_MS = 6 * 60 * 60 * 1000;
const LITELLM_FETCH_TIMEOUT_MS = 4000;
const DEFAULT_COST_MODEL = "gpt-5.3-codex";

type LiteLLMModelPricing = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
};

const DEFAULT_MODEL_PRICING: LiteLLMModelPricing = {
  input_cost_per_token: 1.75e-6,
  output_cost_per_token: 1.4e-5,
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

let cachedSnapshot: MonitorSuccessResponse | null = null;
let cachedAt = 0;
let inflightSnapshot: Promise<MonitorSuccessResponse> | null = null;
let snapshotRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastRefreshError: string | null = null;
let cachedLiteLLMPricing: Record<string, unknown> | null = null;
let cachedLiteLLMPricingAt = 0;
let inflightLiteLLMPricing: Promise<Record<string, unknown>> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function pickModelFromDailyEntry(
  entry: Record<string, unknown>
): string | null {
  const candidates: string[] = [];

  const modelBreakdowns = Array.isArray(entry.modelBreakdowns)
    ? entry.modelBreakdowns
    : [];
  for (const breakdown of modelBreakdowns) {
    if (!isRecord(breakdown)) {
      continue;
    }
    const modelName = toStringOrNull(breakdown.modelName);
    if (modelName) {
      candidates.push(modelName);
    }
  }

  const modelsUsed = Array.isArray(entry.modelsUsed) ? entry.modelsUsed : [];
  for (const model of modelsUsed) {
    if (typeof model === "string") {
      candidates.push(model);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.includes(DEFAULT_COST_MODEL)) {
    return DEFAULT_COST_MODEL;
  }

  return uniqueCandidates[0] ?? null;
}

function modelLookupCandidates(modelName: string): string[] {
  const values = new Set<string>();
  values.add(modelName);

  const parts = modelName.split("/");
  const bare = parts[parts.length - 1] ?? modelName;
  values.add(bare);

  values.add(`openai/${bare}`);
  values.add(`azure/${bare}`);
  values.add(`github_copilot/${bare}`);

  return [...values];
}

function lookupLiteLLMPricing(
  allPricing: Record<string, unknown>,
  modelName: string
): LiteLLMModelPricing | null {
  for (const candidate of modelLookupCandidates(modelName)) {
    const value = allPricing[candidate];
    if (!isRecord(value)) {
      continue;
    }

    const inputCost = toNumberOrNull(value.input_cost_per_token);
    const outputCost = toNumberOrNull(value.output_cost_per_token);
    if (inputCost !== null || outputCost !== null) {
      return {
        input_cost_per_token: inputCost ?? undefined,
        output_cost_per_token: outputCost ?? undefined,
      };
    }
  }

  return null;
}

function estimateCostUSD(
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: LiteLLMModelPricing
): number | null {
  const inputRate = pricing.input_cost_per_token;
  const outputRate = pricing.output_cost_per_token;

  let total = 0;
  let hasValue = false;

  if (typeof inputRate === "number" && inputTokens !== null) {
    total += inputTokens * inputRate;
    hasValue = true;
  }

  if (typeof outputRate === "number" && outputTokens !== null) {
    total += outputTokens * outputRate;
    hasValue = true;
  }

  return hasValue ? total : null;
}

function resetAtForDay(day: string): string | null {
  const parts = day.split("-");
  if (parts.length !== 3) {
    return null;
  }

  const year = Number.parseInt(parts[0], 10);
  const month = Number.parseInt(parts[1], 10);
  const date = Number.parseInt(parts[2], 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) {
    return null;
  }

  const nextDay = new Date(year, month - 1, date + 1, 0, 0, 0, 0);
  return Number.isFinite(nextDay.getTime()) ? nextDay.toISOString() : null;
}

async function fetchLiteLLMPricing(): Promise<Record<string, unknown>> {
  const response = await fetch(LITELLM_PRICING_URL, {
    signal: AbortSignal.timeout(LITELLM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`LiteLLM pricing fetch failed: HTTP ${response.status}`);
  }

  const parsed = (await response.json()) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("LiteLLM pricing payload is not a JSON object");
  }

  return parsed;
}

async function getLiteLLMPricing(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (
    cachedLiteLLMPricing &&
    now - cachedLiteLLMPricingAt < LITELLM_REFRESH_MS
  ) {
    return cachedLiteLLMPricing;
  }

  if (inflightLiteLLMPricing) {
    return inflightLiteLLMPricing;
  }

  inflightLiteLLMPricing = fetchLiteLLMPricing()
    .then((pricing) => {
      cachedLiteLLMPricing = pricing;
      cachedLiteLLMPricingAt = Date.now();
      return pricing;
    })
    .catch((error) => {
      if (cachedLiteLLMPricing) {
        return cachedLiteLLMPricing;
      }
      throw error;
    })
    .finally(() => {
      inflightLiteLLMPricing = null;
    });

  return inflightLiteLLMPricing;
}

async function normalizeCostPayload(payload: unknown): Promise<CostSummary> {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const rootObj = isRecord(root) ? root : {};
  const updatedAt = toStringOrNull(rootObj.updatedAt);
  const daily = Array.isArray(rootObj.daily) ? rootObj.daily : [];
  const liteLLMPricing = await getLiteLLMPricing().catch(() => ({}));
  const dailyRows: Array<{
    date: string;
    tokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUSD: number | null;
  }> = [];

  for (const entry of daily) {
    if (!isRecord(entry)) {
      continue;
    }

    const day = toStringOrNull(entry.date);
    if (!day) {
      continue;
    }

    const inputTokens = toNumberOrNull(entry.inputTokens);
    const outputTokens = toNumberOrNull(entry.outputTokens);
    const modelName = pickModelFromDailyEntry(entry) ?? DEFAULT_COST_MODEL;
    const modelPricing =
      lookupLiteLLMPricing(liteLLMPricing, modelName) ??
      lookupLiteLLMPricing(liteLLMPricing, DEFAULT_COST_MODEL) ??
      DEFAULT_MODEL_PRICING;

    dailyRows.push({
      date: day,
      tokens: toNumberOrNull(entry.totalTokens),
      inputTokens,
      outputTokens,
      estimatedCostUSD: estimateCostUSD(
        inputTokens,
        outputTokens,
        modelPricing
      ),
    });
  }

  dailyRows.sort((a, b) => a.date.localeCompare(b.date));
  const dailyMap = new Map(dailyRows.map((row) => [row.date, row]));

  const todayKey = dateKey(new Date());
  const todayRow = dailyMap.get(todayKey);
  const todayTokens =
    todayRow?.tokens ?? toNumberOrNull(rootObj.sessionTokens) ?? null;
  const sameTokenRow =
    todayTokens === null
      ? null
      : [...dailyRows]
          .reverse()
          .find((row) => row.tokens !== null && row.tokens === todayTokens) ??
        null;
  const todayCostUSD =
    todayRow?.estimatedCostUSD ?? sameTokenRow?.estimatedCostUSD ?? null;

  let weeklyTokens = 0;
  let weeklyCost = 0;
  let hasWeeklyTokens = false;
  let hasWeeklyCost = false;
  const today = new Date();
  let rangeStart: string | null = null;
  let rangeEnd: string | null = null;

  for (let i = 0; i < WEEKLY_WINDOW_DAYS; i += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const key = dateKey(day);

    if (i === 0) {
      rangeEnd = key;
    }
    if (i === WEEKLY_WINDOW_DAYS - 1) {
      rangeStart = key;
    }

    const row = dailyMap.get(key);
    if (row?.tokens !== null && row?.tokens !== undefined) {
      weeklyTokens += row.tokens;
      hasWeeklyTokens = true;
    }
    if (row?.estimatedCostUSD !== null && row?.estimatedCostUSD !== undefined) {
      weeklyCost += row.estimatedCostUSD;
      hasWeeklyCost = true;
    }
  }

  if (!hasWeeklyTokens && !hasWeeklyCost && dailyRows.length > 0) {
    const lastSeven = dailyRows.slice(-WEEKLY_WINDOW_DAYS);

    if (lastSeven.length > 0) {
      weeklyTokens = 0;
      weeklyCost = 0;
      hasWeeklyTokens = false;
      hasWeeklyCost = false;

      for (const row of lastSeven) {
        if (row.tokens !== null) {
          weeklyTokens += row.tokens;
          hasWeeklyTokens = true;
        }
        if (row.estimatedCostUSD !== null) {
          weeklyCost += row.estimatedCostUSD;
          hasWeeklyCost = true;
        }
      }

      rangeStart = lastSeven[0]?.date ?? null;
      rangeEnd = lastSeven[lastSeven.length - 1]?.date ?? null;
    }
  }

  const dayDate = todayKey;
  const dayRow = dailyMap.get(dayDate);
  const dayTokens = dayRow?.tokens ?? todayTokens;
  const dayCostUSD =
    dayRow?.estimatedCostUSD ??
    (dayTokens === todayTokens ? todayCostUSD : null);
  const dayResetsAt = resetAtForDay(dayDate);

  return {
    dayTokens,
    dayCostUSD,
    todayTokens,
    weeklyTokens: hasWeeklyTokens ? weeklyTokens : null,
    dayDate,
    dayResetsAt,
    todayCostUSD,
    weeklyCostUSD: hasWeeklyCost ? Number(weeklyCost.toFixed(6)) : null,
    weeklyWindowDays: WEEKLY_WINDOW_DAYS,
    rangeStart,
    rangeEnd,
    sourceFetchedAt: updatedAt,
  };
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = toNumberOrNull(value);
  if (seconds === null) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function normalizeRateLimitWindow(window: unknown): UsageWindow {
  const windowData = isRecord(window) ? window : {};
  const usedPercent = toNumberOrNull(windowData.usedPercent);
  const remainingPercent =
    usedPercent === null
      ? null
      : Math.max(0, Number((100 - usedPercent).toFixed(2)));
  const resetsAt = isoFromEpochSeconds(windowData.resetsAt);

  return {
    usedPercent,
    remainingPercent,
    windowMinutes: toNumberOrNull(windowData.windowDurationMins),
    resetsAt,
    resetDescription: resetsAt ? new Date(resetsAt).toLocaleString() : null,
    usedTokens: null,
    limitTokens: null,
    remainingTokens: null,
  };
}

function selectRateLimitBucket(
  rateLimitsPayload: Record<string, unknown>
): Record<string, unknown> {
  const byLimitId = isRecord(rateLimitsPayload.rateLimitsByLimitId)
    ? rateLimitsPayload.rateLimitsByLimitId
    : null;

  if (byLimitId) {
    const codexBucket = byLimitId.codex;
    if (isRecord(codexBucket)) {
      return codexBucket;
    }

    for (const value of Object.values(byLimitId)) {
      if (isRecord(value)) {
        return value;
      }
    }
  }

  return isRecord(rateLimitsPayload.rateLimits)
    ? rateLimitsPayload.rateLimits
    : {};
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function requestAppServerSnapshot(): Promise<{
  sourceFetchedAt: string | null;
  accountEmail: string | null;
  loginMethod: string | null;
  session: UsageWindow;
  weekly: UsageWindow;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let finished = false;
    let nextRequestId = 1;
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >();
    const stderrChunks: string[] = [];

    const failAllPending = (error: Error) => {
      for (const waiter of pending.values()) {
        waiter.reject(error);
      }
      pending.clear();
    };

    const finalize = (error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      lineReader.close();

      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
      if (!child.killed) {
        child.kill();
      }

      if (error) {
        failAllPending(error);
        reject(error);
      }
    };

    const timer = setTimeout(() => {
      const stderrText = stderrChunks.join("").trim();
      finalize(
        new Error(
          stderrText
            ? `codex app-server timed out: ${stderrText}`
            : `codex app-server timed out after ${APP_SERVER_TIMEOUT_MS}ms`
        )
      );
    }, APP_SERVER_TIMEOUT_MS);

    const lineReader = createInterface({ input: child.stdout });

    lineReader.on("line", (line: string) => {
      const message = parseJsonLine(line);
      if (!isRecord(message)) {
        return;
      }

      const id = toNumberOrNull(message.id);
      if (id === null) {
        return;
      }

      const waiter = pending.get(id);
      if (!waiter) {
        return;
      }
      pending.delete(id);

      if (isRecord(message.error)) {
        const errorMessage =
          toStringOrNull(message.error.message) ??
          `Request ${id} failed with app-server error`;
        waiter.reject(new Error(errorMessage));
        return;
      }

      waiter.resolve(message.result);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(String(chunk));
    });

    child.on("error", (error: Error) => {
      finalize(error);
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) {
        return;
      }

      const stderrText = stderrChunks.join("").trim();
      const why =
        code === 0
          ? "closed unexpectedly"
          : `exited with code ${code}${signal ? ` (${signal})` : ""}`;
      finalize(
        new Error(
          stderrText
            ? `codex app-server ${why}: ${stderrText}`
            : `codex app-server ${why}`
        )
      );
    });

    const sendRequest = async (
      method: string,
      params: unknown
    ): Promise<unknown> => {
      const id = nextRequestId;
      nextRequestId += 1;

      const payload = JSON.stringify({ id, method, params }) + "\n";

      const responsePromise = new Promise<unknown>(
        (resolveResponse, rejectResponse) => {
          pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
        }
      );

      const writeOk = child.stdin.write(payload);
      if (!writeOk) {
        await new Promise<void>((resolveDrain) =>
          child.stdin.once("drain", resolveDrain)
        );
      }

      return responsePromise;
    };

    const run = async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: { name: "codexusage-monitor", version: "0.1.0" },
        });

        const rateLimitsRaw = await sendRequest(
          "account/rateLimits/read",
          null
        );
        const accountRaw = await sendRequest("account/read", {
          refreshToken: false,
        });

        const rateLimitsResult = isRecord(rateLimitsRaw) ? rateLimitsRaw : {};
        const accountResult = isRecord(accountRaw) ? accountRaw : {};
        const bucket = selectRateLimitBucket(rateLimitsResult);
        const account = isRecord(accountResult.account)
          ? accountResult.account
          : {};

        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        lineReader.close();
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
        if (!child.killed) {
          child.kill();
        }

        resolve({
          sourceFetchedAt: new Date().toISOString(),
          accountEmail: toStringOrNull(account.email),
          loginMethod: toStringOrNull(account.type),
          session: normalizeRateLimitWindow(bucket.primary),
          weekly: normalizeRateLimitWindow(bucket.secondary),
        });
      } catch (error) {
        finalize(error instanceof Error ? error : new Error(String(error)));
      }
    };

    run();
  });
}

async function runCodexbarJson(
  commandArgs: string[],
  label: string
): Promise<unknown> {
  const proc = Bun.spawn(["codexbar", ...commandArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, COMMAND_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      throw new Error(`${label} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }

    if (exitCode !== 0) {
      const message = stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;
      throw new Error(`${label} failed: ${message}`);
    }

    if (!stdout.trim()) {
      throw new Error(`${label} returned empty output`);
    }

    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runMonitorCommands(): Promise<MonitorSuccessResponse> {
  const [usage, costRaw] = await Promise.all([
    requestAppServerSnapshot(),
    runCodexbarJson(
      ["cost", "--provider", "codex", "--format", "json", "--refresh"],
      "codexbar cost"
    ),
  ]);

  const cost = await normalizeCostPayload(costRaw);

  return {
    ok: true,
    stale: false,
    fetchedAt: new Date().toISOString(),
    sourceFetchedAt: usage.sourceFetchedAt,
    accountEmail: usage.accountEmail,
    loginMethod: usage.loginMethod,
    session: usage.session,
    weekly: usage.weekly,
    cost,
  };
}

async function refreshSnapshotOnce(): Promise<MonitorSuccessResponse> {
  if (inflightSnapshot) {
    return inflightSnapshot;
  }

  inflightSnapshot = runMonitorCommands()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cachedAt = Date.now();
      lastRefreshError = null;
      return snapshot;
    })
    .catch((error) => {
      lastRefreshError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      inflightSnapshot = null;
    });

  return inflightSnapshot;
}

function ensureSnapshotRefreshLoop(): void {
  if (snapshotRefreshTimer) {
    return;
  }

  void refreshSnapshotOnce().catch(() => {});
  snapshotRefreshTimer = setInterval(() => {
    void refreshSnapshotOnce().catch(() => {});
  }, SNAPSHOT_REFRESH_MS);
}

async function getLatestSnapshot(): Promise<MonitorSuccessResponse> {
  ensureSnapshotRefreshLoop();

  if (!cachedSnapshot) {
    return refreshSnapshotOnce();
  }

  const now = Date.now();
  if (now - cachedAt >= SNAPSHOT_REFRESH_MS && !inflightSnapshot) {
    void refreshSnapshotOnce();
  }

  if (lastRefreshError) {
    throw new Error(lastRefreshError);
  }

  return cachedSnapshot;
}

function jsonResponse(status: number, body: MonitorResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function resolvePublicPath(pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(
      pathname === "/" ? "/index.html" : pathname
    );
  } catch {
    return null;
  }

  const normalizedPath = normalize(decodedPath)
    .replace(/^[/\\]+/, "")
    .replace(/^([.][.][/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  if (!existsSync(filePath)) {
    return null;
  }

  return filePath;
}

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (
      url.pathname === "/session" ||
      url.pathname === "/session/" ||
      url.pathname === "/week" ||
      url.pathname === "/week/" ||
      url.pathname === "/day" ||
      url.pathname === "/day/"
    ) {
      return new Response(Bun.file(join(PUBLIC_DIR, "focus.html")), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/api/usage") {
      try {
        const snapshot = await getLatestSnapshot();
        return jsonResponse(200, snapshot);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        if (cachedSnapshot) {
          return jsonResponse(200, {
            ...cachedSnapshot,
            stale: true,
            fetchedAt: new Date().toISOString(),
            error: message,
          });
        }

        return jsonResponse(500, {
          ok: false,
          stale: false,
          fetchedAt: new Date().toISOString(),
          error: message,
        });
      }
    }

    const filePath = resolvePublicPath(url.pathname);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new Response(Bun.file(filePath), {
      headers: {
        "cache-control": "no-store",
        "content-type": contentType,
      },
    });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
