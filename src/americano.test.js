import test from "node:test";
import assert from "node:assert/strict";

import { deriveAmericano, addAmericanoPoint, americanoLabel } from "./americano.js";
import { undo } from "./match.js";

/** Build a point list from a compact string: play("AAB") === ["A","A","B"] */
const play = (seq, target = 24) => deriveAmericano([...seq], target);

test("a new round starts level with every point still to play", () => {
  const state = play("");

  assert.deepEqual(state.points, { A: 0, B: 0 });
  assert.equal(state.played, 0);
  assert.equal(state.remaining, 24);
  assert.equal(state.matchOver, false);
});

test("points are counted plainly, not as 15/30/40", () => {
  const state = play("AABAB");

  assert.deepEqual(state.points, { A: 3, B: 2 });
  assert.equal(americanoLabel(state, "A"), "3");
  assert.equal(americanoLabel(state, "B"), "2");
});

test("every point played takes one off the remaining count", () => {
  assert.equal(play("A").remaining, 23);
  assert.equal(play("AAB").remaining, 21);
});

test("the round ends when the scores add up to the target", () => {
  // 24 points played, however they are split.
  const state = play("A".repeat(16) + "B".repeat(8));

  assert.deepEqual(state.points, { A: 16, B: 8 });
  assert.equal(state.remaining, 0);
  assert.equal(state.matchOver, true);
  assert.equal(state.winner, "A");
  assert.equal(state.draw, false);
});

test("a close round still ends on the total, not on a margin", () => {
  const state = play("A".repeat(13) + "B".repeat(11));

  assert.equal(state.matchOver, true);
  assert.equal(state.winner, "A");
});

test("level scores at the target is a draw, not a win", () => {
  // In Americano the points themselves are the result, so a draw is a real
  // outcome rather than something to play off.
  const state = play("A".repeat(12) + "B".repeat(12));

  assert.equal(state.matchOver, true);
  assert.equal(state.draw, true);
  assert.equal(state.winner, null);
});

test("an odd target cannot end level", () => {
  const state = deriveAmericano([...("A".repeat(11) + "B".repeat(10))], 21);

  assert.equal(state.matchOver, true);
  assert.equal(state.draw, false);
  assert.equal(state.winner, "A");
});

test("the round is not over one point short", () => {
  const state = play("A".repeat(12) + "B".repeat(11));

  assert.equal(state.matchOver, false);
  assert.equal(state.remaining, 1);
  assert.equal(state.winner, null);
});

test("a finished round ignores further points", () => {
  const finished = [..."A".repeat(16) + "B".repeat(8)];

  assert.deepEqual(addAmericanoPoint(finished, "B", 24), finished);
});

test("adding a point leaves the original list untouched", () => {
  const before = [..."AAB"];

  addAmericanoPoint(before, "A", 24);

  assert.deepEqual(before, [..."AAB"]);
});

test("points beyond the target are never counted", () => {
  // Stored data could hold more than the target if a round was played at a
  // longer setting and the target was then lowered.
  const state = deriveAmericano([..."A".repeat(30)], 24);

  assert.deepEqual(state.points, { A: 24, B: 0 });
  assert.equal(state.remaining, 0);
});

test("undo reopens a round that had just ended", () => {
  const finished = [..."A".repeat(16) + "B".repeat(8)];
  assert.equal(deriveAmericano(finished, 24).matchOver, true);

  const back = deriveAmericano(undo(finished), 24);

  assert.equal(back.matchOver, false);
  assert.equal(back.remaining, 1);
  assert.deepEqual(back.points, { A: 16, B: 7 });
});
