# d10_padel

A padel scoreboard for a courtside Android phone, scored from a **D10 360 Action Camera
Remote** so players never have to touch the screen.

**Scoreboard:** <https://norom.github.io/d10_padel/>
**Button probe:** <https://norom.github.io/d10_padel/tools/d10-probe.html>

## Using it

Open the scoreboard in Chrome on the phone and add it to the home screen. It works offline
after the first load and remembers the match if it gets closed.

**Pairing the remote:** pair the D10 in Android Bluetooth settings, then tap **Remote** on the
scoreboard, tap a row, and press that button on the remote. Whatever the remote sends is bound
to that action — the app does not assume any particular key.

| Remote | Action |
| --- | --- |
| `A` | Point to Team A |
| `B` | Point to Team B |
| `S` | Undo |

The same four actions are on screen: **+ Team A**, **Undo**, **+ Team B**, and **New match**,
which asks before clearing the score.

## Why the buttons are bound rather than hardcoded

A BLE camera remote can reach a web page as an HID keyboard, as media keys, as a gamepad, or
not at all — Chrome on Android never delivers volume keys to a page, and camera remotes often
send exactly those. Rather than guess, the app listens on every channel at once and matches
what arrives against the bindings.

`tools/d10-probe.html` reports which channel each button lands on, and whether the press
reaches the browser at all. If it turns out nothing does, the fallback is a native Android app
using `KeyEvent` — the scoring engine moves across unchanged.

## Design

```
 keyboard │ media session │ gamepad │ text input │ touch      input adapters
 ─────────┴───────────────┴─────────┴────────────┴──────
                     ↓  POINT_A │ POINT_B │ UNDO
              match core  (pure, no DOM, no storage)
                     ↓
              ui render  +  localStorage
```

Match state is derived from the sequence of points alone. Undo drops the last point and
recomputes, so undo across game and set boundaries is correct by construction rather than by
unwinding special cases. Full design notes in
[`docs/superpowers/specs`](docs/superpowers/specs/2026-08-17-d10-padel-scoreboard-design.md).

The screen is the court seen from above: two colour fields split by the net. Which side the
big number is on identifies the team faster than a label can at ten metres. The scoring side
flashes on each point, which is how you confirm from across the court that the press landed.

## Scoring

Games of 0/15/30/40 with deuce and advantage, sets at six games with a two-game margin,
tie-break at six all won at seven by two, best of three. A decided match ignores further
points so a stray remote press cannot rewrite the result; undo still works.

## Development

```sh
npm test                      # 41 unit tests, no dependencies
python3 -m http.server 8137   # then open http://127.0.0.1:8137
node tools/make-icons.mjs     # regenerate app icons
```

No build step and no dependencies — the files are served as they are. Note the service worker
serves from cache first and refreshes in the background, so a change lands on the second
reload; unregister it in DevTools while developing.
