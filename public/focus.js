const POLL_INTERVAL_MS = 1000;
const ANIMATION_MS = 560;

const isDay = window.location.pathname.startsWith("/day");
const isWeekly = window.location.pathname.startsWith("/week");

const elements = {
  tokenValue: document.querySelector("#token-value"),
  costValue: document.querySelector("#cost-value"),
  resetValue: document.querySelector("#reset-value"),
  usageValue: document.querySelector("#usage-value"),
  statusValue: document.querySelector("#status-value")
};

const liveNumbers = new Map();
const frames = new Map();

let inFlight = false;
let lastFetchedAtMs = null;

function formatTokens(value) {
  return Math.max(0, Math.round(value)).toLocaleString();
}

function formatCost(value) {
  return `$${Math.max(0, value).toFixed(2)}`;
}

function formatUsedPercent(value) {
  return `${Math.max(0, value).toFixed(1)}% used`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "--";
  }
  if (ms <= 0) {
    return "reset due";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatUpdatedAgo(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    return "updated --";
  }

  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) {
    return "";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 2) {
    return "";
  }

  const units = [
    { label: "year", seconds: 365 * 24 * 60 * 60 },
    { label: "month", seconds: 30 * 24 * 60 * 60 },
    { label: "week", seconds: 7 * 24 * 60 * 60 },
    { label: "day", seconds: 24 * 60 * 60 },
    { label: "hour", seconds: 60 * 60 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 }
  ];

  for (const unit of units) {
    if (seconds >= unit.seconds) {
      const value = Math.floor(seconds / unit.seconds);
      const suffix = value === 1 ? "" : "s";
      return `updated ${value} ${unit.label}${suffix} ago`;
    }
  }

  return "";
}

function updatedStatusFromLastFetch() {
  if (!Number.isFinite(lastFetchedAtMs)) {
    return "updated --";
  }

  return formatUpdatedAgo(lastFetchedAtMs);
}

function animateValue(key, nextValue, formatter, element, fallbackText = "N/A") {
  if (!element) {
    return;
  }

  if (typeof nextValue !== "number" || Number.isNaN(nextValue)) {
    const pending = frames.get(key);
    if (pending) {
      cancelAnimationFrame(pending);
      frames.delete(key);
    }
    liveNumbers.delete(key);
    element.textContent = fallbackText;
    return;
  }

  const currentValue = liveNumbers.get(key);
  if (typeof currentValue !== "number") {
    liveNumbers.set(key, nextValue);
    element.textContent = formatter(nextValue);
    return;
  }

  const pending = frames.get(key);
  if (pending) {
    cancelAnimationFrame(pending);
  }

  const start = performance.now();
  const delta = nextValue - currentValue;

  const tick = (now) => {
    const progress = Math.min(1, (now - start) / ANIMATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    const rendered = currentValue + delta * eased;
    element.textContent = formatter(rendered);

    if (progress < 1) {
      const frame = requestAnimationFrame(tick);
      frames.set(key, frame);
      return;
    }

    liveNumbers.set(key, nextValue);
    frames.delete(key);
    element.textContent = formatter(nextValue);
  };

  const frame = requestAnimationFrame(tick);
  frames.set(key, frame);
}

function renderReset(payload) {
  const target = isWeekly
    ? payload?.weekly?.resetsAt
    : isDay
      ? payload?.cost?.dayResetsAt
      : payload?.session?.resetsAt;
  if (!target) {
    elements.resetValue.textContent = "Reset in: --";
    return;
  }

  const resetAt = new Date(target).getTime();
  if (!Number.isFinite(resetAt)) {
    elements.resetValue.textContent = `Reset in: ${target}`;
    return;
  }

  elements.resetValue.textContent = `Reset in: ${formatDuration(resetAt - Date.now())}`;
}

function render(payload) {
  if (!payload?.ok) {
    elements.statusValue.textContent = updatedStatusFromLastFetch();
    return;
  }

  const tokenValue = isWeekly
    ? payload?.cost?.weeklyTokens
    : isDay
      ? (payload?.cost?.dayTokens ?? payload?.cost?.todayTokens)
      : payload?.cost?.todayTokens;
  const costValue = isWeekly
    ? payload?.cost?.weeklyCostUSD
    : isDay
      ? (payload?.cost?.dayCostUSD ?? payload?.cost?.todayCostUSD)
      : payload?.cost?.todayCostUSD;
  const usedPercent = isWeekly
    ? payload?.weekly?.usedPercent
    : isDay
      ? null
      : payload?.session?.usedPercent;

  animateValue("tokens", tokenValue, formatTokens, elements.tokenValue);
  animateValue("cost", costValue, formatCost, elements.costValue);
  animateValue(
    "usedPercent",
    usedPercent,
    formatUsedPercent,
    elements.usageValue,
    "--% used"
  );
  renderReset(payload);

  const fetchedAtMs = new Date(payload.fetchedAt).getTime();
  if (Number.isFinite(fetchedAtMs)) {
    lastFetchedAtMs = fetchedAtMs;
  }

  const updatedText = formatUpdatedAgo(lastFetchedAtMs ?? NaN);
  if (payload.stale) {
    elements.statusValue.textContent = updatedStatusFromLastFetch();
    return;
  }

  elements.statusValue.textContent = updatedText;
}

async function poll() {
  if (inFlight) {
    return;
  }

  inFlight = true;
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    const payload = await response.json();
    render(payload);
  } catch {
    elements.statusValue.textContent = updatedStatusFromLastFetch();
  } finally {
    inFlight = false;
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
