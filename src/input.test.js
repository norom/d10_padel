import test from "node:test";
import assert from "node:assert/strict";

import {
  createPressChain,
  pendingLabel,
  actionForPressCount,
  setBinding,
  ACTIONS,
  keyboardSignature,
  mediaSignature,
  gamepadSignature,
  textSignature,
  androidSignature,
  bleSignature,
  signatureKey,
  findAction,
  describeSignature,
  createRepeatFilter,
} from "./input.js";

const keyEvent = (over = {}) => ({
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  ...over,
});

test("the same physical key produces the same signature key", () => {
  const first = signatureKey(keyboardSignature(keyEvent()));
  const second = signatureKey(keyboardSignature(keyEvent()));

  assert.equal(first, second);
});

test("different keys produce different signature keys", () => {
  const enter = signatureKey(keyboardSignature(keyEvent()));
  const space = signatureKey(
    keyboardSignature(keyEvent({ key: " ", code: "Space", keyCode: 32 })),
  );

  assert.notEqual(enter, space);
});

test("a keyboard signature never collides with another channel", () => {
  const key = signatureKey(keyboardSignature(keyEvent({ keyCode: 1 })));
  const pad = signatureKey(gamepadSignature(1));
  const media = signatureKey(mediaSignature("play"));
  const text = signatureKey(textSignature("1"));

  assert.equal(new Set([key, pad, media, text]).size, 4);
});

test("a bound signature resolves to its action", () => {
  const bindings = {
    [ACTIONS.POINT_A]: keyboardSignature(keyEvent()),
    [ACTIONS.POINT_B]: mediaSignature("nexttrack"),
    [ACTIONS.UNDO]: gamepadSignature(3),
  };

  assert.equal(findAction(keyboardSignature(keyEvent()), bindings), ACTIONS.POINT_A);
  assert.equal(findAction(mediaSignature("nexttrack"), bindings), ACTIONS.POINT_B);
  assert.equal(findAction(gamepadSignature(3), bindings), ACTIONS.UNDO);
});

test("an unbound signature resolves to nothing", () => {
  const bindings = { [ACTIONS.POINT_A]: keyboardSignature(keyEvent()) };

  const stray = keyboardSignature(keyEvent({ key: "x", code: "KeyX", keyCode: 88 }));

  assert.equal(findAction(stray, bindings), null);
});

test("missing bindings are tolerated", () => {
  assert.equal(findAction(keyboardSignature(keyEvent()), {}), null);
  assert.equal(findAction(keyboardSignature(keyEvent()), { POINT_A: null }), null);
});

test("a signature describes itself for the binding screen", () => {
  assert.match(describeSignature(keyboardSignature(keyEvent())), /Enter/);
  assert.match(describeSignature(mediaSignature("play")), /play/i);
  assert.match(describeSignature(gamepadSignature(2)), /2/);
  assert.equal(describeSignature(null), "not set");
});

test("a button held slightly long does not score twice", () => {
  const accepts = createRepeatFilter(400);
  const press = signatureKey(keyboardSignature(keyEvent()));

  assert.equal(accepts(press, 1000), true);
  assert.equal(accepts(press, 1200), false);
});

test("the same button scores again once the window passes", () => {
  const accepts = createRepeatFilter(400);
  const press = signatureKey(keyboardSignature(keyEvent()));

  assert.equal(accepts(press, 1000), true);
  assert.equal(accepts(press, 1500), true);
});

test("an Android key is identified by its key code, not its name", () => {
  // The wrapper sends a human-readable name alongside the code. Only the code
  // identifies the button, so a binding survives a name that reads differently
  // on another device.
  const first = signatureKey(androidSignature(24, "VOLUME_UP"));
  const second = signatureKey(androidSignature(24, "KEYCODE_VOLUME_UP"));

  assert.equal(first, second);
});

test("unrecognised keys are told apart by scan code", () => {
  // A remote can send codes Android has no name for. They all arrive as
  // KEYCODE_UNKNOWN, so without the scan code two different buttons would share
  // one signature and binding the second would silently steal the first.
  const a = signatureKey(androidSignature(0, "UNKNOWN", 114));
  const b = signatureKey(androidSignature(0, "UNKNOWN", 115));

  assert.notEqual(a, b);
});

test("the same unrecognised key keeps one identity", () => {
  assert.equal(
    signatureKey(androidSignature(0, "UNKNOWN", 114)),
    signatureKey(androidSignature(0, "UNKNOWN", 114)),
  );
});

test("a recognised key ignores the scan code, so bindings survive", () => {
  // Scan codes vary between devices; a named key is already unambiguous.
  assert.equal(
    signatureKey(androidSignature(24, "VOLUME_UP", 115)),
    signatureKey(androidSignature(24, "VOLUME_UP", 0)),
  );
});

test("different Android key codes are different buttons", () => {
  assert.notEqual(
    signatureKey(androidSignature(24, "VOLUME_UP")),
    signatureKey(androidSignature(25, "VOLUME_DOWN")),
  );
});

test("an Android key never collides with a browser key of the same code", () => {
  const native = signatureKey(androidSignature(13, "ENTER"));
  const browser = signatureKey(keyboardSignature(keyEvent({ keyCode: 13 })));

  assert.notEqual(native, browser);
});

test("an Android key binds and resolves like any other signature", () => {
  const bindings = { [ACTIONS.UNDO]: androidSignature(24, "VOLUME_UP") };

  assert.equal(findAction(androidSignature(24, "VOLUME_UP"), bindings), ACTIONS.UNDO);
  assert.equal(findAction(androidSignature(25, "VOLUME_DOWN"), bindings), null);
});

test("an Android key describes itself with name and code", () => {
  const described = describeSignature(androidSignature(24, "VOLUME_UP"));

  assert.match(described, /VOLUME_UP/);
  assert.match(described, /24/);
});

test("a different button is never suppressed", () => {
  const accepts = createRepeatFilter(400);
  const a = signatureKey(keyboardSignature(keyEvent()));
  const b = signatureKey(keyboardSignature(keyEvent({ code: "Space", keyCode: 32 })));

  assert.equal(accepts(a, 1000), true);
  assert.equal(accepts(b, 1010), true);
});

// ------------------------------------------------------- one-button gestures

/** A controllable stand-in for setTimeout, so press timing is deterministic. */
function fakeTimers() {
  let pending = null;
  let nextId = 0;

  return {
    setTimer(fn) {
      pending = fn;
      return ++nextId;
    },
    clearTimer() {
      pending = null;
    },
    fire() {
      const fn = pending;
      pending = null;
      if (fn) fn();
    },
    isPending: () => pending !== null,
  };
}

test("a press reports its running count straight away", () => {
  const timers = fakeTimers();
  const counts = [];
  const chain = createPressChain({ onCount: (n) => counts.push(n), onResolve: () => {}, ...timers });

  chain.press();

  assert.deepEqual(counts, [1], "the indicator must update on the press itself");
});

test("nothing is resolved while presses are still arriving", () => {
  const timers = fakeTimers();
  const resolved = [];
  const chain = createPressChain({ onCount: () => {}, onResolve: (n) => resolved.push(n), ...timers });

  chain.press();
  chain.press();

  assert.deepEqual(resolved, [], "the score must stay still until the chain ends");
});

test("the chain resolves once, with the final count", () => {
  const timers = fakeTimers();
  const counts = [];
  const resolved = [];
  const chain = createPressChain({
    onCount: (n) => counts.push(n),
    onResolve: (n) => resolved.push(n),
    ...timers,
  });

  chain.press();
  chain.press();
  timers.fire();

  assert.deepEqual(counts, [1, 2], "each press updates the indicator");
  assert.deepEqual(resolved, [2], "only the total is acted on");
});

test("a chain starts over after resolving", () => {
  const timers = fakeTimers();
  const counts = [];
  const resolved = [];
  const chain = createPressChain({
    onCount: (n) => counts.push(n),
    onResolve: (n) => resolved.push(n),
    ...timers,
  });

  chain.press();
  timers.fire();
  chain.press();
  chain.press();
  timers.fire();

  assert.deepEqual(counts, [1, 1, 2]);
  assert.deepEqual(resolved, [1, 2]);
});

test("each press pushes the window back", () => {
  const timers = fakeTimers();
  const chain = createPressChain({ onCount: () => {}, onResolve: () => {}, ...timers });

  chain.press();
  chain.press();

  assert.equal(timers.isPending(), true);
});

test("resetting abandons the chain without resolving it", () => {
  const timers = fakeTimers();
  const resolved = [];
  const chain = createPressChain({ onCount: () => {}, onResolve: (n) => resolved.push(n), ...timers });

  chain.press();
  chain.reset();

  assert.deepEqual(resolved, []);
  assert.equal(timers.isPending(), false);
});

test("press counts map to the three scoring actions", () => {
  assert.equal(actionForPressCount(1), ACTIONS.POINT_A);
  assert.equal(actionForPressCount(2), ACTIONS.POINT_B);
  assert.equal(actionForPressCount(3), ACTIONS.UNDO);
});

test("a longer burst does nothing rather than guessing", () => {
  // Four presses is a fumble, not an instruction. Undoing on it would be worse
  // than ignoring it, because an undo is what you cannot easily take back.
  assert.equal(actionForPressCount(4), null);
  assert.equal(actionForPressCount(0), null);
});

// ------------------------------------------------------- binding exclusivity

test("binding a button to an action assigns it", () => {
  const next = setBinding({}, ACTIONS.POINT_A, androidSignature(24, "VOLUME_UP"));

  assert.equal(signatureKey(next[ACTIONS.POINT_A]), signatureKey(androidSignature(24, "VOLUME_UP")));
});

test("binding a button that is already used frees it from the other action", () => {
  // One button cannot mean two things, and findAction would otherwise resolve
  // it to whichever key happened to be enumerated first.
  const volumeUp = androidSignature(24, "VOLUME_UP");
  const first = setBinding({}, ACTIONS.POINT_A, volumeUp);

  const second = setBinding(first, ACTIONS.GESTURE, volumeUp);

  assert.equal(second[ACTIONS.POINT_A], undefined);
  assert.equal(signatureKey(second[ACTIONS.GESTURE]), signatureKey(volumeUp));
});

test("binding a different button leaves existing bindings alone", () => {
  const first = setBinding({}, ACTIONS.POINT_A, androidSignature(24, "VOLUME_UP"));
  const second = setBinding(first, ACTIONS.POINT_B, androidSignature(25, "VOLUME_DOWN"));

  assert.equal(signatureKey(second[ACTIONS.POINT_A]), signatureKey(androidSignature(24, "VOLUME_UP")));
  assert.equal(signatureKey(second[ACTIONS.POINT_B]), signatureKey(androidSignature(25, "VOLUME_DOWN")));
});

test("a gesture button resolves to the gesture action", () => {
  const bindings = setBinding({}, ACTIONS.GESTURE, androidSignature(24, "VOLUME_UP"));

  assert.equal(findAction(androidSignature(24, "VOLUME_UP"), bindings), ACTIONS.GESTURE);
});

// --------------------------------------------------- repeat filter windowing

test("the repeat filter accepts a shorter window when asked", () => {
  // Gesture presses are deliberate and close together, so they need a tighter
  // guard than the one that stops a held button scoring twice.
  const accepts = createRepeatFilter(400);

  assert.equal(accepts("k", 1000), true);
  assert.equal(accepts("k", 1150), false, "default window still rejects");
  assert.equal(accepts("k", 1300, 60), true, "explicit short window allows it");
});

test("a press count describes what it will do", () => {
  assert.match(pendingLabel(1), /team a/i);
  assert.match(pendingLabel(2), /team b/i);
  assert.match(pendingLabel(3), /undo/i);
  assert.match(pendingLabel(4), /cancel/i);
  assert.match(pendingLabel(9), /cancel/i);
});

// ------------------------------------------------------------- BLE signals

test("the same BLE payload is the same button", () => {
  assert.equal(signatureKey(bleSignature("0102")), signatureKey(bleSignature("0102")));
});

test("different BLE payloads are different buttons", () => {
  assert.notEqual(signatureKey(bleSignature("0102")), signatureKey(bleSignature("0103")));
});

test("payload case and spacing do not change identity", () => {
  // The wrapper formats bytes as hex; nothing about how it is written should
  // decide whether two presses count as the same button.
  assert.equal(signatureKey(bleSignature("0A1B")), signatureKey(bleSignature("0a1b")));
  assert.equal(signatureKey(bleSignature("0a 1b")), signatureKey(bleSignature("0a1b")));
});

test("a BLE signal never collides with a key of the same number", () => {
  const ble = signatureKey(bleSignature("24"));
  const key = signatureKey(androidSignature(24, "VOLUME_UP"));

  assert.notEqual(ble, key);
});

test("a BLE signal binds and resolves like any other signature", () => {
  const bindings = setBinding({}, ACTIONS.POINT_A, bleSignature("0102"));

  assert.equal(findAction(bleSignature("0102"), bindings), ACTIONS.POINT_A);
  assert.equal(findAction(bleSignature("0103"), bindings), null);
});

test("a BLE signal describes itself by its bytes", () => {
  assert.match(describeSignature(bleSignature("0a1b")), /0A 1B/);
});
