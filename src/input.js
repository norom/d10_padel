/**
 * Remote input.
 *
 * We do not know what the D10's buttons look like to Android, so nothing here
 * assumes a particular key. Every channel a browser can reach is listened to at
 * once, each event is reduced to a comparable *signature*, and signatures are
 * matched against a binding table the user fills in by pressing the buttons.
 *
 * The pure half (signatures, matching, repeat filtering) has no DOM
 * dependencies and is unit tested. The router below is the thin wiring.
 */

export const ACTIONS = {
  POINT_A: "POINT_A",
  POINT_B: "POINT_B",
  UNDO: "UNDO",
  // One button that scores everything by how many times it is pressed. The D10
  // only has one button Android can hear, so this is how the whole match gets
  // scored from the remote.
  GESTURE: "GESTURE",
};

/** How many presses mean what. Four or more is a fumble and means nothing. */
const PRESS_ACTIONS = {
  1: ACTIONS.POINT_A,
  2: ACTIONS.POINT_B,
  3: ACTIONS.UNDO,
};

export function actionForPressCount(count) {
  return PRESS_ACTIONS[count] || null;
}

/**
 * Counts presses that arrive close together.
 *
 * `onCount` fires on every press so the screen can show what is pending;
 * `onResolve` fires once, when the presses stop, and is the only thing that
 * changes the score. Splitting the two is what keeps the scoreboard still while
 * still answering the press immediately — showing each intermediate result on
 * the score itself reads as the number jumping around by itself.
 *
 * The timer functions are injectable so press timing can be tested without
 * waiting on a real clock.
 */
export function createPressChain({
  windowMs = 800,
  onCount,
  onResolve,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let count = 0;
  let timer = null;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  return {
    press() {
      count += 1;
      stop();

      timer = setTimer(() => {
        const total = count;
        count = 0;
        timer = null;
        onResolve(total);
      }, windowMs);

      onCount(count);
    },

    reset() {
      stop();
      count = 0;
    },
  };
}

/** What a press count will do, for the on-screen indicator. */
export function pendingLabel(count) {
  switch (count) {
    case 1:
      return "Team A";
    case 2:
      return "Team B";
    case 3:
      return "Undo";
    default:
      return "Cancelled";
  }
}

/**
 * Assign a button to an action, taking it away from any other action first.
 * One button cannot mean two things, and a signature bound twice would resolve
 * to whichever action happened to be enumerated first.
 */
export function setBinding(bindings, action, signature) {
  const key = signatureKey(signature);
  const next = {};

  for (const [name, bound] of Object.entries(bindings || {})) {
    if (bound && signatureKey(bound) !== key) next[name] = bound;
  }

  next[action] = signature;
  return next;
}

export const CHANNELS = {
  KEYBOARD: "keyboard",
  MEDIA: "media",
  GAMEPAD: "gamepad",
  TEXT: "text",
  ANDROID: "android",
  BLE: "ble",
};

// ---------------------------------------------------------------- signatures

export function keyboardSignature(event) {
  return {
    channel: CHANNELS.KEYBOARD,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
  };
}

export function mediaSignature(action) {
  return { channel: CHANNELS.MEDIA, action };
}

export function gamepadSignature(index) {
  return { channel: CHANNELS.GAMEPAD, index };
}

export function textSignature(char) {
  return { channel: CHANNELS.TEXT, char };
}

/**
 * A key seen by the Android wrapper. Volume keys never reach a web page in
 * Chrome, so on that build the remote arrives here instead — the wrapper reads
 * the KeyEvent natively and hands the code to the page.
 */
export function androidSignature(keyCode, keyName, scanCode = 0) {
  return { channel: CHANNELS.ANDROID, keyCode, keyName, scanCode };
}

/**
 * A signal pushed by the remote over its own BLE service rather than as a key.
 *
 * The D10's A and B buttons are not keyboard buttons at all — they talk to the
 * camera over a vendor service, which is why nothing Android exposes as input
 * ever saw them. `data` is the notification payload as hex.
 */
export function bleSignature(data) {
  return { channel: CHANNELS.BLE, data: normaliseHex(data) };
}

/** Hex is compared by its bytes, not by how it happens to be written. */
function normaliseHex(data) {
  return String(data).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** A stable string identifying one physical button, comparable across presses. */
export function signatureKey(signature) {
  if (!signature) return "";

  switch (signature.channel) {
    case CHANNELS.KEYBOARD:
      return `keyboard:${signature.key}|${signature.code}|${signature.keyCode}`;
    case CHANNELS.MEDIA:
      return `media:${signature.action}`;
    case CHANNELS.GAMEPAD:
      return `gamepad:${signature.index}`;
    case CHANNELS.TEXT:
      return `text:${signature.char}`;
    // The name is cosmetic and varies between devices; the code is the button.
    // Codes Android cannot name all arrive as 0, so those fall back to the scan
    // code, which still differs per physical button.
    case CHANNELS.ANDROID:
      return signature.keyCode
        ? `android:${signature.keyCode}`
        : `android:0/${signature.scanCode || 0}`;
    case CHANNELS.BLE:
      return `ble:${signature.data}`;
    default:
      return `${signature.channel}:${JSON.stringify(signature)}`;
  }
}

/** Which action this signature is bound to, or null. */
export function findAction(signature, bindings) {
  const key = signatureKey(signature);
  if (!key) return null;

  for (const [action, bound] of Object.entries(bindings || {})) {
    if (bound && signatureKey(bound) === key) return action;
  }
  return null;
}

/** Human-readable form, shown on the binding screen. */
export function describeSignature(signature) {
  if (!signature) return "not set";

  switch (signature.channel) {
    case CHANNELS.KEYBOARD: {
      const name = signature.key === " " ? "Space" : signature.key;
      return `Key ${name} (${signature.code || "no code"} / ${signature.keyCode})`;
    }
    case CHANNELS.MEDIA:
      return `Media button: ${signature.action}`;
    case CHANNELS.GAMEPAD:
      return `Gamepad button ${signature.index}`;
    case CHANNELS.TEXT:
      return `Types "${signature.char}"`;
    case CHANNELS.ANDROID:
      return signature.keyCode
        ? `Remote key ${signature.keyName || "unnamed"} (${signature.keyCode})`
        : `Remote key, unnamed (scan ${signature.scanCode || 0})`;
    case CHANNELS.BLE:
      return `Remote signal ${formatHex(signature.data)}`;
    default:
      return signatureKey(signature);
  }
}

/** Bytes as "0A 1B", which is how they read on a screen. */
function formatHex(data) {
  return (String(data).match(/../g) || []).join(" ").toUpperCase();
}

/**
 * Suppresses a second reading of the same button inside `windowMs`. A remote
 * button held a little long, or delivered on two channels at once, must score
 * one point rather than two.
 */
export function createRepeatFilter(windowMs) {
  const lastSeen = new Map();

  // Gesture presses are deliberate and close together, so the caller can ask
  // for a tighter guard than the one that stops a held button scoring twice.
  return (key, now, window = windowMs) => {
    const previous = lastSeen.get(key);
    if (previous !== undefined && now - previous < window) return false;

    lastSeen.set(key, now);
    return true;
  };
}

// ---------------------------------------------------------------- the router

const MEDIA_ACTIONS = [
  "play",
  "pause",
  "stop",
  "nexttrack",
  "previoustrack",
  "seekforward",
  "seekbackward",
];

/**
 * An inaudible looping tone. Android only routes media buttons to a page that
 * holds a media session, and a page only gets one while audio is playing.
 */
function inaudibleLoopSource(seconds = 10) {
  const rate = 8000;
  const samples = rate * seconds;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  let at = 0;

  const putString = (s) => { for (let i = 0; i < s.length; i++) bytes[at++] = s.charCodeAt(i); };
  const putU32 = (v) => { view.setUint32(at, v, true); at += 4; };
  const putU16 = (v) => { view.setUint16(at, v, true); at += 2; };

  putString("RIFF"); putU32(36 + samples); putString("WAVE");
  putString("fmt "); putU32(16); putU16(1); putU16(1);
  putU32(rate); putU32(rate); putU16(1); putU16(8);
  putString("data"); putU32(samples);

  // One least-significant bit of movement: enough to count as audio, far too
  // little to hear.
  for (let i = 0; i < samples; i++) bytes[44 + i] = 128 + (Math.floor(i / 200) % 2);

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * Listens on every channel and emits actions.
 *
 * @param {object} options
 * @param {() => object} options.getBindings  current binding table
 * @param {(action: string) => void} options.onAction
 * @param {(signature: object) => void} [options.onSignature] every press, bound or not
 */
export function createInputRouter({
  getBindings,
  onAction,
  onGesture,
  onGesturePending = () => {},
  onBleStatus,
  onSignature,
  repeatWindowMs = 400,
  // Long enough to press again without hurrying, short enough that the score
  // lands promptly. The indicator answers the press immediately, so this is not
  // felt as lag.
  gestureWindowMs = 800,
  // The browser channels keep a hidden field focused so the document receives
  // key events. The Android wrapper gets keys natively instead, and a focused
  // field there only risks summoning the on-screen keyboard.
  browserChannels = true,
}) {
  const accepts = createRepeatFilter(repeatWindowMs);
  const padButtons = new Map();

  // A gesture chain is deliberate rapid pressing, so it needs a guard tight
  // enough to let a second press through while still dropping a duplicate
  // delivery of the same press.
  const GESTURE_GUARD_MS = 60;

  const presses = createPressChain({
    windowMs: gestureWindowMs,
    onCount: (count) => onGesturePending(count),
    onResolve: (count) => onGesture(count),
  });

  let captureHandler = null;
  let audio = null;
  let started = false;

  function receive(signature, event) {
    const bound = captureHandler ? null : findAction(signature, getBindings());
    const isGesture = bound === ACTIONS.GESTURE;

    if (!accepts(signatureKey(signature), Date.now(), isGesture ? GESTURE_GUARD_MS : undefined)) {
      return;
    }

    if (onSignature) onSignature(signature);

    if (captureHandler) {
      const handler = captureHandler;
      captureHandler = null;
      if (event) event.preventDefault();
      handler(signature);
      return;
    }

    if (!bound) return;
    if (event) event.preventDefault();

    if (isGesture) {
      presses.press();
      return;
    }
    onAction(bound);
  }

  function listenForKeys() {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.repeat) return;
        receive(keyboardSignature(event), event);
      },
      true,
    );
  }

  function listenForText() {
    const field = document.createElement("input");
    field.setAttribute("inputmode", "none");
    field.setAttribute("aria-hidden", "true");
    field.setAttribute("autocomplete", "off");
    field.tabIndex = -1;
    field.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(field);

    field.addEventListener("input", () => {
      const typed = field.value;
      field.value = "";
      if (typed) receive(textSignature(typed.slice(-1)), null);
    });

    const refocus = () => {
      try {
        field.focus({ preventScroll: true });
      } catch {
        field.focus();
      }
    };

    refocus();
    document.addEventListener("pointerup", () => setTimeout(refocus, 0));
    return refocus;
  }

  function listenForGamepad() {
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad) continue;
        const previous = padButtons.get(pad.index) || [];
        pad.buttons.forEach((button, index) => {
          if (button.pressed && !previous[index]) receive(gamepadSignature(index), null);
          previous[index] = button.pressed;
        });
        padButtons.set(pad.index, previous);
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  /**
   * Claim a media session so Android routes media buttons here. Needs a user
   * gesture to start audio, so this is called from a tap.
   */
  async function enableMediaSession() {
    if (!("mediaSession" in navigator)) return false;

    if (!audio) {
      audio = new Audio(inaudibleLoopSource());
      audio.loop = true;
      audio.volume = 0.02;
    }

    try {
      await audio.play();
    } catch {
      return false;
    }

    navigator.mediaSession.playbackState = "playing";
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Padel scoreboard",
        artist: "listening for the remote",
      });
    } catch {
      // MediaMetadata is optional.
    }

    for (const action of MEDIA_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action, () => {
          receive(mediaSignature(action), null);
        });
      } catch {
        // Not every action is supported everywhere.
      }
    }
    return true;
  }

  /**
   * The Android wrapper calls this from dispatchKeyEvent. It is the only way
   * volume keys can reach the scoreboard, since Chrome never delivers them.
   */
  function exposeNativeBridge() {
    window.d10Remote = {
      key(keyCode, keyName, scanCode) {
        receive(androidSignature(Number(keyCode), keyName, Number(scanCode) || 0), null);
      },

      ble(data) {
        receive(bleSignature(data), null);
      },

      bleStatus(text) {
        if (onBleStatus) onBleStatus(String(text));
      },
    };
  }

  return {
    start() {
      if (started) return;
      started = true;

      exposeNativeBridge();

      if (browserChannels) {
        listenForKeys();
        listenForText();
        listenForGamepad();
      }
    },
    captureNext(handler) {
      presses.reset();
      captureHandler = handler;
    },
    cancelCapture() {
      presses.reset();
      captureHandler = null;
    },
    enableMediaSession,
  };
}
