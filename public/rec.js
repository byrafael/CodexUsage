const POLL_INTERVAL_MS = 1000;
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 720;
const STREAM_FPS = 24;

const mode = window.location.pathname.startsWith("/week")
  ? "week"
  : window.location.pathname.startsWith("/day")
    ? "day"
    : "session";

const elements = {
  heading: document.querySelector("#rec-heading"),
  description: document.querySelector("#rec-description"),
  toggle: document.querySelector("#pip-toggle"),
  support: document.querySelector("#pip-support"),
  video: document.querySelector("#rec-video"),
  canvas: document.querySelector("#rec-canvas")
};

const canvasContext = elements.canvas?.getContext("2d");
const animatedNumbers = new Map();

const state = {
  inFlight: false,
  payload: null,
  lastFetchedAtMs: null,
  pipActive: false
};

function formatTokens(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return Math.max(0, Math.round(value)).toLocaleString();
}

function formatCost(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "$--";
  }

  return `$${Math.max(0, value).toFixed(2)}`;
}

function formatUsedPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--% used";
  }

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

  if (diffMs <= 5000) {
    return "updated just now";
  }

  const seconds = Math.floor(diffMs / 1000);
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

  return "updated just now";
}

function formatTitle(payload) {
  const modelLabel = payload?.modelLabel;
  if (typeof modelLabel !== "string" || modelLabel.length === 0) {
    return "Codex Model";
  }

  return modelLabel;
}

function getModeConfig() {
  if (mode === "week") {
    return {
      heading: "Weekly recorder",
      description:
        "A looping canvas stream of the weekly render. Use the button to pop it into Picture in Picture.",
      badge: "Weekly window",
      tokenLabel: "",
      costLabel: "",
      accent: "#5fb7ff",
      accentSoft: "#13334f"
    };
  }

  if (mode === "day") {
    return {
      heading: "Daily recorder",
      description:
        "A looping canvas stream of the daily render. Open Picture in Picture and leave this tab running.",
      badge: "Daily total",
      tokenLabel: "Daily tokens",
      costLabel: "Daily cost",
      accent: "#77e08e",
      accentSoft: "#102f21"
    };
  }

  return {
    heading: "Session recorder",
    description:
      "A looping canvas stream of the session render. Open Picture in Picture and keep it visible while you work.",
    badge: "Session window",
    tokenLabel: "Session tokens",
    costLabel: "Today cost",
    accent: "#f0b45d",
    accentSoft: "#39230a"
  };
}

function buildViewModel() {
  const payload = state.payload;
  const config = getModeConfig();
  const ok = Boolean(payload?.ok);

  const tokenValue =
    mode === "week"
      ? payload?.cost?.weeklyTokens
      : mode === "day"
        ? (payload?.cost?.dayTokens ?? payload?.cost?.todayTokens)
        : payload?.cost?.todayTokens;
  const costValue =
    mode === "week"
      ? payload?.cost?.weeklyCostUSD
      : mode === "day"
        ? (payload?.cost?.dayCostUSD ?? payload?.cost?.todayCostUSD)
        : payload?.cost?.todayCostUSD;
  const usageValue =
    mode === "week"
      ? payload?.weekly?.usedPercent
      : mode === "day"
        ? null
        : payload?.session?.usedPercent;
  const resetTarget =
    mode === "week"
      ? payload?.weekly?.resetsAt
      : mode === "day"
        ? payload?.cost?.dayResetsAt
        : payload?.session?.resetsAt;

  const fetchedAtMs = new Date(payload?.fetchedAt).getTime();
  if (Number.isFinite(fetchedAtMs)) {
    state.lastFetchedAtMs = fetchedAtMs;
  }

  const resetAt = new Date(resetTarget ?? "").getTime();
  const title = formatTitle(payload);
  const tokenText = formatTokens(tokenValue);
  const costText = formatCost(costValue);
  const usageText =
    mode === "day" ? "Day total refreshes every second" : formatUsedPercent(usageValue);
  const resetText = Number.isFinite(resetAt)
    ? `Reset in ${formatDuration(resetAt - Date.now())}`
    : "Reset in --";
  const updatedText = formatUpdatedAgo(state.lastFetchedAtMs ?? NaN);
  const errorText =
    ok || !payload?.error
      ? ""
      : payload.error;

  return {
    ...config,
    title,
    tokenValue,
    tokenText,
    costValue,
    costText,
    usageText,
    resetText,
    updatedText,
    errorText,
    stale: Boolean(payload?.stale),
    ok
  };
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawSpacedText(context, text, x, y, tracking) {
  let cursorX = x;

  for (const char of text) {
    context.fillText(char, cursorX, y);
    cursorX += context.measureText(char).width + tracking;
  }
}

function animatedValue(key, targetValue, now) {
  if (typeof targetValue !== "number" || Number.isNaN(targetValue)) {
    animatedNumbers.delete(key);
    return targetValue;
  }

  const existing = animatedNumbers.get(key);
  if (!existing) {
    animatedNumbers.set(key, {
      current: targetValue,
      target: targetValue,
      lastNow: now
    });
    return targetValue;
  }

  existing.target = targetValue;

  const deltaMs = Math.max(0, now - existing.lastNow);
  existing.lastNow = now;

  const ease = 1 - Math.exp(-deltaMs / 180);
  existing.current += (existing.target - existing.current) * ease;

  if (Math.abs(existing.target - existing.current) < 0.005) {
    existing.current = existing.target;
  }

  return existing.current;
}

function drawBackground(context, accent, accentSoft, now) {
  context.clearRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);

  const background = context.createLinearGradient(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
  background.addColorStop(0, "#03060b");
  background.addColorStop(1, "#09111c");
  context.fillStyle = background;
  context.fillRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);

  const pulse = (Math.sin(now / 900) + 1) / 2;
  const glow = context.createRadialGradient(
    260,
    120,
    40,
    260,
    120,
    360 + pulse * 60
  );
  glow.addColorStop(0, `${accent}66`);
  glow.addColorStop(0.45, `${accentSoft}bb`);
  glow.addColorStop(1, "#00000000");
  context.fillStyle = glow;
  context.fillRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);

  const secondary = context.createRadialGradient(
    1040,
    620,
    60,
    1040,
    620,
    300 + pulse * 80
  );
  secondary.addColorStop(0, `${accent}33`);
  secondary.addColorStop(0.4, "#1d2d4333");
  secondary.addColorStop(1, "#00000000");
  context.fillStyle = secondary;
  context.fillRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);

  context.strokeStyle = "rgba(255, 255, 255, 0.05)";
  context.lineWidth = 1;
  for (let x = 52; x < RENDER_WIDTH; x += 52) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, RENDER_HEIGHT);
    context.stroke();
  }
}

function drawFrame(now) {
  if (!canvasContext) {
    return;
  }

  const view = buildViewModel();
  const tokenDisplayValue = animatedValue("tokens", view.tokenValue, now);
  const costDisplayValue = animatedValue("cost", view.costValue, now);
  const tokenText = formatTokens(tokenDisplayValue);
  const costText = formatCost(costDisplayValue);
  drawBackground(canvasContext, view.accent, view.accentSoft, now);

  roundedRect(canvasContext, 60, 56, 1160, 608, 38);
  canvasContext.fillStyle = "rgba(6, 10, 16, 0.78)";
  canvasContext.fill();
  canvasContext.strokeStyle = "rgba(255, 255, 255, 0.08)";
  canvasContext.lineWidth = 2;
  canvasContext.stroke();

  roundedRect(canvasContext, 94, 92, 190, 42, 21);
  canvasContext.fillStyle = view.accent;
  canvasContext.fill();

  canvasContext.fillStyle = "#04101d";
  canvasContext.font = "700 20px IBM Plex Sans";
  canvasContext.textBaseline = "middle";
  canvasContext.fillText(view.badge, 116, 114);

  canvasContext.fillStyle = "#f3f7ff";
  canvasContext.font = "600 58px IBM Plex Sans";
  canvasContext.textBaseline = "alphabetic";
  drawSpacedText(canvasContext, view.title, 94, 210, 1.6);

  if (view.tokenLabel) {
    canvasContext.fillStyle = "rgba(239, 246, 255, 0.68)";
    canvasContext.font = "500 24px IBM Plex Sans";
    canvasContext.fillText(view.tokenLabel, 94, 306);
  }

  canvasContext.fillStyle = view.accent;
  canvasContext.font = "700 142px IBM Plex Sans";
  canvasContext.fillText(tokenText, 94, 470);

  canvasContext.fillStyle = "#edf4ff";
  canvasContext.font = "600 44px IBM Plex Sans";
  const costLine = view.costLabel ? `${view.costLabel} ${costText}` : costText;
  canvasContext.fillText(costLine, 94, 564);

  canvasContext.fillStyle = "rgba(239, 246, 255, 0.72)";
  canvasContext.font = "500 28px IBM Plex Sans";
  canvasContext.fillText(view.resetText, 94, 602);
  canvasContext.fillText(view.usageText, 94, 640);

  canvasContext.textAlign = "right";
  canvasContext.fillStyle = view.stale ? "#ffcc88" : "rgba(239, 246, 255, 0.62)";
  canvasContext.font = "500 25px IBM Plex Sans";
  canvasContext.fillText(view.updatedText, 1184, 602);

  if (view.errorText) {
    canvasContext.fillStyle = "#ff9d84";
    canvasContext.font = "500 23px IBM Plex Sans";
    canvasContext.fillText(view.errorText.slice(0, 72), 1184, 640);
  }
  canvasContext.textAlign = "left";

  requestAnimationFrame(drawFrame);
}

function updateChrome() {
  const config = getModeConfig();
  elements.heading.textContent = config.heading;
  elements.description.textContent = config.description;
  document.title = `${config.heading} | Codex Usage`;
}

async function ensurePlayback() {
  if (!elements.video) {
    return;
  }

  try {
    await elements.video.play();
  } catch {
    elements.support.textContent = "Click Open PiP once playback is allowed.";
  }
}

function updatePiPButton() {
  elements.toggle.textContent = state.pipActive ? "Exit PiP" : "Open PiP";
}

function supportsStandardPiP() {
  return Boolean(
    document.pictureInPictureEnabled &&
      typeof elements.video?.requestPictureInPicture === "function"
  );
}

function supportsSafariPiP() {
  return Boolean(
    typeof elements.video?.webkitSupportsPresentationMode === "function" &&
      elements.video.webkitSupportsPresentationMode("picture-in-picture")
  );
}

async function togglePiP() {
  if (!elements.video) {
    return;
  }

  await ensurePlayback();

  if (supportsStandardPiP()) {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }

    await elements.video.requestPictureInPicture();
    return;
  }

  if (supportsSafariPiP()) {
    const nextMode =
      elements.video.webkitPresentationMode === "picture-in-picture"
        ? "inline"
        : "picture-in-picture";
    elements.video.webkitSetPresentationMode(nextMode);
    return;
  }

  elements.support.textContent = "Picture in Picture is not available in this browser.";
}

async function poll() {
  if (state.inFlight) {
    return;
  }

  state.inFlight = true;
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    state.payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load usage data.";
    state.payload = {
      ok: false,
      stale: true,
      error: message,
      fetchedAt: new Date().toISOString()
    };
  } finally {
    state.inFlight = false;
  }
}

function bindPiPState() {
  if (supportsStandardPiP()) {
    elements.video.addEventListener("enterpictureinpicture", () => {
      state.pipActive = true;
      elements.support.textContent = "PiP is live. Leave this tab open.";
      updatePiPButton();
    });

    elements.video.addEventListener("leavepictureinpicture", () => {
      state.pipActive = false;
      elements.support.textContent = "PiP closed. You can reopen it at any time.";
      updatePiPButton();
    });

    elements.support.textContent = "Video stream is ready for Picture in Picture.";
    return;
  }

  if (supportsSafariPiP()) {
    const syncSafariState = () => {
      state.pipActive = elements.video.webkitPresentationMode === "picture-in-picture";
      elements.support.textContent = state.pipActive
        ? "PiP is live. Leave this tab open."
        : "Video stream is ready for Picture in Picture.";
      updatePiPButton();
    };

    elements.video.addEventListener("webkitpresentationmodechanged", syncSafariState);
    syncSafariState();
    return;
  }

  elements.toggle.disabled = true;
  elements.support.textContent = "Picture in Picture is not available in this browser.";
}

function startStream() {
  if (!elements.canvas || !elements.video) {
    return false;
  }

  if (typeof elements.canvas.captureStream !== "function") {
    elements.toggle.disabled = true;
    elements.support.textContent = "This browser cannot turn the render into a PiP-ready video.";
    return false;
  }

  const stream = elements.canvas.captureStream(STREAM_FPS);
  elements.video.srcObject = stream;
  return true;
}

updateChrome();
if (startStream()) {
  bindPiPState();
  elements.toggle.addEventListener("click", () => {
    togglePiP().catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to change Picture in Picture mode.";
      elements.support.textContent = message;
    });
  });
  elements.video.addEventListener("click", () => {
    ensurePlayback();
  });
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
ensurePlayback();
requestAnimationFrame(drawFrame);
