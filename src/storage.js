/**
 * Local persistence.
 *
 * Only the point list and the button bindings are stored — everything else on
 * the scoreboard is derived, so this stays small and cheap to write on every
 * point. Storage is treated as untrusted: a courtside phone that half-wrote a
 * value or has storage blocked must still show a working scoreboard.
 */

const KEY = "d10-padel";
const TEAMS = new Set(["A", "B"]);

export const EMPTY = Object.freeze({ points: [], bindings: {} });

function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    // Storage blocked or full. The match stays playable, it just will not
    // survive a restart — better than a scoreboard that throws mid-point.
    return false;
  }
}

function parse(raw) {
  if (!raw) return EMPTY;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY;
  }

  if (!data || typeof data !== "object") return EMPTY;

  const points =
    Array.isArray(data.points) && data.points.every((team) => TEAMS.has(team))
      ? data.points
      : [];

  const bindings =
    data.bindings && typeof data.bindings === "object" && !Array.isArray(data.bindings)
      ? data.bindings
      : {};

  return { points, bindings };
}

export function createStore(storage, key = KEY) {
  const read = () => parse(readRaw(storage, key));
  const write = (next) => writeRaw(storage, key, JSON.stringify(next));

  return {
    load() {
      return read();
    },

    savePoints(points) {
      write({ ...read(), points: [...points] });
    },

    saveBindings(bindings) {
      write({ ...read(), bindings });
    },

    clearMatch() {
      write({ ...read(), points: [] });
    },
  };
}
