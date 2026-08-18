import test from "node:test";
import assert from "node:assert/strict";

import { createStore, EMPTY } from "./storage.js";

/** Stand-in for localStorage. */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get size() {
      return data.size;
    },
  };
}

test("an empty store reads as a fresh match", () => {
  const store = createStore(fakeStorage());

  assert.deepEqual(store.load(), EMPTY);
});

test("points survive a reload", () => {
  const storage = fakeStorage();

  createStore(storage).savePoints([..."AAB"]);

  assert.deepEqual(createStore(storage).load().points, ["A", "A", "B"]);
});

test("bindings survive a reload", () => {
  const storage = fakeStorage();
  const bindings = { POINT_A: { channel: "keyboard", key: "Enter" } };

  createStore(storage).saveBindings(bindings);

  assert.deepEqual(createStore(storage).load().bindings, bindings);
});

test("saving points leaves bindings alone", () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  const bindings = { POINT_A: { channel: "gamepad", index: 1 } };

  store.saveBindings(bindings);
  store.savePoints([..."AB"]);

  const loaded = createStore(storage).load();
  assert.deepEqual(loaded.bindings, bindings);
  assert.deepEqual(loaded.points, ["A", "B"]);
});

test("corrupt stored data reads as a fresh match instead of throwing", () => {
  const store = createStore(fakeStorage({ "d10-padel": "{not json" }));

  assert.deepEqual(store.load(), EMPTY);
});

test("stored data of the wrong shape is discarded", () => {
  const store = createStore(fakeStorage({ "d10-padel": '{"points":"AAB"}' }));

  assert.deepEqual(store.load().points, []);
});

test("unknown teams in stored points are rejected", () => {
  const store = createStore(fakeStorage({ "d10-padel": '{"points":["A","Z","B"]}' }));

  assert.deepEqual(store.load().points, []);
});

test("clearing removes the match but keeps the bindings", () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  const bindings = { UNDO: { channel: "media", action: "play" } };

  store.saveBindings(bindings);
  store.savePoints([..."AAB"]);
  store.clearMatch();

  const loaded = createStore(storage).load();
  assert.deepEqual(loaded.points, []);
  assert.deepEqual(loaded.bindings, bindings);
});

test("a storage that throws does not take the scoreboard down", () => {
  const hostile = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("denied");
    },
  };

  const store = createStore(hostile);

  assert.deepEqual(store.load(), EMPTY);
  assert.doesNotThrow(() => store.savePoints([..."A"]));
});

test("a fresh store plays tennis", () => {
  assert.deepEqual(createStore(fakeStorage()).load().format, { kind: "tennis" });
});

test("the chosen format survives a reload", () => {
  const storage = fakeStorage();

  createStore(storage).saveFormat({ kind: "americano", target: 21 });

  assert.deepEqual(createStore(storage).load().format, { kind: "americano", target: 21 });
});

test("saving the format leaves the match and bindings alone", () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  const bindings = { GESTURE: { channel: "android", keyCode: 24 } };

  store.saveBindings(bindings);
  store.savePoints([..."AB"]);
  store.saveFormat({ kind: "americano", target: 24 });

  const loaded = createStore(storage).load();
  assert.deepEqual(loaded.bindings, bindings);
  assert.deepEqual(loaded.points, ["A", "B"]);
  assert.deepEqual(loaded.format, { kind: "americano", target: 24 });
});

test("an unknown format falls back to tennis", () => {
  const store = createStore(fakeStorage({ "d10-padel": '{"format":{"kind":"chess"}}' }));

  assert.deepEqual(store.load().format, { kind: "tennis" });
});

test("an americano target that is not a sensible number falls back to the default", () => {
  const nonsense = ['{"format":{"kind":"americano","target":"lots"}}',
                    '{"format":{"kind":"americano","target":0}}',
                    '{"format":{"kind":"americano"}}'];

  for (const raw of nonsense) {
    const loaded = createStore(fakeStorage({ "d10-padel": raw })).load();
    assert.deepEqual(loaded.format, { kind: "americano", target: 24 }, raw);
  }
});
