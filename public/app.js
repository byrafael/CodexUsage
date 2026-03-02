const POLL_INTERVAL_MS = 1000;
const COUNTER_ANIMATION_MS = 520;

const elements = {
  statusText: document.querySelector("#status-text"),
  updatedText: document.querySelector("#updated-text"),
  accountText: document.querySelector("#account-text"),
  errorBox: document.querySelector("#error-box"),

  counterTodayTokens: document.querySelector("#counter-today-tokens"),
  counterWeeklyTokens: document.querySelector("#counter-weekly-tokens"),
  counterDailyUsed: document.querySelector("#counter-daily-used"),
  counterWeeklyUsed: document.querySelector("#counter-weekly-used"),

  sessionWindow: document.querySelector("#session-window"),
  sessionMeter: document.querySelector("#session-meter"),
  sessionUsed: document.querySelector("#session-used"),
  sessionRemaining: document.querySelector("#session-remaining"),
  sessionTokens: document.querySelector("#session-tokens"),
  sessionReset: document.querySelector("#session-reset"),

  weeklyWindow: document.querySelector("#weekly-window"),
  weeklyMeter: document.querySelector("#weekly-meter"),
  weeklyUsed: document.querySelector("#weekly-used"),
  weeklyRemaining: document.querySelector("#weekly-remaining"),
  weeklyTokens: document.querySelector("#weekly-tokens"),
  weeklyReset: document.querySelector("#weekly-reset")
};

const counterValues = new Map();
const counterFrames = new Map();

let inFlight = false;
let lastPayload = null;

function asPercent(value, digits = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return `${value.toFixed(digits)}%`;
}

function asLocalTime(value) {
  if (!value) {
    return "N/A";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function asCountdown(value) {
  if (!value) {
    return "N/A";
  }

  const target = new Date(value).getTime();
  if (Number.isNaN(target)) {
    return value;
  }

  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return "Reset due";
  }

  const totalSeconds = Math.floor(diffMs / 1000);
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

function formatTokenCount(value) {
  return Math.max(0, Math.round(value)).toLocaleString();
}

function formatCounterPercent(value) {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function animateCounter(element, key, nextValue, formatter) {
  if (!element) {
    return;
  }

  if (typeof nextValue !== "number" || Number.isNaN(nextValue)) {
    const existingFrame = counterFrames.get(key);
    if (existingFrame) {
      cancelAnimationFrame(existingFrame);
      counterFrames.delete(key);
    }
    counterValues.delete(key);
    element.textContent = "N/A";
    return;
  }

  const previousValue = counterValues.get(key);
  if (typeof previousValue !== "number") {
    counterValues.set(key, nextValue);
    element.textContent = formatter(nextValue);
    return;
  }

  const existingFrame = counterFrames.get(key);
  if (existingFrame) {
    cancelAnimationFrame(existingFrame);
  }

  const startedAt = performance.now();
  const delta = nextValue - previousValue;

  const step = (timestamp) => {
    const elapsed = timestamp - startedAt;
    const progress = Math.min(1, elapsed / COUNTER_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = previousValue + delta * eased;

    element.textContent = formatter(current);

    if (progress < 1) {
      const frameId = requestAnimationFrame(step);
      counterFrames.set(key, frameId);
      return;
    }

    counterValues.set(key, nextValue);
    counterFrames.delete(key);
    element.textContent = formatter(nextValue);
  };

  const frameId = requestAnimationFrame(step);
  counterFrames.set(key, frameId);
}

function renderWindow(windowData, prefix) {
  const meter = elements[`${prefix}Meter`];
  const windowText = elements[`${prefix}Window`];
  const usedText = elements[`${prefix}Used`];
  const remainingText = elements[`${prefix}Remaining`];
  const tokensText = elements[`${prefix}Tokens`];
  const resetText = elements[`${prefix}Reset`];

  const usedPercent = typeof windowData?.usedPercent === "number" ? windowData.usedPercent : null;
  const remainingPercent =
    typeof windowData?.remainingPercent === "number" ? windowData.remainingPercent : null;
  const windowMinutes =
    typeof windowData?.windowMinutes === "number" ? windowData.windowMinutes : null;

  meter.style.width = `${Math.max(0, Math.min(100, usedPercent ?? 0))}%`;
  usedText.textContent = asPercent(usedPercent);
  remainingText.textContent = asPercent(remainingPercent);

  const usedTokens = windowData?.usedTokens;
  const limitTokens = windowData?.limitTokens;
  const remainingTokens = windowData?.remainingTokens;

  if (
    typeof usedTokens === "number" &&
    typeof limitTokens === "number" &&
    typeof remainingTokens === "number"
  ) {
    tokensText.textContent = `${usedTokens.toLocaleString()} / ${limitTokens.toLocaleString()} (${remainingTokens.toLocaleString()} left)`;
  } else {
    tokensText.textContent = "N/A";
  }

  if (windowMinutes === null) {
    windowText.textContent = "Window length: N/A";
  } else if (windowMinutes >= 60) {
    windowText.textContent = `Window length: ${(windowMinutes / 60).toFixed(1)}h`;
  } else {
    windowText.textContent = `Window length: ${windowMinutes}m`;
  }

  const countdown = asCountdown(windowData?.resetsAt);
  const localReset = windowData?.resetsAt
    ? asLocalTime(windowData.resetsAt)
    : windowData?.resetDescription || "N/A";
  resetText.textContent = `${countdown} (${localReset})`;
}

function renderTopCounters(payload) {
  animateCounter(
    elements.counterTodayTokens,
    "todayTokens",
    payload?.cost?.todayTokens,
    formatTokenCount
  );
  animateCounter(
    elements.counterWeeklyTokens,
    "weeklyTokens",
    payload?.cost?.weeklyTokens,
    formatTokenCount
  );
  animateCounter(
    elements.counterDailyUsed,
    "dailyUsed",
    payload?.session?.usedPercent,
    formatCounterPercent
  );
  animateCounter(
    elements.counterWeeklyUsed,
    "weeklyUsed",
    payload?.weekly?.usedPercent,
    formatCounterPercent
  );
}

function render(payload) {
  lastPayload = payload;

  if (!payload.ok) {
    elements.statusText.textContent = "Error";
    elements.updatedText.textContent = asLocalTime(payload.fetchedAt);
    elements.accountText.textContent = "Unavailable";
    elements.errorBox.classList.remove("hidden");
    elements.errorBox.textContent = payload.error;
    return;
  }

  elements.statusText.textContent = payload.stale ? "Live (stale fallback)" : "Live";
  elements.updatedText.textContent = asLocalTime(payload.fetchedAt);
  elements.accountText.textContent = payload.accountEmail
    ? `${payload.accountEmail} (${payload.loginMethod ?? "unknown"})`
    : "Unknown";

  renderTopCounters(payload);
  renderWindow(payload.session, "session");
  renderWindow(payload.weekly, "weekly");

  if (payload.error) {
    elements.errorBox.classList.remove("hidden");
    elements.errorBox.textContent = payload.error;
  } else {
    elements.errorBox.classList.add("hidden");
    elements.errorBox.textContent = "";
  }
}

async function pollUsage() {
  if (inFlight) {
    return;
  }

  inFlight = true;
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    const payload = await response.json();
    render(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackPayload = {
      ok: false,
      stale: Boolean(lastPayload?.ok),
      fetchedAt: new Date().toISOString(),
      error: `Request failed: ${message}`
    };
    render(fallbackPayload);
  } finally {
    inFlight = false;
  }
}

pollUsage();
setInterval(pollUsage, POLL_INTERVAL_MS);
