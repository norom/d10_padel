# d10_padel

A padel scoreboard for a courtside Android phone, scored from a **D10 360 Action Camera
Remote** so players never have to touch the screen.

**Download the app:** [d10-padel-scoreboard.apk](https://github.com/norom/d10_padel/releases/download/v1.13/d10-padel-scoreboard.apk) — the version the remote can drive
**Scoreboard in a browser:** <https://norom.github.io/d10_padel/> — touch only, see below
**Button probe:** <https://norom.github.io/d10_padel/tools/d10-probe.html>

## Using it

Open the scoreboard in Chrome on the phone and add it to the home screen. It works offline
after the first load and remembers the match if it gets closed.

**Pairing the remote:** pair the D10 in Android Bluetooth settings, then tap **Remote** on the
scoreboard, tap a row, and press that button on the remote. Whatever the remote sends is bound
to that action — the app does not assume any particular key.

### The D10's buttons travel three different ways

The remote is really two devices in one, which is why its buttons behave so differently:

| Button | How it reaches the phone |
| --- | --- |
| `S` | An HID keyboard key — it sends **volume up** |
| `A`, `B` | Not keys at all. They speak the vendor's own BLE service (`0xCE80`), the private channel the camera app uses |

Chrome never delivers volume keys to a web page, and no browser can reach a vendor BLE service
on a device bonded as HID — which is why the scoreboard needs the Android app for any of it.

The app listens on all three routes: ordinary key events, the media-button session, and a GATT
subscription to `0xCE80`/`0xCE82` for A and B. Because the remote is already bonded, nothing is
scanned for, so the app asks for Bluetooth and never for location.

### The vendor protocol

The D10 speaks the **Insta360 remote protocol**. Its `0xCE80` service carries three
characteristics — `CE81` (write), `CE82` (notify), `CE83` (read) — and button presses are
published as notifications on `CE82`:

| Command | Bytes |
| --- | --- |
| Shutter | `fc ef fe 86 00 03 01 02 00` |
| Mode | `fc ef fe 86 00 03 01 01 00` |
| Screen toggle | `fc ef fe 86 00 03 01 00 00` |
| Power off | `fc ef fe 86 00 03 01 00 03` |

The app knows these, so a press shows as `Shutter button` rather than nine bytes of hex.
Anything unrecognised still shows its bytes, which is the interesting case when a different
remote turns up.

In this protocol the **remote is the GATT server** and the camera is the client that connects
and subscribes — which is exactly what the app does.

### Why A and B are unreachable

They are not. Reading the vendor service's own descriptors settles it:

```
ce81  ->  "Characteristic 3"     (write)
ce82  ->  "Characteristic 4"     (notify)
ce83  ->  "Characteristic 5"  holding  "CHAR5_VALUE"
```

Those are the untouched example strings from the chip SDK's sample GATT profile. A vendor
implementing a button protocol names these Command, Notify, Version — not `CHAR5_VALUE`. The
service shares UUIDs with the Insta360 protocol because both are built on the same SDK sample,
not because this remote speaks it.

So `0xCE80` here is boilerplate that was never wired up, which agrees with everything else
observed:

- nRF Connect subscribes to `CE82` successfully and sees nothing on any button
- The app subscribes successfully and sees nothing
- A and B produce no key event, no media button, and no unnamed scan code either

**A and B on this remote are not connected to anything a phone can reach.** That is firmware,
not something more code solves. The BLE support is kept anyway: it costs one permission, and it
would work immediately with a remote whose vendor service is real.

So the whole match is scored from `S`, by how many times it is pressed:

| Press `S` | Action |
| --- | --- |
| once | Point to Team A |
| twice | Point to Team B |
| three times | Undo |

The score itself stays still while you press. A badge below it counts the presses and names
what will happen — `●○○ Team A`, `●●○ Team B`, `●●● Undo` — and the score moves once, when
you stop. Four or more presses shows `✕ Cancelled` and changes nothing, so a fumble costs
nothing.

You have 0.8s between presses, and the badge answers each press immediately, so there is no
timing to guess at: press until the badge reads what you meant, then let go.

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

## Formats

**New match** offers a format, and choosing one is also the confirmation that clears the score:

| Format | How it scores |
| --- | --- |
| Tennis | Best of 3 sets, 15 / 30 / 40, as below |
| Americano to 21 | 21 points played, then the round ends |
| Americano to 24 | 24 points played, then the round ends |

**Americano** counts plain points — 1, 2, 3 — and the round ends when the two scores *add up*
to the target, so 24 is always 24 points played whether it finishes 16-8 or 13-11. Every player
gets the same number of points to play for, which is the point of the format. The higher score
wins; level at an even target is shown as a draw, because in Americano the points themselves
are the result rather than something to play off.

Sets and games are hidden in Americano, since it has neither. The remote works identically in
both formats.

## Tennis scoring

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
