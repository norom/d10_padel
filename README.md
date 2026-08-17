# d10_padel

A padel scoreboard for a courtside Android phone, scored from a **D10 360 Action Camera
Remote** so players never have to touch the screen.

**Download the app:** [d10-padel-scoreboard.apk](https://github.com/norom/d10_padel/releases/download/v1.2/d10-padel-scoreboard.apk) — the version the remote can drive
**Scoreboard in a browser:** <https://norom.github.io/d10_padel/> — touch only, see below
**Button probe:** <https://norom.github.io/d10_padel/tools/d10-probe.html>

## Using it

Open the scoreboard in Chrome on the phone and add it to the home screen. It works offline
after the first load and remembers the match if it gets closed.

**Pairing the remote:** pair the D10 in Android Bluetooth settings, then tap **Remote** on the
scoreboard, tap a row, and press that button on the remote. Whatever the remote sends is bound
to that action — the app does not assume any particular key.

### Only one D10 button reaches Android

On the unit this was built against, **`S` is the only button any app can hear.** It sends
volume up. `A` and `B` produce no Android input at all — not a key event, not a media button,
nothing — because they drive the camera over the vendor's own BLE service rather than acting as
a keyboard. No third-party app can receive them.

So the whole match is scored from `S`, by how many times it is pressed:

| Press `S` | Action |
| --- | --- |
| once | Point to Team A |
| twice | Point to Team B |
| three times | Undo |

The score moves on the very first press and each further press **corrects** it rather than
adding to it: press once and Team A scores immediately, press again and that point becomes
Team B's, press a third time and it becomes an undo. Four or more presses lands back exactly
where it started, so a fumble costs nothing.

Because nothing waits for a timer, the window between presses is a generous 1.2 seconds. There
is no timing to get right — keep pressing until the score reads what you meant.

Bind it under **Score everything with one button**. If you use a remote where separate buttons
do register, bind them under **Or one button per action** instead; both work.

The same four actions are on screen: **+ Team A**, **Undo**, **+ Team B**, and **New match**,
which asks before clearing the score.

## The remote needs the Android app

**The D10 sends volume keys.** Pressing `S` raises the phone's volume. Chrome on Android never
delivers volume keys to a web page — and it does not background the page either, so
`tools/d10-probe.html` recorded nothing at all on any channel rather than something suspicious.
Silence was the finding.

That rules out the browser for the remote, and Web Bluetooth with it, since the D10 is bonded
as an HID device and HID sits on the Web Bluetooth blocklist. An Android activity, unlike a
page, is offered every key before the system acts on it, so the remote works in the wrapper app
in [`android/`](android).

| | Browser (PWA) | Android app |
| --- | --- | --- |
| Touch controls | yes | yes |
| D10 remote | **no** — Chrome discards volume keys | **yes** |
| Offline | yes, after first load | yes, nothing is ever fetched |

The scoreboard is identical in both; the wrapper adds about a hundred lines whose only job is
to read the key and hand its code to the page.

## Why the buttons are bound rather than hardcoded

The app never assumes a key. It listens on every channel available — keyboard, media session,
gamepad, text input, and the native bridge — reduces each press to a comparable signature, and
matches that against the bindings you record. That is why the wrapper did not need anyone to
work out what A, B and S send: you press them and it binds whatever arrives.

## Building the Android app

```sh
cd android
ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 17 and an SDK with `platforms;android-34` and `build-tools;34.0.0`. The web app is
staged into the APK at build time from the repository root, so there is only ever one copy of
the scoreboard.

Install by copying the APK to the phone and opening it — Android will ask you to allow
installing from that source. The app requests **no permissions**.

While the scoreboard is on screen the remote's buttons are score buttons: volume keys are
consumed rather than passed to the system, so the volume does not move while you play. Back
still exits.

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
npm test                      # 49 unit tests, no dependencies
python3 -m http.server 8137   # then open http://127.0.0.1:8137
node tools/make-icons.mjs     # regenerate app icons
```

No build step and no dependencies — the files are served as they are. Note the service worker
serves from cache first and refreshes in the background, so a change lands on the second
reload; unregister it in DevTools while developing.
