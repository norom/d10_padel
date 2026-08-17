/**
 * Wiring: remote and touch input in, scoreboard out, everything persisted.
 */

import { derive, addPoint, undo, applyOutcome } from "./match.js";
import { createStore } from "./storage.js";
import { createUI } from "./ui.js";
import { ACTIONS, createInputRouter, setBinding, actionForPressCount } from "./input.js";

/** True when running inside the Android wrapper rather than a browser tab. */
const IN_WRAPPER = navigator.userAgent.includes("D10Wrapper");

const store = createStore(window.localStorage);

let { points, bindings } = store.load();

const ui = createUI({
  onPoint: score,
  onUndo: undoPoint,
  onNewMatch: newMatch,
  onOpenBindings: openBindings,
  onCloseBindings: () => router.cancelCapture(),
  onClearBindings: clearBindings,
  onCaptureBinding: captureBinding,
});

const router = createInputRouter({
  browserChannels: !IN_WRAPPER,
  getBindings: () => bindings,
  // Every press is shown on the binding screen, so a button that produces
  // nothing is distinguishable from one that was simply not captured.
  onSignature: (signature) => ui.logInput(signature),
  onAction: (action) => {
    if (action === ACTIONS.POINT_A) score("A");
    else if (action === ACTIONS.POINT_B) score("B");
    else if (action === ACTIONS.UNDO) undoPoint();
  },
  onGesture: scoreFromPressCount,
});

/**
 * One button, scored by how many times it was pressed.
 *
 * Each press is applied immediately against the state the chain began from, so
 * the first press scores Team A at once and a second press replaces that with a
 * point to Team B rather than adding to it. Nothing waits, and a fumble of four
 * or more presses lands back exactly where it started.
 */
let chainStart = null;

const OUTCOMES = {
  [ACTIONS.POINT_A]: "A",
  [ACTIONS.POINT_B]: "B",
  [ACTIONS.UNDO]: "UNDO",
};

function scoreFromPressCount(count) {
  if (count === 1) chainStart = points;

  const outcome = OUTCOMES[actionForPressCount(count)] || null;
  const next = applyOutcome(chainStart, outcome);

  // A decided match still refuses new points, exactly as the buttons do.
  if (outcome !== "UNDO" && derive(chainStart).matchOver) return;

  points = next;
  store.savePoints(points);
  ui.render(derive(points));
  if (outcome === "A" || outcome === "B") ui.flash(outcome);
}

// ------------------------------------------------------------------ actions

function score(team) {
  const next = addPoint(points, team);
  if (next === points) return; // match already decided

  points = next;
  store.savePoints(points);
  ui.render(derive(points));
  ui.flash(team);
}

function undoPoint() {
  if (points.length === 0) return;

  points = undo(points);
  store.savePoints(points);
  ui.render(derive(points));
}

function newMatch() {
  points = [];
  store.clearMatch();
  ui.render(derive(points));
}

// ----------------------------------------------------------------- bindings

function openBindings() {
  // Media buttons only reach a page holding a media session, and claiming one
  // needs a user gesture — opening this screen is that gesture.
  router.enableMediaSession();
  ui.renderBindings(bindings);
}

function captureBinding(action) {
  router.captureNext((signature) => {
    // setBinding frees the button from whatever else it was bound to, so the
    // same press cannot mean two things.
    bindings = setBinding(bindings, action, signature);
    store.saveBindings(bindings);
    ui.renderBindings(bindings);
  });
}

function clearBindings() {
  bindings = {};
  store.saveBindings(bindings);
  router.cancelCapture();
  ui.renderBindings(bindings);
}

// -------------------------------------------------------------- screen wake

let wakeLock = null;

async function keepAwake() {
  if (!("wakeLock" in navigator)) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Denied or unsupported. The scoreboard still works, the screen just sleeps.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLock) keepAwake();
});

// ------------------------------------------------------------------- start

router.start();
ui.render(derive(points));
ui.renderBindings(bindings);

// A wake lock needs a user gesture on some builds, so try immediately and
// again on the first interaction.
keepAwake();
document.addEventListener("pointerdown", () => keepAwake(), { once: true });

// The wrapper already serves every file from the APK, so a second caching
// layer would only add a way for it to go stale.
if ("serviceWorker" in navigator && !IN_WRAPPER) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline support is best-effort; the app runs without it.
    });
  });
}
