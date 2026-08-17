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
};

export const CHANNELS = {
  KEYBOARD: "keyboard",
  MEDIA: "media",
  GAMEPAD: "gamepad",
  TEXT: "text",
  ANDROID: "android",
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
    default:
      return signatureKey(signature);
  }
}

/**
 * Suppresses a second reading of the same button inside `windowMs`. A remote
 * button held a little long, or delivered on two channels at once, must score
 * one point rather than two.
 */
export function createRepeatFilter(windowMs) {
  const lastSeen = new Map();

  return (key, now) => {
    const previous = lastSeen.get(key);
    if (previous !== undefined && now - previous < windowMs) return false;

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
  onSignature,
  repeatWindowMs = 400,
  // The browser channels keep a hidden field focused so the document receives
  // key events. The Android wrapper gets keys natively instead, and a focused
  // field there only risks summoning the on-screen keyboard.
  browserChannels = true,
}) {
  const accepts = createRepeatFilter(repeatWindowMs);
  const padButtons = new Map();

  let captureHandler = null;
  let audio = null;
  let started = false;

  function receive(signature, event) {
    if (!accepts(signatureKey(signature), Date.now())) return;

    if (onSignature) onSignature(signature);

    if (captureHandler) {
      const handler = captureHandler;
      captureHandler = null;
      if (event) event.preventDefault();
      handler(signature);
      return;
    }

    const action = findAction(signature, getBindings());
    if (!action) return;

    if (event) event.preventDefault();
    onAction(action);
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
      captureHandler = handler;
    },
    cancelCapture() {
      captureHandler = null;
    },
    enableMediaSession,
  };
}
