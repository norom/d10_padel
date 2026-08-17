/**
 * Rendering and on-screen controls.
 *
 * Holds no match state of its own — it is handed a derived state and puts it on
 * the glass. The only thing it remembers is which side scored last, so it can
 * flash that field.
 */

import { pointLabel } from "./match.js";
import { ACTIONS, describeSignature } from "./input.js";

const FLASH_MS = 420;

const el = (id) => document.getElementById(id);

export function createUI(handlers) {
  const nodes = {
    format: el("format"),
    sideA: el("sideA"),
    sideB: el("sideB"),
    scoreA: el("scoreA"),
    scoreB: el("scoreB"),
    setsA: el("setsA"),
    setsB: el("setsB"),
    gamesA: el("gamesA"),
    gamesB: el("gamesB"),
    badge: el("netBadge"),
    btnA: el("btnA"),
    btnB: el("btnB"),
    btnUndo: el("btnUndo"),
    newBtn: el("newBtn"),
    remoteBtn: el("remoteBtn"),
    fullscreenBtn: el("fullscreenBtn"),
    probe: el("scoreProbe"),
    confirmSheet: el("confirmSheet"),
    confirmOk: el("confirmOk"),
    confirmCancel: el("confirmCancel"),
    bindSheet: el("bindSheet"),
    bindDone: el("bindDone"),
    bindClear: el("bindClear"),
  };

  const flashTimers = { A: null, B: null };

  // ------------------------------------------------------------- rendering

  function render(state) {
    nodes.scoreA.textContent = pointLabel(state, "A");
    nodes.scoreB.textContent = pointLabel(state, "B");

    nodes.setsA.textContent = state.setsWon.A;
    nodes.setsB.textContent = state.setsWon.B;
    nodes.gamesA.textContent = state.games.A;
    nodes.gamesB.textContent = state.games.B;

    nodes.sideA.classList.toggle("side--advantage", state.advantage === "A");
    nodes.sideB.classList.toggle("side--advantage", state.advantage === "B");

    renderBadge(state);

    nodes.btnA.disabled = state.matchOver;
    nodes.btnB.disabled = state.matchOver;
    nodes.format.textContent = state.matchOver ? "Match complete" : "Best of 3";

    fitScores();
  }

  /**
   * Size the score to the widest string the slot can ever hold, not to the
   * string currently in it, so digits do not jump between 40 and AD. The system
   * font is whatever the device provides, so this is measured rather than
   * assumed.
   */
  const SIDE_GUTTER = 20;
  const MIN_SCORE_PX = 28;

  function fitScores() {
    nodes.scoreA.style.fontSize = "";
    nodes.scoreB.style.fontSize = "";

    let size = parseFloat(getComputedStyle(nodes.scoreA).fontSize);
    if (!Number.isFinite(size) || size <= 0) return;

    const available = nodes.sideA.clientWidth - SIDE_GUTTER;
    nodes.probe.style.fontSize = `${size}px`;

    const widest = nodes.probe.getBoundingClientRect().width;
    if (widest > available && widest > 0) {
      size = Math.max(MIN_SCORE_PX, Math.floor((size * available) / widest));
    }
    apply(size);

    // The slot can also be short rather than narrow, which happens in landscape
    // on a small phone.
    let guard = 0;
    while (guard++ < 14 && size > MIN_SCORE_PX && overflowsVertically()) {
      size = Math.max(MIN_SCORE_PX, Math.floor(size * 0.92));
      apply(size);
    }
  }

  function apply(size) {
    nodes.scoreA.style.fontSize = `${size}px`;
    nodes.scoreB.style.fontSize = `${size}px`;
  }

  function overflowsVertically() {
    return (
      nodes.sideA.scrollHeight > nodes.sideA.clientHeight + 1 ||
      nodes.sideB.scrollHeight > nodes.sideB.clientHeight + 1
    );
  }

  function renderBadge(state) {
    let text = "";
    if (state.matchOver) text = `Team ${state.winner} wins`;
    else if (state.tieBreak) text = "Tie-break";

    nodes.badge.textContent = text;
    if (text) nodes.badge.setAttribute("data-shown", "");
    else nodes.badge.removeAttribute("data-shown");
  }

  /** Brief lift of a whole field — the at-distance confirmation that a press landed. */
  function flash(team) {
    const side = team === "A" ? nodes.sideA : nodes.sideB;

    side.classList.remove("side--scored");
    void side.offsetWidth; // restart the transition if points come quickly
    side.classList.add("side--scored");

    clearTimeout(flashTimers[team]);
    flashTimers[team] = setTimeout(() => side.classList.remove("side--scored"), FLASH_MS);
  }

  // ---------------------------------------------------------------- sheets

  function openSheet(sheet) {
    sheet.hidden = false;
  }

  function closeSheet(sheet) {
    sheet.hidden = true;
  }

  function confirmNewMatch() {
    openSheet(nodes.confirmSheet);
  }

  // -------------------------------------------------------- binding screen

  function renderBindings(bindings) {
    if (seen.length === 0) el("inputLog").classList.add("empty");

    for (const row of document.querySelectorAll(".bind-row")) {
      const action = row.dataset.action;
      row.querySelector(".bound").textContent = describeSignature(bindings[action]);
      row.removeAttribute("data-listening");
    }
  }

  /**
   * A running list of everything the phone hands the page. Without it, a button
   * that emits nothing at all looks exactly like one whose press was received
   * but not captured — and those need completely different fixes.
   */
  const seen = [];
  const SEEN_LIMIT = 8;

  function logInput(signature) {
    const description = describeSignature(signature);
    const last = seen[0];

    if (last && last.description === description) {
      last.count += 1;
    } else {
      seen.unshift({ description, count: 1 });
      seen.length = Math.min(seen.length, SEEN_LIMIT);
    }

    const node = el("inputLog");
    node.classList.remove("empty");
    node.textContent = seen
      .map((entry) => (entry.count > 1 ? `${entry.description}  x${entry.count}` : entry.description))
      .join("\n");
  }

  function markListening(action) {
    for (const row of document.querySelectorAll(".bind-row")) {
      if (row.dataset.action === action) {
        row.setAttribute("data-listening", "");
        row.querySelector(".bound").textContent = "Press it now…";
      } else {
        row.removeAttribute("data-listening");
      }
    }
  }

  // ----------------------------------------------------------------- wiring

  nodes.btnA.addEventListener("click", () => handlers.onPoint("A"));
  nodes.btnB.addEventListener("click", () => handlers.onPoint("B"));
  nodes.btnUndo.addEventListener("click", () => handlers.onUndo());

  nodes.newBtn.addEventListener("click", confirmNewMatch);
  nodes.confirmCancel.addEventListener("click", () => closeSheet(nodes.confirmSheet));
  nodes.confirmOk.addEventListener("click", () => {
    closeSheet(nodes.confirmSheet);
    handlers.onNewMatch();
  });

  nodes.remoteBtn.addEventListener("click", () => {
    openSheet(nodes.bindSheet);
    handlers.onOpenBindings();
  });
  nodes.bindDone.addEventListener("click", () => {
    closeSheet(nodes.bindSheet);
    handlers.onCloseBindings();
  });
  nodes.bindClear.addEventListener("click", () => handlers.onClearBindings());

  for (const row of document.querySelectorAll(".bind-row")) {
    row.addEventListener("click", () => {
      markListening(row.dataset.action);
      handlers.onCaptureBinding(row.dataset.action);
    });
  }

  nodes.fullscreenBtn.addEventListener("click", toggleFullscreen);

  // In the Android wrapper the browser's limitation no longer applies, and the
  // note warning about it would be actively misleading.
  if (navigator.userAgent.includes("D10Wrapper")) {
    el("bindNote").textContent =
      "This app reads the remote directly, so the volume buttons work here even " +
      "though Chrome ignores them.";
    nodes.fullscreenBtn.hidden = true;
  }

  window.addEventListener("resize", fitScores);
  // Android reports the new size a beat after the rotation animation.
  window.addEventListener("orientationchange", () => setTimeout(fitScores, 150));

  // Keyboard events reach the page only while the document has focus, and a
  // focused button would also re-fire on Enter or Space.
  document.addEventListener("click", (event) => {
    if (event.target.closest("button")) event.target.closest("button").blur();
  });

  return {
    render,
    flash,
    renderBindings,
    logInput,
    markListening,
    isBinding: () => !nodes.bindSheet.hidden,
    actionsInOrder: [ACTIONS.POINT_A, ACTIONS.POINT_B, ACTIONS.UNDO],
  };
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    // Fullscreen is a nicety; a phone that refuses it still keeps score.
  }
}
