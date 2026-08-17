import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  keyboardSignature,
  mediaSignature,
  gamepadSignature,
  textSignature,
  androidSignature,
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
