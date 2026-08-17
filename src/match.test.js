import test from "node:test";
import assert from "node:assert/strict";

import { derive, pointLabel, addPoint, undo } from "./match.js";

/** Build a point list from a compact string: play("AAB") === ["A","A","B"] */
const play = (seq) => derive([...seq]);

/** The pair of labels shown in the point slot, e.g. ["40", "15"]. */
const labels = (state) => [pointLabel(state, "A"), pointLabel(state, "B")];

test("a new match starts level at love", () => {
  const state = play("");

  assert.deepEqual(labels(state), ["0", "0"]);
  assert.deepEqual(state.games, { A: 0, B: 0 });
  assert.deepEqual(state.setsWon, { A: 0, B: 0 });
});

test("points climb 15, 30, 40", () => {
  assert.deepEqual(labels(play("A")), ["15", "0"]);
  assert.deepEqual(labels(play("AA")), ["30", "0"]);
  assert.deepEqual(labels(play("AAA")), ["40", "0"]);
});

test("a fourth point wins the game and resets the points", () => {
  const state = play("AAAA");

  assert.deepEqual(state.games, { A: 1, B: 0 });
  assert.deepEqual(labels(state), ["0", "0"]);
});

test("both sides on 40 is deuce, not a won game", () => {
  const state = play("AAABBB");

  assert.deepEqual(labels(state), ["40", "40"]);
  assert.equal(state.isDeuce, true);
  assert.deepEqual(state.games, { A: 0, B: 0 });
});

test("a point from deuce is advantage, shown on the leading side", () => {
  const state = play("AAABBBA");

  assert.deepEqual(labels(state), ["AD", "40"]);
  assert.equal(state.advantage, "A");
  assert.deepEqual(state.games, { A: 0, B: 0 });
});

test("the opponent scoring at advantage returns to deuce", () => {
  const state = play("AAABBBAB");

  assert.deepEqual(labels(state), ["40", "40"]);
  assert.equal(state.isDeuce, true);
  assert.equal(state.advantage, null);
});

test("a point at advantage wins the game", () => {
  const state = play("AAABBBAA");

  assert.deepEqual(state.games, { A: 1, B: 0 });
  assert.deepEqual(labels(state), ["0", "0"]);
});

test("a game needs a two point margin, so 40-30 is not a win", () => {
  const state = play("AAAABBB".slice(0, 3) + "BBB" + "A");

  assert.deepEqual(state.games, { A: 0, B: 0 });
  assert.equal(state.advantage, "A");
});

/**
 * Play out whole games in the given order, so gameSeq("ABA") is
 * "A wins a game, then B, then A". Order matters: a set ends the moment
 * it is decided, so 6-0 followed by four B games is a different match
 * than an interleaved 6-4.
 */
const gameSeq = (seq) => [...seq].map((team) => team.repeat(4)).join("");

test("a set is won at six games with a two game margin", () => {
  const state = play(gameSeq("ABABABABAA"));

  assert.deepEqual(state.setsWon, { A: 1, B: 0 });
  assert.deepEqual(state.completedSets, [{ A: 6, B: 4 }]);
  assert.deepEqual(state.games, { A: 0, B: 0 });
});

test("six games to five does not win the set", () => {
  const state = play(gameSeq("ABABABABABA"));

  assert.deepEqual(state.games, { A: 6, B: 5 });
  assert.deepEqual(state.setsWon, { A: 0, B: 0 });
  assert.deepEqual(state.completedSets, []);
});

test("a set can be won seven games to five", () => {
  const state = play(gameSeq("ABABABABABAA"));

  assert.deepEqual(state.setsWon, { A: 1, B: 0 });
  assert.deepEqual(state.completedSets, [{ A: 7, B: 5 }]);
});

test("six games all starts a tie-break", () => {
  const state = play(gameSeq("ABABABABABAB"));

  assert.equal(state.tieBreak, true);
  assert.deepEqual(state.games, { A: 6, B: 6 });
  assert.deepEqual(state.setsWon, { A: 0, B: 0 });
});

/** Points played from here are tie-break points, at six games all. */
const TIE_BREAK = gameSeq("ABABABABABAB");

test("tie-break points are counted plainly, not as 15/30/40", () => {
  const state = play(TIE_BREAK + "AAB");

  assert.deepEqual(labels(state), ["2", "1"]);
});

test("a tie-break is won at seven points, taking the set 7-6", () => {
  // Four points would win an ordinary game; in a tie-break it wins nothing.
  const partway = play(TIE_BREAK + "AAAA");
  assert.deepEqual(partway.setsWon, { A: 0, B: 0 });
  assert.deepEqual(partway.points, { A: 4, B: 0 });

  const state = play(TIE_BREAK + "AAAAAAA");

  assert.deepEqual(state.setsWon, { A: 1, B: 0 });
  assert.deepEqual(state.completedSets, [{ A: 7, B: 6 }]);
  assert.equal(state.tieBreak, false);
});

test("seven points to six does not win the tie-break", () => {
  const state = play(TIE_BREAK + "AAAAAA" + "BBBBBB" + "A");

  assert.equal(state.tieBreak, true);
  assert.deepEqual(state.points, { A: 7, B: 6 });
  assert.deepEqual(state.setsWon, { A: 0, B: 0 });
});

test("a tie-break continues until someone leads by two", () => {
  const state = play(TIE_BREAK + "AAAAAA" + "BBBBBB" + "AB" + "AA");

  assert.deepEqual(state.setsWon, { A: 1, B: 0 });
  assert.deepEqual(state.completedSets, [{ A: 7, B: 6 }]);
});

/** One full set to A, six games to four. */
const SET_TO_A = gameSeq("ABABABABAA");

test("winning two sets wins the best-of-three match", () => {
  const state = play(SET_TO_A + SET_TO_A);

  assert.deepEqual(state.setsWon, { A: 2, B: 0 });
  assert.equal(state.matchOver, true);
  assert.equal(state.winner, "A");
});

test("a finished match ignores further points", () => {
  const finished = [...(SET_TO_A + SET_TO_A)];

  const afterStrayPress = addPoint(finished, "B");

  assert.deepEqual(afterStrayPress, finished);
});

test("undo restores the previous point", () => {
  const before = [..."AAB"];
  assert.deepEqual(labels(derive(before)), ["30", "15"]);

  const after = addPoint(before, "A");
  assert.deepEqual(labels(derive(after)), ["40", "15"]);

  assert.deepEqual(labels(derive(undo(after))), ["30", "15"]);
});

test("undo reverses a point that won a game and a set at once", () => {
  const before = [...(gameSeq("ABABABABA") + "AAAB")];

  const start = derive(before);
  assert.deepEqual(start.games, { A: 5, B: 4 });
  assert.deepEqual(labels(start), ["40", "15"]);
  assert.deepEqual(start.setsWon, { A: 0, B: 0 });

  const won = derive(addPoint(before, "A"));
  assert.deepEqual(won.setsWon, { A: 1, B: 0 });
  assert.deepEqual(won.games, { A: 0, B: 0 });
  assert.deepEqual(won.completedSets, [{ A: 6, B: 4 }]);

  const back = derive(undo(addPoint(before, "A")));
  assert.deepEqual(back.games, { A: 5, B: 4 });
  assert.deepEqual(labels(back), ["40", "15"]);
  assert.deepEqual(back.setsWon, { A: 0, B: 0 });
  assert.deepEqual(back.completedSets, []);
});

test("undo on an empty match does nothing", () => {
  assert.deepEqual(undo([]), []);
});

test("adding a point leaves the original list untouched", () => {
  const before = [..."AAB"];

  addPoint(before, "A");

  assert.deepEqual(before, [..."AAB"]);
});
