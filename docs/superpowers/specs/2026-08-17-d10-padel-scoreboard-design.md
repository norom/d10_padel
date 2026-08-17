# D10 Padel Scoreboard — Design

**Date:** 2026-08-17
**Status:** Implemented. Probe answered — see "Probe outcome" below.
**Repo:** https://github.com/norom/d10_padel

## Probe outcome (2026-08-17)

The probe reported **nothing on any channel**, including no focus loss. That reading has
exactly one common cause besides a disconnected remote: a key Android consumes silently. It was
confirmed directly — pressing `S` raises the phone's volume.

So the D10 sends volume keys. Chrome never delivers those to a page and does not background the
page either, which is why every counter stayed at zero. Consequences:

- **Rung 1 (browser key events): dead.** No API exposes a volume key press to a page.
- **Rung 2 (Web Bluetooth): dead.** The device is bonded as HID, and HID is on the Web
  Bluetooth blocklist, so a page cannot claim it.
- **Rung 3 (native `KeyEvent`): works.** An activity is offered every key before the system
  acts on it, and can consume it.

The browser build remains the touch-only scoreboard. The remote is served by a WebView wrapper
in `android/` that forwards key codes into the same page. The prediction below — that only the
adapter layer would change — held: the scoring engine, storage, and UI moved across untouched,
and the runtime binding decision meant the wrapper never needed to know which codes A, B and S
produce.

## Problem

A padel match needs scoring without anyone walking to the phone. The phone sits courtside
showing the score in large type; a D10 360 Action Camera Remote clipped to the fence drives
it: `A` scores for Team A, `B` for Team B, `S` undoes.

## Constraint that shapes everything

We do not know what the D10's buttons look like to Android. A BLE camera remote may present
as an HID keyboard, as consumer-control media keys, as a gamepad, or its presses may be
consumed by Android before any page sees them. Chrome on Android never delivers volume keys
to a web page, so if `A` and `B` are volume up/down the web path is impossible.

`tools/d10-probe.html` (deployed to GitHub Pages) determines this empirically. Until it
reports back, the app must not depend on any particular answer.

**Resolution:** the app binds buttons at runtime rather than at build time. It listens on
every channel a browser can reach and matches incoming events against a stored binding table.
A binding screen captures whatever the remote actually sends. The probe result becomes a
default preset, not a hardcoded assumption — and a wrong guess costs the user one screen tap,
not a rebuild.

## Architecture

```
 keyboard │ media session │ gamepad │ text input │ touch      input adapters
 ─────────┴───────────────┴─────────┴────────────┴──────
                     ↓  POINT_A │ POINT_B │ UNDO
              match core  (pure, no DOM, no storage)
                     ↓
              ui render  +  localStorage persistence
```

Only the top layer depends on the probe. If the answer turns out to be "nothing reaches the
browser", the same core moves into a native Android WebView with a `dispatchKeyEvent` bridge
emitting the same three actions, and nothing below the adapter line changes.

### Modules

| File | Responsibility | Depends on |
| --- | --- | --- |
| `src/match.js` | Scoring rules. Pure functions over a point list. | nothing |
| `src/input.js` | Listens on all channels, matches events to bindings, emits actions. | nothing (DOM events only) |
| `src/storage.js` | Persist point list + bindings to localStorage. | nothing |
| `src/ui.js` | Render state to DOM, wire touch controls. | match, storage |
| `src/app.js` | Wire the three together. | all |
| `index.html` | Shell and styles. | — |
| `sw.js`, `manifest.webmanifest` | Offline + installability. | — |

Plain ES modules, no build step, no dependencies. Tests run on `node --test`.

## Match core: state is derived, never mutated

The entire match is a function of the sequence of points:

```js
state = derive(points, config)   // points is e.g. ['A','B','A','A', ...]
```

Adding a point appends; undo pops; both recompute. This is the central decision, and it makes
the hardest acceptance criterion — undo across game and set boundaries — correct by
construction. There is no prior state to restore because state was never stored: 5–4 / 40–15
is simply what the first *n* points recompute to.

It also makes persistence trivial (one small array of characters) and the engine exhaustively
testable as a pure function.

Cost: recomputation is O(n) per action, with n bounded by a few hundred points. Irrelevant.

### Rules

- Points within a game: 0, 15, 30, 40. Game at 4 points with a 2-point margin.
- At 3–3 or beyond: equal is **deuce**, one ahead is **advantage**, two ahead wins the game.
- Set at 6 games with a 2-game margin, so 6–4 and 7–5 are set wins, 6–5 is not.
- At 6–6 a **tie-break** is played: raw point counting from 0, won at 7 with a 2-point margin,
  recorded as a 7–6 set.
- Match is best of 3 sets — first side to 2 sets.

### Match completion

Not covered by the original brief; decided here. When a side wins its second set the match
**locks**: further `POINT_A`/`POINT_B` are ignored so a stray remote press cannot corrupt a
finished match. `UNDO` still works, and `New Match` still resets. The winner is displayed.

This is advantage scoring, not the golden point used by some padel leagues. Deliberate, per
the brief.

## Input

Each adapter reduces an event to a **signature** — a stable, comparable descriptor:

| Channel | Signature |
| --- | --- |
| keyboard | `key`, `code`, `keyCode` from `keydown` |
| media session | the action name (`play`, `nexttrack`, …) |
| gamepad | button index |
| text input | the character produced |

A binding table maps signature → action:

```js
{ POINT_A: <signature>, POINT_B: <signature>, UNDO: <signature> }
```

Stored in localStorage. The binding screen captures each in turn, reusing the probe's logic.
Repeat presses within 400 ms of the same signature are suppressed, because a remote button
held slightly long can emit twice.

The media-session channel needs an active media session to receive anything, which requires
audio to be playing. The app starts an inaudible looping tone on first user gesture, and only
if a media-session binding exists — no point holding an audio focus we never use.

## Screen

Dark scoreboard ground, both teams colour-differentiated so a glance from the far side of the
court resolves which column is which.

```
              TEAM A        TEAM B
   SETS          1             0
   GAMES         3             2

              40            15            ← dominant element
```

- Point score is the largest thing on screen, sized in viewport units so it fills the space in
  both orientations.
- Advantage shows as `AD` in the point slot.
- A tie-break shows a `TIE-BREAK` label and raw point numbers.
- Touch controls sit along the bottom edge: `+ Team A`, `Undo`, `+ Team B`, then `New Match`
  and settings. **Not** half-screen tap zones — the phone sits courtside where a bump would
  score a point.
- `New Match` requires confirmation.
- Screen Wake Lock keeps the display awake while a match is active; Fullscreen on first tap.

## Persistence

`localStorage` holds the point list, the config, and the bindings. Written on every action,
restored on load, so closing and reopening resumes the match exactly. No server, no accounts.

## Offline

A service worker precaches the whole app shell on install. After the first load the scoreboard
works with no network at all, and Chrome offers "Add to Home screen".

## Out of scope

Accounts, cloud sync, match history, statistics, player database, tournaments, watch app,
multiplayer, backend, GPS, ads.

## Acceptance

1. D10 connects to the phone. *(probe)*
2. `A` scores Team A. 3. `B` scores Team B. 4. `S` undoes.
5. Score updates immediately.
6. Game, set and tie-break scoring correct. *(unit tests)*
7. Undo correct across points, games and sets. *(unit tests)*
8. Readable from several metres.
9. Match survives restart. *(persistence)*
10. Works offline after first load. *(service worker)*

1–5 depend on the probe. 6–10 do not, and are verifiable now.
