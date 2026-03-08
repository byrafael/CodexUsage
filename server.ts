import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
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
  modelLabel: string | null;
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
const SNAPSHOT_REFRESH_MS = 1000;
const WEEKLY_WINDOW_DAYS = 7;
const TOKEN_USAGE_WINDOW_DAYS = 30;
const TOKEN_USAGE_REFRESH_MS = (() => {
  const configured = Number.parseInt(Bun.env.TOKEN_USAGE_REFRESH_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 250) {
    return configured;
  }
  return 1000;
})();
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
const CODEX_RATE_LIMIT_FETCH_ERROR = "failed to fetch codex rate limits";

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
let cachedTokenUsage: TokenUsageSnapshot | null = null;
let cachedTokenUsageAt = 0;
let inflightTokenUsage: Promise<TokenUsageSnapshot> | null = null;

type TokenUsageModelTotals = {
  inputTokens: number;
  outputTokens: number;
};

type TokenUsageDailyRow = {
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  modelTotals: Record<string, TokenUsageModelTotals>;
};

type TokenUsageSnapshot = {
  sourceFetchedAt: string | null;
  daily: TokenUsageDailyRow[];
  latestModel: string | null;
};

type AppServerSoftFailure = {
  matchText: string;
  result: unknown;
};

type AppServerPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  softFailure: AppServerSoftFailure | null;
};

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

function dayKeyInRange(day: string, since: string, until: string): boolean {
  return day >= since && day <= until;
}

function dateFromDayKey(day: string): Date | null {
  const [yearText, monthText, dayText] = day.split("-");
  const year = Number.parseInt(yearText ?? "", 10);
  const month = Number.parseInt(monthText ?? "", 10);
  const date = Number.parseInt(dayText ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) {
    return null;
  }

  const value = new Date(year, month - 1, date, 12, 0, 0, 0);
  return Number.isFinite(value.getTime()) ? value : null;
}

function dayKeyFromFilename(fileName: string): string | null {
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function codexRoot(): string {
  const configured = Bun.env.CODEX_HOME?.trim();
  if (configured) {
    return configured;
  }

  const home = Bun.env.HOME ?? process.env.HOME ?? "";
  return join(home, ".codex");
}

function buildDayKeysInclusive(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    keys.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function codexSessionsRoot(): string {
  return join(codexRoot(), "sessions");
}

function codexArchivedSessionsRoot(sessionsRoot: string): string {
  return join(sessionsRoot, "..", "archived_sessions");
}

function listSessionFilesByDatePartition(
  root: string,
  scanSinceKey: string,
  scanUntilKey: string
): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const start = dateFromDayKey(scanSinceKey);
  const end = dateFromDayKey(scanUntilKey);
  if (!start || !end) {
    return [];
  }

  const files: string[] = [];
  for (const key of buildDayKeysInclusive(start, end)) {
    const [year, month, day] = key.split("-");
    const dayDir = join(root, year ?? "", month ?? "", day ?? "");
    if (!existsSync(dayDir)) {
      continue;
    }

    for (const name of readdirSync(dayDir)) {
      if (!name.toLowerCase().endsWith(".jsonl")) {
        continue;
      }
      files.push(join(dayDir, name));
    }
  }

  return files;
}

function listSessionFilesFlat(
  root: string,
  scanSinceKey: string,
  scanUntilKey: string
): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.toLowerCase().endsWith(".jsonl")) {
      continue;
    }

    const dayFromName = dayKeyFromFilename(name);
    if (dayFromName && !dayKeyInRange(dayFromName, scanSinceKey, scanUntilKey)) {
      continue;
    }

    files.push(join(root, name));
  }

  return files;
}

function listCodexSessionFiles(scanSinceKey: string, scanUntilKey: string): string[] {
  const sessionsRoot = codexSessionsRoot();
  const archivedRoot = codexArchivedSessionsRoot(sessionsRoot);
  const combined = [
    ...listSessionFilesByDatePartition(sessionsRoot, scanSinceKey, scanUntilKey),
    ...listSessionFilesFlat(sessionsRoot, scanSinceKey, scanUntilKey),
    ...listSessionFilesByDatePartition(archivedRoot, scanSinceKey, scanUntilKey),
    ...listSessionFilesFlat(archivedRoot, scanSinceKey, scanUntilKey),
  ];

  return [...new Set(combined)];
}

function toIntOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 0;
}

function toDayKeyFromTimestamp(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  return dateKey(parsed);
}

function usageTotalsFromRecord(value: unknown): {
  input: number;
  cached: number;
  output: number;
} {
  const obj = isRecord(value) ? value : {};
  return {
    input: toIntOrZero(obj.input_tokens ?? obj.inputTokens),
    cached: toIntOrZero(
      obj.cached_input_tokens ??
        obj.cachedInputTokens ??
        obj.cache_read_input_tokens ??
        obj.cacheReadInputTokens
    ),
    output: toIntOrZero(obj.output_tokens ?? obj.outputTokens),
  };
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

async function scanTokenUsageFile(
  filePath: string,
  scanSinceKey: string,
  scanUntilKey: string,
  dailyMap: Map<string, TokenUsageDailyRow>,
  latestModelState: { model: string | null; timestampMs: number }
): Promise<void> {
  let currentModel: string | null = null;
  let previousTotals: { input: number; cached: number; output: number } | null =
    null;

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"')) {
      continue;
    }

    const parsed = parseJsonLine(line);
    if (!isRecord(parsed)) {
      continue;
    }

    const type = toStringOrNull(parsed.type);
    if (type === "turn_context") {
      const payload = isRecord(parsed.payload) ? parsed.payload : {};
      const info = isRecord(payload.info) ? payload.info : {};
      const timestampText = toStringOrNull(parsed.timestamp);
      currentModel =
        toStringOrNull(payload.model) ?? toStringOrNull(info.model) ?? currentModel;
      maybeUpdateLatestModel(latestModelState, currentModel, timestampText);
      continue;
    }

    if (type !== "event_msg") {
      continue;
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    if (toStringOrNull(payload.type) !== "token_count") {
      continue;
    }

    const timestampText = toStringOrNull(parsed.timestamp);
    if (!timestampText) {
      continue;
    }

    const day = toDayKeyFromTimestamp(timestampText);
    if (!day || !dayKeyInRange(day, scanSinceKey, scanUntilKey)) {
      continue;
    }

    const info = isRecord(payload.info) ? payload.info : {};
    const totalUsage = info.total_token_usage ?? info.totalTokenUsage;
    const lastUsage = info.last_token_usage ?? info.lastTokenUsage;
    const hasTotalUsage = isRecord(totalUsage);
    const hasLastUsage = isRecord(lastUsage);

    let deltaInput = 0;
    let deltaCached = 0;
    let deltaOutput = 0;

    if (hasTotalUsage) {
      const totals = usageTotalsFromRecord(totalUsage);
      deltaInput = Math.max(0, totals.input - (previousTotals?.input ?? 0));
      deltaCached = Math.max(0, totals.cached - (previousTotals?.cached ?? 0));
      deltaOutput = Math.max(0, totals.output - (previousTotals?.output ?? 0));
      previousTotals = totals;
    } else if (hasLastUsage) {
      const last = usageTotalsFromRecord(lastUsage);
      deltaInput = last.input;
      deltaCached = last.cached;
      deltaOutput = last.output;
    } else {
      continue;
    }

    if (deltaInput === 0 && deltaCached === 0 && deltaOutput === 0) {
      continue;
    }

    const model =
      toStringOrNull(info.model) ??
      toStringOrNull(info.model_name) ??
      toStringOrNull(payload.model) ??
      toStringOrNull(parsed.model) ??
      currentModel ??
      DEFAULT_COST_MODEL;
    maybeUpdateLatestModel(latestModelState, model, timestampText);
    const dayTotalTokens = deltaInput + deltaOutput;

    const dayRow =
      dailyMap.get(day) ??
      ({
        date: day,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        modelTotals: {},
      } satisfies TokenUsageDailyRow);

    dayRow.tokens += dayTotalTokens;
    dayRow.inputTokens += deltaInput;
    dayRow.outputTokens += deltaOutput;

    const modelTotals = dayRow.modelTotals[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    modelTotals.inputTokens += deltaInput;
    modelTotals.outputTokens += deltaOutput;

    dayRow.modelTotals[model] = modelTotals;
    dailyMap.set(day, dayRow);
  }

  reader.close();
}

async function fetchTokenUsageSnapshot(): Promise<TokenUsageSnapshot> {
  const now = new Date();
  const since = new Date(now);
  since.setDate(now.getDate() - (TOKEN_USAGE_WINDOW_DAYS - 1));

  const scanSince = new Date(since);
  scanSince.setDate(scanSince.getDate() - 1);
  const scanUntil = new Date(now);
  scanUntil.setDate(scanUntil.getDate() + 1);

  const sinceKey = dateKey(since);
  const untilKey = dateKey(now);
  const scanSinceKey = dateKey(scanSince);
  const scanUntilKey = dateKey(scanUntil);

  const files = listCodexSessionFiles(scanSinceKey, scanUntilKey);
  const dailyMap = new Map<string, TokenUsageDailyRow>();
  const latestModelState = {
    model: null as string | null,
    timestampMs: Number.NEGATIVE_INFINITY,
  };

  for (const filePath of files) {
    try {
      await scanTokenUsageFile(
        filePath,
        scanSinceKey,
        scanUntilKey,
        dailyMap,
        latestModelState
      );
    } catch {
      continue;
    }
  }

  const daily = [...dailyMap.values()]
    .filter((row) => dayKeyInRange(row.date, sinceKey, untilKey))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    sourceFetchedAt: new Date().toISOString(),
    daily,
    latestModel: latestModelState.model,
  };
}

async function getTokenUsageSnapshot(): Promise<TokenUsageSnapshot> {
  const now = Date.now();
  if (cachedTokenUsage && now - cachedTokenUsageAt < TOKEN_USAGE_REFRESH_MS) {
    return cachedTokenUsage;
  }

  if (inflightTokenUsage) {
    return inflightTokenUsage;
  }

  inflightTokenUsage = fetchTokenUsageSnapshot()
    .then((snapshot) => {
      cachedTokenUsage = snapshot;
      cachedTokenUsageAt = Date.now();
      return snapshot;
    })
    .catch((error) => {
      if (cachedTokenUsage) {
        return cachedTokenUsage;
      }
      throw error;
    })
    .finally(() => {
      inflightTokenUsage = null;
    });

  return inflightTokenUsage;
}

async function normalizeCostPayload(
  payload: TokenUsageSnapshot
): Promise<CostSummary> {
  const liteLLMPricing = await getLiteLLMPricing().catch(() => ({}));
  const dailyRows: Array<{
    date: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUSD: number | null;
  }> = [];

  for (const entry of payload.daily) {
    let estimatedCost = 0;
    let hasEstimatedCost = false;

    for (const [modelName, totals] of Object.entries(entry.modelTotals)) {
      const modelPricing =
        lookupLiteLLMPricing(liteLLMPricing, modelName) ??
        lookupLiteLLMPricing(liteLLMPricing, DEFAULT_COST_MODEL) ??
        DEFAULT_MODEL_PRICING;

      const modelCost = estimateCostUSD(
        totals.inputTokens,
        totals.outputTokens,
        modelPricing
      );
      if (modelCost !== null) {
        estimatedCost += modelCost;
        hasEstimatedCost = true;
      }
    }

    if (!hasEstimatedCost) {
      const fallbackCost = estimateCostUSD(
        entry.inputTokens,
        entry.outputTokens,
        lookupLiteLLMPricing(liteLLMPricing, DEFAULT_COST_MODEL) ??
          DEFAULT_MODEL_PRICING
      );
      if (fallbackCost !== null) {
        estimatedCost = fallbackCost;
        hasEstimatedCost = true;
      }
    }

    dailyRows.push({
      date: entry.date,
      tokens: entry.tokens,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      estimatedCostUSD: hasEstimatedCost ? estimatedCost : null,
    });
  }

  dailyRows.sort((a, b) => a.date.localeCompare(b.date));
  const dailyMap = new Map(dailyRows.map((row) => [row.date, row]));

  const todayKey = dateKey(new Date());
  const todayRow = dailyMap.get(todayKey);
  const latestRow = dailyRows[dailyRows.length - 1] ?? null;
  const todayTokens = todayRow?.tokens ?? latestRow?.tokens ?? null;
  const todayCostUSD =
    todayRow?.estimatedCostUSD ?? latestRow?.estimatedCostUSD ?? null;

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
    if (row) {
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
        weeklyTokens += row.tokens;
        hasWeeklyTokens = true;
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
    sourceFetchedAt: payload.sourceFetchedAt,
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

function configuredCodexModel(): string | null {
  const configPath = join(codexRoot(), "config.toml");
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const configText = readFileSync(configPath, "utf8");
    const match = configText.match(/(?:^|\n)model\s*=\s*"([^"\n]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function displayModelLabel(modelName: string | null): string | null {
  if (!modelName) {
    return null;
  }

  const bare = modelName.split("/").pop() ?? modelName;
  return bare
    .replace(/^gpt/i, "GPT")
    .replace(/-codex/gi, " Codex")
    .replace(/-mini/gi, " Mini")
    .replace(/-spark/gi, " Spark");
}

function maybeUpdateLatestModel(
  latestModelState: { model: string | null; timestampMs: number },
  modelName: string | null,
  timestampText: string | null
): void {
  if (!modelName || !timestampText) {
    return;
  }

  const timestampMs = new Date(timestampText).getTime();
  if (!Number.isFinite(timestampMs) || timestampMs < latestModelState.timestampMs) {
    return;
  }

  latestModelState.model = modelName;
  latestModelState.timestampMs = timestampMs;
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
    const pending = new Map<number, AppServerPendingRequest>();
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
        if (
          waiter.softFailure &&
          errorMessage.includes(waiter.softFailure.matchText)
        ) {
          waiter.resolve(waiter.softFailure.result);
          return;
        }
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
      params: unknown,
      options: { softFailure?: AppServerSoftFailure } = {}
    ): Promise<unknown> => {
      const id = nextRequestId;
      nextRequestId += 1;

      const payload = JSON.stringify({ id, method, params }) + "\n";

      const responsePromise = new Promise<unknown>(
        (resolveResponse, rejectResponse) => {
          pending.set(id, {
            resolve: resolveResponse,
            reject: rejectResponse,
            softFailure: options.softFailure ?? null,
          });
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
          null,
          {
            softFailure: {
              matchText: CODEX_RATE_LIMIT_FETCH_ERROR,
              result: {},
            },
          }
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

async function runMonitorCommands(): Promise<MonitorSuccessResponse> {
  const [usage, tokenUsage] = await Promise.all([
    requestAppServerSnapshot(),
    getTokenUsageSnapshot(),
  ]);

  const cost = await normalizeCostPayload(tokenUsage);
  const modelLabel = displayModelLabel(
    tokenUsage.latestModel ?? configuredCodexModel()
  );

  return {
    ok: true,
    stale: false,
    fetchedAt: new Date().toISOString(),
    sourceFetchedAt: usage.sourceFetchedAt,
    modelLabel,
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

    if (
      url.pathname === "/session/rec" ||
      url.pathname === "/session/rec/" ||
      url.pathname === "/week/rec" ||
      url.pathname === "/week/rec/" ||
      url.pathname === "/day/rec" ||
      url.pathname === "/day/rec/"
    ) {
      return new Response(Bun.file(join(PUBLIC_DIR, "rec.html")), {
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
