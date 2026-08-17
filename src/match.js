/**
 * Padel scoring.
 *
 * The entire match is a pure function of the sequence of points won, so
 * `derive(["A","B","A",...])` reproduces the full scoreboard from scratch and
 * undo is nothing more than dropping the last entry. Nothing here touches the
 * DOM or storage.
 */

export const TEAMS = ["A", "B"];

const other = (team) => (team === "A" ? "B" : "A");

const POINT_NAMES = ["0", "15", "30", "40"];

const GAMES_TO_SET = 6;
const TIE_BREAK_AT = 6;
const TIE_BREAK_TO = 7;
const POINTS_TO_GAME = 4;
const BEST_OF_SETS = 3;
const SETS_TO_MATCH = Math.ceil(BEST_OF_SETS / 2);

function emptyState() {
  return {
    points: { A: 0, B: 0 },
    games: { A: 0, B: 0 },
    setsWon: { A: 0, B: 0 },
    completedSets: [],
    tieBreak: false,
    isDeuce: false,
    advantage: null,
    matchOver: false,
    winner: null,
  };
}

function applyPoint(state, team) {
  const opponent = other(team);
  const target = state.tieBreak ? TIE_BREAK_TO : POINTS_TO_GAME;

  state.points[team] += 1;

  if (state.points[team] >= target && state.points[team] - state.points[opponent] >= 2) {
    winGame(state, team);
  }
}

function winGame(state, team) {
  const opponent = other(team);

  state.points = { A: 0, B: 0 };
  state.tieBreak = false;
  state.games[team] += 1;

  const mine = state.games[team];
  const theirs = state.games[opponent];
  const wonBySpread = mine >= GAMES_TO_SET && mine - theirs >= 2;
  const wonTieBreak = mine === TIE_BREAK_AT + 1 && theirs === TIE_BREAK_AT;

  if (wonBySpread || wonTieBreak) {
    winSet(state, team);
  } else if (mine === TIE_BREAK_AT && theirs === TIE_BREAK_AT) {
    state.tieBreak = true;
  }
}

function winSet(state, team) {
  state.completedSets.push({ A: state.games.A, B: state.games.B });
  state.setsWon[team] += 1;
  state.games = { A: 0, B: 0 };

  if (state.setsWon[team] >= SETS_TO_MATCH) {
    state.matchOver = true;
    state.winner = team;
  }
}

function annotate(state) {
  const { A, B } = state.points;
  const past40 = !state.tieBreak && A >= 3 && B >= 3;

  state.isDeuce = past40 && A === B;
  state.advantage = past40 && A !== B ? (A > B ? "A" : "B") : null;
  return state;
}

/** Recompute the whole scoreboard from the list of points won. */
export function derive(points) {
  const state = emptyState();

  for (const team of points) {
    if (state.matchOver) break;
    applyPoint(state, team);
  }
  return annotate(state);
}

/**
 * Award a point, returning a new point list. A decided match ignores further
 * points, so a remote button knocked in someone's bag cannot rewrite a result
 * that already stands.
 */
export function addPoint(points, team) {
  if (derive(points).matchOver) return points;
  return [...points, team];
}

/** Drop the last point. Because state is derived, this restores the previous
 *  scoreboard exactly, including across game and set boundaries. */
export function undo(points) {
  return points.slice(0, -1);
}

/** The text shown in a team's point slot: "0", "15", "30", "40", "AD",
 *  or a plain count during a tie-break. */
export function pointLabel(state, team) {
  const mine = state.points[team];
  const theirs = state.points[other(team)];

  if (state.tieBreak) return String(mine);

  if (mine >= 3 && theirs >= 3) {
    return mine > theirs ? "AD" : "40";
  }
  return POINT_NAMES[mine];
}
