# LUNA -> NI Kontrol Mk3

*A LUNA Add On for the Native Instruments Kontrol Mk3 keyboards — S49, S61 and S88.*

Full DAW-mode integration between UA LUNA and a Native Instruments Kontrol Mk3 keyboard
(S49, S61 or S88 — they speak one protocol and this add-on treats them alike):
the DAW and PLUG-IN buttons both light, the keyboard's screens show LUNA's mixer and the
selected channel's plugin chain, and the knobs, 4-D encoder and transport buttons drive the
session. On a track carrying Komplete Kontrol or Kontakt the plugin pages become the
instrument's own NKS screens while LUNA keeps the mixer.

This implements **NIHIA protocol v4**, the protocol the Mk3 speaks on its DAW port from
**firmware 2.0** onwards. Message numbers and the handshake sequence follow Native
Instruments' own FL Studio integration scripts, which are the reference implementation.

Everything runs inside LUNA. There is no helper process to start, nothing in your login
items, and nothing to remember.

## Requirements

| | |
|---|---|
| Keyboard | Kontrol **S49 / S61 / S88 Mk3**, **firmware 2.0 or later** |
| LUNA | **3.1.2 or later** |
| Add On SDK | `@uaudio/luna-builder-sdk` 3.1.2, Apache-2.0 — vendored here as `luna.global.js` |

Firmware 2.0 is not optional. Before it, the Mk3 had no DAW MIDI port at all and its
DAW mode was reachable only through NI's own background service. With 2.0 the keyboard
exposes a DAW port of its own — **`KONTROL S88 MK3 DAW`**, or `S61` / `S49` in place of `S88` —
and that is what this add-on talks to. It matches the port by shape, not by model, so any of
the three is found automatically.
If the add-on reports *"DAW port missing"* or *"keyboard answered v3"*, update the
firmware in Native Access and power-cycle the keyboard.

LUNA 3.1.2 is not optional either, and the reason is specific: nearly everything the
keyboard's screens show — every track name, dB readout, pan string, colour and the level
meters — travels as SysEx, and **LUNA could not send SysEx out of a MIDI port until
3.1.2**. On 3.1.1 and earlier every `sendSysExToOutput` answers `uasrv.invalid_property`,
and the surface gets as far as a handshake and lit buttons with blank screens.

## Install

Copy this folder into LUNA's Add Ons folder:

| | |
|---|---|
| macOS | `/Library/Application Support/Universal Audio/LUNA/Add Ons/` |
| Windows | `C:\\ProgramData\\Universal Audio\\LUNA\\Add Ons\\` |

Then restart LUNA. Nothing is built and nothing is installed from a package manager: the
SDK it needs is the vendored `luna.global.js`, and the rest is three files of plain
JavaScript.

### The SDK

`luna.global.js` is the LUNA Add On SDK, vendored unmodified so a clone runs as it stands.
Universal Audio publishes it as a Claude Code agent plugin, which is where to get a newer
one:

```
claude plugin install ua-luna-builder@luna-builder-sdk
```

That gives you the SDK, its types and docs, and the skills for building Add Ons against
it. To update this Add On to a newer SDK, replace `luna.global.js` with the `dist/`
build's copy and check `min_luna_version` in `manifest.json` still holds.

## Setup

1. In LUNA, open `Window → LUNA -> NI Kontrol Mk3`.
2. Press **DAW** on the keyboard.

That is all. The *Port* badge should name your keyboard's DAW port — `KONTROL S88 MK3 DAW`,
or the S61 / S49 spelling — and *DAW mode* should read
**connected (v4)**. If it says *no answer*, press **Re-handshake**.

The add-on picks the DAW port by name. If you have more than one Kontrol, choose it in the
Connection panel; the choice is remembered by name, because LUNA's MIDI device ids change
every time it restarts.

## DAW and PLUG-IN: both buttons live

The Mk3 has two sets of screens and a button for each. They are not two hosts competing
for the keyboard — they are two halves of one deep-integration session, and both light from
it. DAW shows LUNA's mixer; PLUG-IN shows the selected channel's plugin chain.

The keyboard lights PLUG-IN only once the DAW has told it there is a chain to show. A
surface that sends mixer messages and nothing else therefore gets exactly one live button,
and the only way to reach a plugin is to drop the connection and let NI's agent take the
keyboard — which puts the DAW button out. **Sending the chain is what makes both live at
once**, and that is what this add-on now does: `PLUGIN_CHAIN` (SysEx 0x71) carries the
plugin names NUL-separated, `SELECT_PLUGIN` (0x70) says which link is showing, and
`PARAM_NAME` / `PARAM_VALUE` / CC 0x70+n draw the eight parameters.

Switching is the keyboard's own business. It reports the switch as `BANK_MAPPING` (CC 5),
0 for the mixer pages and 1 for plugin pages, and the connection is untouched either way,
so pressing the other button comes straight back. What changes is only what gets sent:

| | sent on the mixer pages | sent on the plugin pages |
|---|---|---|
| Eight strips, meters, selection, MUTE/SOLO lamps | yes | **nothing** |
| Plugin chain, parameters, NKS focus | yes (so PLUG-IN can light) | yes |
| Transport lamps, tempo | yes | yes |

The strips go quiet on the plugin pages because the plugin screens are drawn over them, and
returning to the mixer redraws the whole bank from scratch rather than trusting what the
keyboard was last told. Measured over three round trips: **31 messages** entering the plugin
pages, **93** redrawing the mixer on return, every time, with the connection held throughout.

### Komplete Kontrol, Kontakt, Maschine and Reaktor

On a track carrying an NI instrument there is a second step, and it is what makes the
handoff feel like one instrument rather than two hosts. Every NI plugin publishes its NKS
instance id as a hidden parameter — Komplete Kontrol as `NIKB06`, Kontakt as `NIKT0018` —
and `FOCUS_FOLLOW` (SysEx 0x41) carries it to the keyboard. That is what lets the plugin
pages become the instrument's own NKS screens, for browsing and presets, while this add-on
keeps the mixer, the transport and the DAW button.

The add-on finds the id by reading the plugin's parameter list and matching `NI` plus two
letters. It only does this for plugins it recognises as Native Instruments', from the plugin
id (`com.-NI-.…`) or the name, because Kontakt reports some two thousand parameters and
reading them all for a UAD compressor would be waste.

Swapping a plugin is slower than it looks and the chain follows it carefully. Measured on a
Komplete Kontrol → Kontakt swap: LUNA's plugin id flips within a second, but the instance
id — and the new parameters with it — only three and a half seconds later. Reading on the
plugin id alone lands squarely in the window where the slot still holds the old plugin's
parameters, so the chain watches the instance id too and re-reads when it moves.

**Release to Komplete Kontrol** is still in the Connection panel, but it now means something
narrower: drop the connection entirely, so Komplete Kontrol can take the keyboard as if LUNA
were not running. The DAW button goes dark until you take it back (verified: zero messages
leave the page while released). You should not need it for ordinary plugin work.

NI's background services — `NIHostIntegrationAgent`, `NIHardwareConnectionService`,
`NTKDaemon` — are not an alternative route for an add-on. They talk over private Unix
sockets (`com.native-instruments.nks-connect`, `com.native-instruments.odr_agent.kks`) and
a local port of their own, in an undocumented protocol, and they are the *other* side of
this conversation: they serve Komplete Kontrol and NKS. The supported route for a
third-party host on the Mk3 is the `KONTROL S** MK3 DAW` MIDI port, which is what NI's own
FL Studio scripts use and what this add-on uses.

## The window: compact and expanded

The surface only runs while this window is open, so the window's resting state is a strip
**340 x 72 points** — a lamp, one line for the keyboard, one for the session, and an
**Expand** button. Expanded, it is the full page with a **Compact** button beside the title.

| | |
|---|---|
| Compact | 340 x 72, the manifest's opening size |
| Expanded | 1180 x 900, or whatever size you last left the expanded window |
| Remembered | the mode, and the expanded size, in `localStorage` |

LUNA resizes an Add On window through the page's own instance node —
`luna.gui.thisInstance()` gives an `AddOnInstance` with live `width`/`height` and a
`resize(w, h)`. The manifest's `min_width` and `min_height` are set to 280 x 60 because
LUNA clamps `resize()` to them as well as the user's drag; leave them at a comfortable
default and the compact size is clamped straight back up.

Three details worth keeping:

- The mode is applied by an inline script at the top of `<body>`, before the page's own
  scripts load. Deciding it in `app.js` would paint the full page first and snap to the
  strip a moment later, every time a compact window opens.
- A resize the user makes while expanded becomes what **Expand** returns to. Sizes within
  40 points of the compact strip are not recorded, so neither LUNA applying our own compact
  resize nor a user dragging the expanded window down to nothing can make Expand a no-op.
- The strip is redrawn from `setBadge`, which every status change in the page already goes
  through, so it is never stale when you expand or collapse.

Outside a `'window'` target — a browser panel, or this page opened in a plain browser —
`thisInstance()` gives nothing to resize. The layout still switches; only the window does
not follow.

## Running in the background, and at startup

The manifest sets **`run_hidden`**, without which LUNA slows a hidden page's timers to about
once a second and may suspend it — a control surface that stops the moment its window goes
behind LUNA's. With it the page runs at full speed whenever it is loaded, whether it is in
front, behind, minimized, hidden with the floating windows, or closed. Note that
`requestAnimationFrame` still stops while hidden, so nothing here is timed from it.

**`unload_on_close` is off**, which is LUNA's default and the whole point: closing the
window leaves the page loaded and running. The surface keeps the keyboard, the mixer keeps
updating and the plugin pages keep working with no window on screen at all. Only LUNA
quitting, or the Add On being disabled, takes it down.

**Starting with LUNA** needs no manifest key. This is not a `show_with_session` window, so
LUNA keeps its state in its own preferences and reopens it at launch if it was open when
LUNA quit — hiding the floating windows does not count as closing it. So the way to have
the surface up from startup is to leave the window open, which is what the compact strip is
for: 340 x 72 of screen, always there, and the keyboard live from the moment LUNA opens.

The trade-offs that come with the page staying loaded:

- **Closing the window no longer hands the keyboard back.** It used to, as a side effect of
  the page being torn down. Use **Release to Komplete Kontrol** in the expanded window, or
  press **DAW** on the keyboard.
- **`pagehide` is no longer the exit.** It still runs on a real unload — LUNA quitting, or
  the Reload button — but not on a close, which is what makes the surface survive one.
- **An edit to these files does not reach a window that is merely closed and reopened**,
  because LUNA never unloaded the page. The cache-busting loader in `index.html` only runs
  on a fresh load. That is what the **Reload page** button in the Connection panel is for:
  it re-enters the page with a new query parameter, so WebKit refetches `index.html` as well
  as the two scripts, and it keeps LUNA's own `add_on_inst` parameter — drop that and
  `thisInstance()` comes back empty and the window stops resizing.

## What the keyboard controls

| Control | Action |
|---|---|
| Knobs 1–8 | Volume of the eight channels in the current bank |
| Shift + knobs 1–8 | Pan |
| 4-D encoder left/right | Select previous / next channel, scrolling the bank to follow; LUNA selects it too |
| 4-D encoder up/down | Previous / next bank of eight |
| Bank arrows | Previous / next bank of eight |
| 4-D encoder turn (pushed or not) | Jog the playhead a beat at a time (while stopped) |
| Shift + 4-D encoder push | Record-arm the selected track |
| MUTE / SOLO | Mute or solo the channel under the button you press |
| Play / Stop / Rec / Loop | LUNA transport |
| Restart | Stop, return to the arrangement start, and roll |
| Metro | Mute or unmute LUNA's CLICK track |
| Undo / Redo | LUNA undo queue |

On the plugin pages:

| Control | Action |
|---|---|
| PLUG-IN | Show the selected channel's plugin chain; DAW goes back to the mixer |
| Knobs 1–8 | The eight parameters on the current page |
| Bank arrows | Previous / next page of eight parameters |
| Chain buttons | Pick a plugin in the chain |

The keyboard's displays show each channel's name, colour, volume in dB, pan as text, its
fader and pan positions, mute/solo/arm state, the level meters and the session tempo.
Channels appear in mixer order: tracks, then aux buses, with MAIN last.

The plugin chain is the selected channel's signal path as LUNA builds it: the instrument,
the channel's tape and console, then the insert slots. LUNA puts its console strip in the
effect slots as an *alias* — `effect_0` reports the plugin id `alias.console` and carries no
parameters of its own, because the real plugin lives in the `console` slot — so the chain
follows the alias rather than showing a link with a name and an empty parameter page.

A knob sweep is bracketed into a **single LUNA undo entry**, so one Undo reverses the
whole move rather than each tick.

## One selection

The keyboard's selection and LUNA's are the same selection. Moving it on the 4-D encoder
selects that track in the arrangement, and clicking a track in LUNA moves the keyboard to
it, scrolling the bank if the track is outside it. The add-on starts on whatever LUNA has
focused rather than on channel 1.

Only the track set moves: the time range, the selected playlists and the editor focus are
left alone, so a selection change from the keyboard cannot repoint an edit at material the
user was not looking at. Writing the selection makes no undo entry. An aux bus or MAIN has
no row in the arrangement, so selecting one moves the keyboard and leaves LUNA's selection
where it was.

The two directions settle rather than chase each other. LUNA echoes a selection write back
as a focus change, which would call straight back into the keyboard's selection; a "we are
writing" flag would already be down by the time that echo lands, so both directions compare
track uids instead and do nothing when they already agree.

## Record arm

NIHIA has no record-arm message — the protocol's button list stops at MUTE and SOLO — so
arming is reached from the one spare control: **SHIFT with the 4-D encoder's push**
(`ENCODER_BUTTON_SHIFT`, CC 97) arms the selected track.

Three other candidates were measured on the hardware and ruled out:

- **SHIFT + MUTE** never reaches a host. It is the keyboard's own solo gesture, and the
  firmware resolves it: holding SHIFT and pressing MUTE sends `SOLO` (CC 68), not `MUTE`
  (CC 67). Solo was therefore never at risk, and an arm bound there would be dead code.
- **The unshifted encoder push** (CC 96) is the opening message of push-and-turn, which
  this keyboard answers with `ENCODER_GENERAL` — the jog. Arming on it would arm a track
  every time the playhead was jogged that way. Measured gap between the push and the first
  turn: 398 ms, too close to tell a deliberate tap from the start of a jog.
- **A tap** cannot be read at all. The push arrives as one event with `d2 = 1` and there is
  no release message to tap on, which is why an earlier build bound to the release did
  nothing.

The keyboard already draws the state — `IS_ARMED` has been going out with the rest of each
strip since the first version — so an arm made in LUNA lights the keyboard and one made on
the keyboard lights LUNA. Aux buses and MAIN have no `recordEnabled` at all; asking for one
puts a line in the log rather than failing.

Arming is per selected track. To arm a track that is not selected, select it first — the
encoder moves LUNA's selection too, so that is one gesture, not two.

The keyboard already draws the state — `IS_ARMED` has been going out with the rest of each
strip since the first version — so an arm made in LUNA lights the keyboard and one made on
the keyboard lights LUNA. Aux buses and MAIN have no `recordEnabled` at all; asking for one
puts a line in the log rather than failing.

## Knob feel

The Mk3 reports knob movement as a high-resolution SysEx carrying a 14-bit delta, where a
full rotation is 8192 — and it reports it *only* that way, never as the per-knob CC the
protocol also defines. The delta is applied directly, so the knob's own acceleration curve
comes through: a slow turn sends ±8 per message, a fast one up to ±188. **Knob
sensitivity** in the Connection panel scales it; the setting is remembered.

The CC form is handled too, at 0.02 of full scale per detent, for any firmware that
prefers it.

## Pan on a stereo channel

A LUNA stereo channel has no single pan value. It carries a **pan_left** and a
**pan_right** position, which sit at -1 and +1 on a full-width channel. One knob cannot
express both, so the shifted knob moves the **balance**: it shifts both positions together
and shows their midpoint, and each side stops at its own end — so pushing a full-width
image towards one side narrows it rather than refusing to move. Aux buses and MAIN are
stereo, so this is what you will feel on them; mono tracks have a single pan and behave the
obvious way.

## Files

| file | what it is |
|---|---|
| `manifest.json` | the LUNA Add On manifest |
| `index.html` | markup and styling; loads the two scripts with a cache-busting query |
| `nihia.js` | the NIHIA v4 protocol: constants, message builders, codecs |
| `app.js` | the surface: handshake, mixer push, device events, LUNA glue |
| `luna.global.js` | the vendored LUNA Add On SDK |
| `bridge/` | the retired MIDI helper; see below |
| `LICENSE` | Apache License 2.0, which this Add On is released under |
| `NOTICE` | attribution for the vendored SDK and the protocol reference |

## Development

- `index.html?mock=1` runs against the SDK's mock engine, so the surface can be exercised
  with no session open and nothing to restore afterwards.
- `index.html?dev=1` puts the internals on `window.Kontrol` (`Surface`, `Link`, `Mix`, `Rack`,
  `onMidi`). The add-on runs in a web view with no console and no way in from outside, so
  without that hook the only way to exercise a message path — a mode switch, a plugin
  selection, a knob — is to perform it on the keyboard by hand. `Kontrol.onMidi` takes the same
  shape the SDK delivers, so anything the keyboard can send can be injected.
- LUNA's web view caches aggressively and has no reload button, so `index.html` loads
  `nihia.js` and `app.js` with a fresh query string each time. Since `unload_on_close` is
  off, closing and reopening the window no longer reloads the page: use **Reload page** in
  the Connection panel, which busts `index.html` too and keeps LUNA's `add_on_inst`.

## The retired bridge

`bridge/` holds a small CoreMIDI-to-WebSocket helper this add-on used to need, with its
manual launchers under `bridge/legacy/`. Nothing uses it now and nothing starts it.

It existed because LUNA's web view has no Web MIDI API (`navigator.requestMIDIAccess` is
undefined there, with no flag that enables it), so for a long time a page inside LUNA could
not reach MIDI at all. The SDK's `Luna.MidiInput`, `Luna.SendMidi` and `luna.midiDevices`
now reach the same devices LUNA's own MIDI settings list, which made the helper redundant
the moment LUNA 3.1.2 added SysEx output.

Keeping it is only for reference. Removing `bridge/` entirely breaks nothing.

## What is verified

Measured against a real S88 Mk3 and LUNA 3.1.2 (the S61 and S49 Mk3 speak the same protocol
with the same eight strips, so nothing below is model-specific), with the bridge stopped and no helper
process running:

- **Handshake.** `BF 01 04` out through `sendMidiToOutput`; the keyboard answers `BF 05 00`
  (bank mapping: mixer mode) and `BF 01 04` within about three milliseconds.
- **SysEx out.** A full v4 initialisation and an eight-strip bank — names, colours, volume
  and pan strings, fader and pan positions, arm/solo/mute/selection, tempo and the LEDs —
  **86 messages in 37 ms**, about 0.4 ms each.
- **SysEx in.** 560 `ADJUST_PARAM` messages from one knob sweep, every one well formed,
  none malformed and none from another manufacturer; the delta curve (±8, 16, 25, 33 … 156)
  matches what the same knob produced through the old bridge.
- **Both at once.** 974 knob messages in and 974 updates pushed back out, no errors.
- **Against a real session.** Mixer push including genuine stereo tracks and the stereo
  master, knob volume and pan, MUTE and SOLO by slot, solo dimming, transport, tempo, undo,
  release and re-engage.
- **Plugin pages.** A real chain built from a LUNA track — `Pocket Strings → Studer A800
  Tape Recorder → API Vision Channel Strip` — with the console's 51 parameters across seven
  pages. Picking a link, paging, and a knob: SysEx `ADJUST_PARAM` group 2 moved the API
  Vision's *235 Thresh* from -47.0 dB to -38.0 dB in LUNA and the new reading came back with
  the knob position.
- **Both buttons.** Three mixer → plugin → mixer round trips: 31 messages out and 93 back,
  identical each time, no `GOODBYE` and no handshake in between, zero strip traffic while
  the plugin pages were up.
- **NKS focus.** Komplete Kontrol reported `NIKB06` and Kontakt 8 `NIKT0018` through
  `FOCUS_FOLLOW`, read from the live plugins in LUNA, and a swap between the two settled on
  the right id and the right parameters.
- **One selection, both ways.** Moving the keyboard's selection wrote `selection_tracks` and
  `last_selected_track` and LUNA's focused track followed; a selection written by a second,
  separate LUNA client moved the keyboard's. One move each way produced exactly **one**
  focus notification — the two directions do not chase each other. Selecting MAIN moved the
  keyboard and left LUNA's selection untouched.
- **Record arm.** Arming and disarming the selected track, through the real dispatch, with
  MAIN — which has no `recordEnabled` — refused with a line in the log rather than an error.
- **Compact mode.** At 340 x 72 the lamp, both text lines and the Expand button lay out with
  nothing overflowing (dot 9, text 228 x 30, button 59 x 19) and long session names ellipse
  rather than wrap. Expand showed the whole page — badges, setup, transport, eight strips,
  the plugin-page mirror, the connection panel and the log — and Compact took it back to the
  strip alone. The mode survived a reload and was applied at the first paint, with no flash
  of the full page.
- **What the keyboard actually sends.** Captured listen-only from the DAW port while the
  surface held it: the encoder push is `CC 96 d2=1` with **no release**; SHIFT + push is
  `CC 97 d2=1`; push-and-turn is `CC 96` then a run of `CC 52` (jog), and `ENCODER_VOL_SEL`
  / `ENCODER_PAN_SEL` (CC 100/101) are never sent by this keyboard; SHIFT + MUTE arrives as
  `CC 68` (solo) and plain MUTE as `CC 67`, both carrying the bank slot in `d2`; QUANTIZE
  and AUTO are single events on CC 34 and 35.

The one thing bytes cannot prove is how the firmware draws them; confirming the eight
strips read correctly needs a person looking at the keyboard.

Other limits:

- Preset stepping with the preset arrows is not implemented. On an NI plugin that is the
  NKS client's job anyway; on anything else the arrows stay dark.
- A plugin's parameters are its own, in the plugin's order, eight to a page. There is no
  curated "first eight that matter" — LUNA does not publish one, and nor does the protocol.
- Arming is a toggle per track. There is no exclusive arm (arm this, disarm the rest) and
  no input-monitor control; the protocol has no button left that would not collide with
  something the keyboard already means by it.
- The keyboard's tempo encoder is read but not acted on. LUNA's tempo lives in the
  session's tempo map, so following a jog would write a tempo event rather than nudge a
  value; tempo travels one way, LUNA to the keyboard.

## Credit and licence

This Add On is released under the **Apache License 2.0**; see `LICENSE` and `NOTICE`.

The NIHIA v4 message numbers, handshake order and mixer semantics are derived from the
Komplete Kontrol scripts for FL Studio (MIT licensed, © 2021 Pablo Peral and
contributors). No code from them is included here; what is shared is the wire format.

`luna.global.js` is `@uaudio/luna-builder-sdk`, © Universal Audio, Inc., Apache-2.0,
vendored unmodified and available through `claude plugin install
ua-luna-builder@luna-builder-sdk`.

Kontrol, Komplete Kontrol, Kontakt, Maschine, Reaktor and NKS are trademarks of Native
Instruments GmbH; LUNA is a trademark of Universal Audio, Inc. This is an independent
Add On, not made by, endorsed by or affiliated with either company.
