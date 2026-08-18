/**
 * Wiring: remote and touch input in, scoreboard out, everything persisted.
 */

import { derive, addPoint, undo, pointLabel } from "./match.js";
import { deriveAmericano, addAmericanoPoint, americanoLabel } from "./americano.js";
import { createStore } from "./storage.js";
import { createUI } from "./ui.js";
import { ACTIONS, createInputRouter, setBinding, actionForPressCount } from "./input.js";

/** True when running inside the Android wrapper rather than a browser tab. */
const IN_WRAPPER = navigator.userAgent.includes("D10Wrapper");

const store = createStore(window.localStorage);

let { points, bindings, format } = store.load();

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
  onBleStatus: (text) => ui.showBleStatus(text),
  onAction: (action) => {
    if (action === ACTIONS.POINT_A) score("A");
    else if (action === ACTIONS.POINT_B) score("B");
    else if (action === ACTIONS.UNDO) undoPoint();
  },
  onGesture: scoreFromPressCount,
  onGesturePending: showPendingPresses,
});

/**
 * One button, scored by how many times it was pressed.
 *
 * The score stays still while the presses are still arriving — only the
 * indicator moves — and the result is applied once, when they stop. Showing
 * each intermediate result on the score itself reads as the number changing by
 * itself, which is worse than a short wait.
 */
const OUTCOMES = {
  [ACTIONS.POINT_A]: "A",
  [ACTIONS.POINT_B]: "B",
  [ACTIONS.UNDO]: "UNDO",
};

function showPendingPresses(count) {
  ui.showPending(count);
}

function scoreFromPressCount(count) {
  ui.clearPending();

  const outcome = OUTCOMES[actionForPressCount(count)] || null;
  if (!outcome) {
    show();
    return;
  }

  if (outcome === "UNDO") {
    undoPoint();
    return;
  }
  score(outcome);
}

// ------------------------------------------------------------------ formats

const isAmericano = () => format.kind === "americano";

function currentState() {
  return isAmericano() ? deriveAmericano(points, format.target) : derive(points);
}

/**
 * Turns a match state into what the screen shows. Keeping this here rather than
 * in the UI means a format is described in one place: how it scores, what it
 * calls itself, and which parts of the scoreboard apply to it.
 */
function view() {
  const state = currentState();

  if (isAmericano()) {
    return {
      labels: { A: americanoLabel(state, "A"), B: americanoLabel(state, "B") },
      stats: null,
      advantage: null,
      badge: state.draw ? "Draw" : state.winner ? `Team ${state.winner} wins` : "",
      status: state.matchOver ? "Round complete" : `Americano · to ${format.target}`,
      locked: state.matchOver,
    };
  }

  return {
    labels: { A: pointLabel(state, "A"), B: pointLabel(state, "B") },
    stats: { sets: state.setsWon, games: state.games },
    advantage: state.advantage,
    badge: state.matchOver
      ? `Team ${state.winner} wins`
      : state.tieBreak
        ? "Tie-break"
        : "",
    status: state.matchOver ? "Match complete" : "Best of 3",
    locked: state.matchOver,
  };
}

function show() {
  ui.render(view());
}

// ------------------------------------------------------------------ actions

function score(team) {
  const next = isAmericano()
    ? addAmericanoPoint(points, team, format.target)
    : addPoint(points, team);

  if (next === points) return; // the match or round is already decided

  points = next;
  store.savePoints(points);
  show();
  ui.flash(team);
}

function undoPoint() {
  if (points.length === 0) return;

  points = undo(points);
  store.savePoints(points);
  show();
}

function newMatch(chosen) {
  format = chosen;
  points = [];

  store.saveFormat(format);
  store.clearMatch();

  ui.renderFormats(format);
  show();
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
ui.renderFormats(format);
show();
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
