/**
 * Americano scoring.
 *
 * A round is a fixed number of points played, however they fall: at a target of
 * 24 the round ends on 16-8 or 13-11 alike. That is the point of the format —
 * every player plays the same number of points, so the totals they take away
 * are directly comparable.
 *
 * Like the tennis engine, the whole state is derived from the list of points
 * won, so undo is dropping the last entry and recomputing.
 */

export const TARGETS = [21, 24];

export const DEFAULT_TARGET = 24;

/** Recompute the round from the list of points won. */
export function deriveAmericano(points, target) {
  const tally = { A: 0, B: 0 };

  // Only the first `target` points count. Stored data can hold more if a round
  // was played at a longer setting and the target was later lowered.
  for (const team of points.slice(0, target)) tally[team] += 1;

  const played = tally.A + tally.B;
  const matchOver = played >= target;
  const level = tally.A === tally.B;

  return {
    points: tally,
    target,
    played,
    remaining: target - played,
    matchOver,
    draw: matchOver && level,
    winner: matchOver && !level ? (tally.A > tally.B ? "A" : "B") : null,
  };
}

/**
 * Award a point, returning a new point list. A finished round ignores further
 * points, so a stray remote press cannot rewrite a result that already stands.
 */
export function addAmericanoPoint(points, team, target) {
  if (deriveAmericano(points, target).matchOver) return points;
  return [...points, team];
}

/** The text shown in a team's point slot: a plain running count. */
export function americanoLabel(state, team) {
  return String(state.points[team]);
}
