const video = document.querySelector("#webcam");
const paintCanvas = document.querySelector("#paintCanvas");
const overlayCanvas = document.querySelector("#overlay");
const startButton = document.querySelector("#startButton");
const drawButton = document.querySelector("#drawButton");
const clearButton = document.querySelector("#clearButton");
const undoButton = document.querySelector("#undoButton");
const redoButton = document.querySelector("#redoButton");
const colorPicker = document.querySelector("#colorPicker");
const colorPreview = document.querySelector("#colorPreview");
const errorText = document.querySelector("#errorText");
const statusText = document.querySelector("#statusText");
const drawKeyText = document.querySelector("#drawKeyText");
const modalBackdrop = document.querySelector("#modalBackdrop");
const modalButtons = document.querySelectorAll("[data-modal-button]");
const modalCloseButtons = document.querySelectorAll("[data-modal-close]");
const paintNavButton = document.querySelector(".top-nav [data-modal-close]");
const modals = document.querySelectorAll(".modal-panel");
const themeInputs = document.querySelectorAll("input[name='theme']");

const overlayCtx = overlayCanvas.getContext("2d");
const paintCtx = paintCanvas.getContext("2d");

let handLandmarker;
let drawingUtils;
let handConnections;
let animationFrameId;
let isTracking = false;
let isKeyboardDrawing = false;
let isButtonDrawing = false;
let lastVideoTime = -1;
let activeStroke;
let lineColor = colorPicker.value;
const lineWidth = 8;
const strokeHistory = [];
const redoHistory = [];
const allowedThemes = new Set(["dark", "light"]);
const mediaPipeVersion = "0.10.22-rc.20250304";

if (window.self !== window.top) {
  document.body.textContent = "This app cannot run inside an embedded frame.";
  throw new Error("Frame embedding blocked.");
}

applySavedTheme();

startButton.addEventListener("click", () => {
  if (isTracking) {
    stopTracking();
    return;
  }

  startTracking();
});
clearButton.addEventListener("click", clearPaintCanvas);
undoButton.addEventListener("click", undoStroke);
redoButton.addEventListener("click", redoStroke);
colorPicker.addEventListener("input", () => {
  lineColor = colorPicker.value;
  colorPreview.style.background = lineColor;
});
window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (!modalBackdrop.hidden) {
    return;
  }

  if (event.ctrlKey && key === "z") {
    event.preventDefault();
    undoStroke();
    return;
  }

  if (event.ctrlKey && key === "y") {
    event.preventDefault();
    redoStroke();
    return;
  }

  if (key === "d" && !event.repeat) {
    isKeyboardDrawing = true;
    syncDrawingState();
  }
});
window.addEventListener("keyup", (event) => {
  if (!modalBackdrop.hidden) {
    return;
  }

  if (event.key.toLowerCase() === "d") {
    isKeyboardDrawing = false;
    syncDrawingState();
  }
});
drawButton.addEventListener("click", () => {
  isButtonDrawing = !isButtonDrawing;
  syncDrawingState();
});
modalButtons.forEach((button) => {
  button.addEventListener("click", () => {
    openModal(button.dataset.modalButton);
  });
});
modalCloseButtons.forEach((button) => {
  button.addEventListener("click", closeModal);
});
modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) {
    closeModal();
  }
});
themeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) {
      return;
    }

    setTheme(input.value);
  });
});

async function startTracking() {
  clearError();
  startButton.disabled = true;
  startButton.textContent = "Starting camera...";
  statusText.textContent = "Starting";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
    resizeCanvas();

    startButton.textContent = "Loading tracker...";
    statusText.textContent = "Loading";
    handLandmarker ??= await createHandLandmarker();

    isTracking = true;
    startButton.disabled = false;
    startButton.textContent = "Stop camera";
    statusText.textContent = "Tracking";
    detectHands();
  } catch (error) {
    stopCameraStream();
    startButton.disabled = false;
    startButton.textContent = "Start camera";
    showError(getFriendlyError(error));
  }
}

function stopTracking() {
  cancelAnimationFrame(animationFrameId);
  animationFrameId = undefined;
  lastVideoTime = -1;
  isTracking = false;
  isKeyboardDrawing = false;
  isButtonDrawing = false;
  syncDrawingState();

  stopCameraStream();
  clearOverlayCanvas();
  statusText.textContent = "Camera off";
  clearError();
  startButton.disabled = false;
  startButton.textContent = "Start camera";
}

function stopCameraStream() {
  video.srcObject?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
}

async function createHandLandmarker() {
  const {
    DrawingUtils,
    FilesetResolver,
    HandLandmarker,
  } = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeVersion}/vision_bundle.mjs`);
  const vision = await FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeVersion}/wasm`,
  );

  const options = {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  };

  drawingUtils = new DrawingUtils(overlayCtx);
  handConnections = HandLandmarker.HAND_CONNECTIONS;

  try {
    return await HandLandmarker.createFromOptions(vision, options);
  } catch {
    return HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: {
        ...options.baseOptions,
        delegate: "CPU",
      },
    });
  }
}

function detectHands() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    resizeCanvas();

    const results = handLandmarker.detectForVideo(video, performance.now());
    drawResults(results);
    drawWithFinger(results);
    updateReadout(results);
  }

  animationFrameId = requestAnimationFrame(detectHands);
}

function drawResults(results) {
  clearOverlayCanvas();

  for (const landmarks of results.landmarks ?? []) {
    const mirrored = landmarks.map((point) => ({
      ...point,
      x: 1 - point.x,
    }));

    drawingUtils.drawConnectors(mirrored, handConnections, {
      color: "#6ee7d2",
      lineWidth: 4,
    });
    drawingUtils.drawLandmarks(mirrored, {
      color: "#f1c84b",
      fillColor: "#f1c84b",
      lineWidth: 2,
      radius: 5,
    });
  }

  const point = getDrawingPoint(results);
  if (point) {
    drawPointer(point);
  }
}

function drawWithFinger(results) {
  if (!isDrawingActive()) {
    finishActiveStroke();
    return;
  }

  const point = getDrawingPoint(results);
  if (!point) {
    finishActiveStroke();
    return;
  }

  if (!activeStroke) {
    activeStroke = {
      color: lineColor,
      width: lineWidth,
      points: [point],
    };
    redoHistory.length = 0;
    renderStroke(activeStroke);
  } else {
    activeStroke.points.push(point);
    renderStrokeSegment(activeStroke, activeStroke.points.length - 2);
  }
}

function getDrawingPoint(results) {
  const landmarks = results.landmarks?.[0];
  if (!landmarks) {
    return undefined;
  }

  return toCanvasPoint(landmarks[8], paintCanvas);
}

function toCanvasPoint(point, targetCanvas) {
  return {
    x: (1 - point.x) * targetCanvas.width,
    y: point.y * targetCanvas.height,
    nx: 1 - point.x,
    ny: point.y,
  };
}

function drawPointer(point) {
  overlayCtx.beginPath();
  overlayCtx.arc(point.x, point.y, isDrawingActive() ? 16 : 11, 0, Math.PI * 2);
  overlayCtx.strokeStyle = isDrawingActive() ? lineColor : "#ffffff";
  overlayCtx.lineWidth = isDrawingActive() ? 5 : 3;
  overlayCtx.stroke();
}

function updateReadout(results) {
  if (!isTracking) {
    statusText.textContent = "Camera off";
    return;
  }

  statusText.textContent = results.landmarks?.length ? "Finger seen" : "No hand";
}

function resizeCanvas() {
  const rect = video.getBoundingClientRect();
  const width = Math.round(rect.width * window.devicePixelRatio);
  const height = Math.round(rect.height * window.devicePixelRatio);

  resizeDrawingCanvas(paintCanvas, width, height);
  resizeDrawingCanvas(overlayCanvas, width, height);
}

function resizeDrawingCanvas(targetCanvas, width, height) {
  if (targetCanvas.width === width && targetCanvas.height === height) {
    return;
  }

  targetCanvas.width = width;
  targetCanvas.height = height;

  if (targetCanvas === paintCanvas) {
    redrawPaintCanvas();
    return;
  }
}

function clearPaintCanvas() {
  finishActiveStroke();
  strokeHistory.length = 0;
  redoHistory.length = 0;
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  updateHistoryButtons();
}

function clearOverlayCanvas() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function finishActiveStroke() {
  if (!activeStroke) {
    return;
  }

  if (activeStroke.points.length) {
    strokeHistory.push(activeStroke);
  }

  activeStroke = undefined;
  updateHistoryButtons();
}

function undoStroke() {
  finishActiveStroke();
  const stroke = strokeHistory.pop();
  if (!stroke) {
    return;
  }

  redoHistory.push(stroke);
  redrawPaintCanvas();
  updateHistoryButtons();
}

function redoStroke() {
  const stroke = redoHistory.pop();
  if (!stroke) {
    return;
  }

  strokeHistory.push(stroke);
  redrawPaintCanvas();
  updateHistoryButtons();
}

function redrawPaintCanvas() {
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  strokeHistory.forEach(renderStroke);
}

function renderStroke(stroke) {
  if (!stroke.points.length) {
    return;
  }

  if (stroke.points.length === 1) {
    const point = getRenderPoint(stroke.points[0]);
    paintCtx.beginPath();
    paintCtx.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2);
    paintCtx.fillStyle = stroke.color;
    paintCtx.fill();
    return;
  }

  for (let index = 0; index < stroke.points.length - 1; index++) {
    renderStrokeSegment(stroke, index);
  }
}

function renderStrokeSegment(stroke, pointIndex) {
  const start = getRenderPoint(stroke.points[pointIndex]);
  const end = getRenderPoint(stroke.points[pointIndex + 1]);
  paintCtx.beginPath();
  paintCtx.moveTo(start.x, start.y);
  paintCtx.lineTo(end.x, end.y);
  paintCtx.strokeStyle = stroke.color;
  paintCtx.lineWidth = stroke.width;
  paintCtx.lineCap = "round";
  paintCtx.lineJoin = "round";
  paintCtx.stroke();
}

function getRenderPoint(point) {
  return {
    x: point.nx * paintCanvas.width,
    y: point.ny * paintCanvas.height,
  };
}

function updateHistoryButtons() {
  undoButton.disabled = !strokeHistory.length;
  redoButton.disabled = !redoHistory.length;
}

function isDrawingActive() {
  return isKeyboardDrawing || isButtonDrawing;
}

function syncDrawingState() {
  const active = isDrawingActive();
  if (!active) {
    finishActiveStroke();
  }

  drawButton.classList.toggle("is-active", active);
  drawButton.setAttribute("aria-pressed", String(active));
  drawKeyText.textContent = active ? "Held" : "Released";
}

function openModal(modalName) {
  const modal = Array.from(modals).find((panel) => panel.id === `${modalName}Modal`);
  if (!modal || !modal.classList.contains("modal-panel")) {
    return;
  }

  isKeyboardDrawing = false;
  isButtonDrawing = false;
  syncDrawingState();

  modalBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  paintNavButton.classList.remove("is-active");
  modalButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.modalButton === modalName);
  });
  modals.forEach((panel) => {
    panel.hidden = panel !== modal;
  });
}

function closeModal() {
  modalBackdrop.hidden = true;
  document.body.classList.remove("modal-open");
  paintNavButton.classList.add("is-active");
  modalButtons.forEach((button) => {
    button.classList.remove("is-active");
  });
  modals.forEach((modal) => {
    modal.hidden = true;
  });
  resizeCanvas();
}

function applySavedTheme() {
  setTheme(readStoredTheme(), false);
}

function setTheme(theme, shouldSave = true) {
  const nextTheme = allowedThemes.has(theme) ? theme : "dark";
  document.body.dataset.theme = nextTheme;
  themeInputs.forEach((input) => {
    input.checked = input.value === nextTheme;
  });

  if (shouldSave) {
    writeStoredTheme(nextTheme);
  }
}

function readStoredTheme() {
  try {
    return localStorage.getItem("theme") || "dark";
  } catch {
    return "dark";
  }
}

function writeStoredTheme(theme) {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Theme persistence is optional. The app still works if storage is blocked.
  }
}

function clearError() {
  errorText.textContent = "";
}

function showError(message) {
  errorText.textContent = message;
  statusText.textContent = "Camera off";
}

function getFriendlyError(error) {
  if (error?.name === "SecurityError" || location.protocol === "file:") {
    return "Open this page from http://127.0.0.1:5173/ instead of the file directly so the browser can use the camera.";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support webcam access.";
  }

  if (error?.name === "NotAllowedError") {
    return "Camera permission was blocked. Allow camera access and try again.";
  }

  if (error?.name === "NotFoundError") {
    return "No camera was found on this device.";
  }

  if (error instanceof TypeError) {
    return "The hand-tracking library did not load. Check your internet connection, then refresh and try again.";
  }

  return "Could not start hand tracking. Check your camera and internet connection.";
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalBackdrop.hidden) {
    closeModal();
  }
});
window.addEventListener("pagehide", stopTracking);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopTracking();
  }
});
window.addEventListener("beforeunload", () => {
  stopTracking();
});
