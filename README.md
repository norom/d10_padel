# d10_padel

A padel scoreboard for a courtside Android phone, scored from a **D10 360 Action Camera
Remote** so players never have to touch the screen.

- `A` → point to Team A
- `B` → point to Team B
- `S` → undo the last action

## Status

**Investigating.** Before any scoreboard is built we need to know what the D10's buttons
actually look like to an Android phone. A BLE camera remote can reach a web page through
several different input channels — or through none of them, if Android consumes the press
first (which is what happens with volume keys in Chrome).

`tools/d10-probe.html` answers that. It walks through pressing A, B and S while listening on
every channel a browser can reach, then reports which one caught each button.

**Run it:** <https://norom.github.io/d10_padel/tools/d10-probe.html>

Pair the D10 in Android Bluetooth settings, open that page in Chrome on the phone, tap
**Start probe**, press each button when prompted, then **Copy report**.

The outcome decides the build:

| Probe result | What gets built |
| --- | --- |
| All 3 buttons on one channel, distinguishable | Web app / PWA — the preferred outcome |
| Some buttons missing | Native Android app using `KeyEvent` |
| Nothing received at all | Native Android app |

## Planned architecture

The probe result only affects the input layer. Everything below it is the same either way:

```
keyboard │ media session │ gamepad │ touch      ← input adapters
─────────┴───────────────┴─────────┴──────
                  ↓  POINT_A │ POINT_B │ UNDO
          match core (pure, no DOM)
                  ↓
          render  +  localStorage
```

Match state is derived from the sequence of points alone, so undo is just dropping the last
point and recomputing — which makes undo across game and set boundaries correct by
construction rather than by special-casing.
