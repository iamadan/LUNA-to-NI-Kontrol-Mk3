'use strict';
/* =====================================================================
 * NI Kontrol Mk3 → LUNA : NIHIA v4 DAW surface
 *
 * Drives the keyboard's DAW mode — the DAW button, the mixer screens, the
 * knobs, the 4-D encoder and the transport LEDs — against LUNA's mixer.
 *
 * MIDI goes through LUNA itself (`luna.midiDevices`, `Luna.MidiInput`,
 * `Luna.SendMidi`). There is no helper process: LUNA's web view has no Web MIDI
 * API, but the SDK's MIDI classes reach the same devices LUNA's MIDI settings
 * list, inside LUNA and in a browser alike. An earlier version of this add-on
 * relayed bytes through a bundled CoreMIDI-to-WebSocket helper because LUNA had
 * no way to send SysEx; `bridge/` is still on disk but nothing uses it.
 * ===================================================================== */

const {
  toSigned7, buildSysex, nulJoin, tempoToBytes, bytesToTempo, isNihiaSysex,
  NKS_FOCUS_ID,
} = NihiaCodec;

const BANK_SIZE = 8;
const GESTURE_IDLE_MS = 400;     // knob silence that closes a LUNA undo entry
const METER_INTERVAL_MS = 66;    // ~15 fps, only sent when values change

/* The step a knob's CC form moves per detent. The Mk3 does not use that form —
 * it reports knobs as a high-resolution SysEx, which carries its own scale — but
 * the reference integration defines it and some firmware may yet send it. */
const BASE_VOL_STEP = 0.02;
const BASE_PAN_STEP = 0.02;

/* The keyboard's DAW port. On macOS CoreMIDI names it "KONTROL S88 MK3 DAW",
 * with "S61" or "S49" in place of "S88" on the smaller Mk3 keyboards — all three
 * speak the same protocol, so the match is on shape rather than on model;
 * the Mk2 equivalent is "Komplete Kontrol DAW". A port without "DAW" in its name
 * is the ordinary MIDI port and will never answer the handshake. */
function scoreDawPort(name) {
  const n = String(name || '').toLowerCase();
  if (/kontrol/.test(n) && /\bdaw\b/.test(n)) return /mk3|s\d\d/.test(n) ? 3 : 2;
  if (/midiin2 \(kontrol/.test(n)) return 2;          // the Windows spelling
  if (/kontrol/.test(n)) return 1;                     // main port: the wrong one
  return 0;
}

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const logLines = [];
function log(msg) {
  logLines.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (logLines.length > 300) logLines.length = 300;
  const el = $('log');
  if (el) el.textContent = logLines.join('\n');
}
/* A single line naming exactly where the surface has got to. The add-on runs in
 * LUNA's web view, where there is no console to open and no way to inspect it
 * from outside, so the page has to say what it knows. */
const Diag = {
  state: 'starting',
  detail: '',
  set(state, detail) {
    this.state = state;
    this.detail = detail || '';
    const el = $('diag');
    if (el) el.textContent = `${state}${this.detail ? ' — ' + this.detail : ''}`;
  },
};

function setBadge(el, label, text, ok) {
  if (!el) return;
  el.textContent = '';
  el.append(`${label}: `);
  const b = document.createElement('b');
  b.textContent = text;
  el.append(b);
  el.className = 'badge ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
  // Every status change in the page goes through here, so this is the one place
  // the compact strip has to be redrawn from.
  UI.paintCompact();
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

/* =====================================================================
 * The window's two sizes
 *
 * The integration only runs while this window is open, so its resting state is
 * a strip the size of one line of text that says whether the keyboard is
 * connected, and the full page is somewhere to go when something needs looking
 * at. LUNA resizes an Add On window through its own instance node; the manifest
 * minimums have to be small enough to let the compact size through, since LUNA
 * clamps resize() to them.
 * ===================================================================== */
const Win = {
  COMPACT: { w: 340, h: 72 },
  me: null,                 // this page's AddOnInstance, null outside LUNA
  mode: store.get('kontrol.winmode') === 'full' ? 'full' : 'compact',
  // What Expand goes back to: the manifest's full size until the user resizes.
  full: {
    w: Number(store.get('kontrol.winw')) || 1180,
    h: Number(store.get('kontrol.winh')) || 900,
  },

  applyClass() { document.body.classList.toggle('compact', this.mode === 'compact'); },

  async attach() {
    try {
      this.me = (luna.gui && (await luna.gui.thisInstance())) || null;
    } catch (e) {
      this.me = null;
      log(`window size unavailable: ${e.code || e.message || e}`);
    }
    if (!this.me || this.me.target.value !== 'window') {
      // A browser panel, an editor panel or a plain browser tab: the layout
      // still switches, there is just no window to resize with it.
      this.me = null;
      this.applyClass();
      return;
    }
    // A resize the user makes while expanded is what Expand should return to.
    // Sizes near the compact strip are not recorded: those are LUNA applying
    // our own compact resize, or a user dragging the expanded window down to
    // nothing, and either one would make Expand a no-op afterwards.
    const remember = () => {
      if (this.mode !== 'full') return;
      const w = this.me.width.value, h = this.me.height.value;
      if (!(w > this.COMPACT.w + 40 && h > this.COMPACT.h + 40)) return;
      this.full = { w, h };
      store.set('kontrol.winw', String(w));
      store.set('kontrol.winh', String(h));
    };
    this.me.width.onChange(remember);
    this.me.height.onChange(remember);
    this.applyClass();
    await this.push();
  },

  async set(mode) {
    this.mode = mode === 'full' ? 'full' : 'compact';
    store.set('kontrol.winmode', this.mode);
    this.applyClass();
    UI.paintCompact();
    await this.push();
  },
  toggle() { return this.set(this.mode === 'compact' ? 'full' : 'compact'); },

  async push() {
    if (!this.me) return;
    const want = this.mode === 'compact' ? this.COMPACT : this.full;
    try { await this.me.resize(want.w, want.h); }
    catch (e) { log(`could not resize the window: ${e.code || e.message || e}`); }
  },
};

/* LUNA gives a channel's colour as an ARGB integer; the keyboard wants "#RRGGBB". */
function colorHex(argb) {
  if (typeof argb !== 'number' || !Number.isFinite(argb)) return null;
  return `#${((argb >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()}`;
}

/* =====================================================================
 * Sending
 *
 * Every send is a round trip to LUNA, and NIHIA cares about order: a slot's
 * EXIST has to land before its name, and a bank redraw is some ninety messages
 * in a row. Firing them off in parallel would let them arrive shuffled and would
 * leave rejected promises unhandled, so they go through one chain. Measured at
 * about 0.4 ms each, which is far faster than the surface needs.
 * ===================================================================== */
const Out = {
  chain: Promise.resolve(),
  queued: 0,
  failures: 0,

  push(fn) {
    this.queued++;
    this.chain = this.chain
      .then(fn)
      .catch((e) => {
        this.failures++;
        if (this.failures <= 3) log(`MIDI send failed: ${e.code || e.message || e}`);
      })
      .then(() => { this.queued--; });
    return this.chain;
  },

  idle() { return this.chain; },
};

/* =====================================================================
 * The MIDI link: LUNA's own devices
 * ===================================================================== */
const Link = {
  input: null,          // Luna.MidiInput
  sender: null,         // Luna.SendMidi
  device: null,         // the Mk3's DAW port
  deviceName: null,     // chosen by name: LUNA's device uids change on restart
  stopListening: null,
  _offDevices: null,

  get ready() { return !!this.device; },

  async start() {
    this.input = new Luna.MidiInput(luna);
    this.sender = new Luna.SendMidi(luna);
    await luna.midiDevices.load();
    this._offDevices = luna.midiDevices.onChange(() => this.rescan());
    this.rescan();
  },

  /* Device uids are not stable across a LUNA restart, so the port is always
   * looked up by name — the manual choice is remembered as a name too. */
  rescan() {
    const devices = luna.midiDevices.items.filter((d) => d.outputPort && d.inputPort);
    let pick = null;
    if (this.deviceName) pick = devices.find((d) => d.name.value === this.deviceName) || null;
    if (!pick) {
      let best = 1;
      for (const d of devices) {
        const s = scoreDawPort(d.name.value);
        if (s > best) { best = s; pick = d; }
      }
    }
    UI.paintDevices(devices);

    const name = pick ? pick.name.value : null;
    const had = this.device;
    if (pick && had && pick.name.value === had.name.value && pick === had) return;

    this.detach();
    this.device = pick;
    if (!pick) {
      const anyKontrol = luna.midiDevices.items.some((d) => /kontrol/i.test(d.name.value || ''));
      setBadge($('portStatus'), 'Port',
        anyKontrol ? 'Kontrol found, but no DAW port' : 'no Kontrol keyboard', false);
      setBadge($('dawStatus'), 'DAW mode',
        anyKontrol ? 'DAW port missing — needs firmware 2.0' : 'waiting for the keyboard', false);
      return;
    }

    setBadge($('portStatus'), 'Port', name, true);
    log(`using MIDI device "${name}"`);

    // One listener carries channel messages and whole SysEx together, in order.
    this.stopListening = this.input.listen(pick, (m) => onMidi(m), { sysex: true, onGap: (info) => {
      log(`MIDI gap: ${info.missed || 0} batches missed, ${info.dropped || 0} dropped`);
    } });

    Surface.startHandshake();
  },

  detach() {
    if (this.stopListening) { try { this.stopListening(); } catch (e) {} this.stopListening = null; }
    this.device = null;
    Surface.onLinkLost();
  },

  choose(name) {
    this.deviceName = name || null;
    store.set('kontrol.device', this.deviceName || '');
    this.device = null;         // force a rebind even if the name resolves to the same node
    this.rescan();
  },

  cc(d1, d2) {
    const dev = this.device;
    if (!dev) return;
    Out.push(() => this.sender.sendMidiToOutput(dev, 0xBF, d1 & 0x7F, d2 & 0x7F));
  },

  sysex(bytes) {
    const dev = this.device;
    if (!dev) return;
    Out.push(() => this.sender.sendSysExToOutput(dev, bytes));
  },
};

/* =====================================================================
 * The surface: handshake, device state, everything sent to the keyboard
 * ===================================================================== */
const Surface = {
  protocol: 0,            // 0 until the keyboard answers the handshake
  engaged: true,          // false once the keyboard has been handed to another host
  shift: false,
  bankMode: NIHIA.BANK_MODE_MIXER,
  helloTimer: null,
  helloAttempts: 0,
  slots: Array.from({ length: BANK_SIZE }, () => ({})),
  lastMeters: null,
  lastTempo: null,
  lights: {},

  cc(d1, d2) { if (this.engaged) Link.cc(d1, d2); },
  sysex(id, value, index, data) { if (this.engaged) Link.sysex(buildSysex(id, value, index, data)); },

  get connected() { return this.engaged && this.protocol >= NIHIA.PROTOCOL_V4; },

  /* The keyboard's screens are showing a plugin, not the mixer. Nothing this
   * surface draws is visible, and the traffic only competes with whatever owns
   * the plugin pages — Komplete Kontrol, usually. */
  get mixerVisible() { return this.connected && this.bankMode === NIHIA.BANK_MODE_MIXER; },

  /* ---- handshake ---- */
  startHandshake() {
    if (!Link.ready || !this.engaged) return;
    this.protocol = 0;
    this.helloAttempts = 0;
    this.resetCache();
    setBadge($('dawStatus'), 'DAW mode', 'handshaking…', undefined);
    this._hello();
  },
  _hello() {
    if (this.connected) return;
    this.helloAttempts++;
    log(`hello → protocol v${NIHIA.PROTOCOL_V4} (attempt ${this.helloAttempts})`);
    this.cc(NIHIA.CC.HELLO, NIHIA.PROTOCOL_V4);
    clearTimeout(this.helloTimer);
    // The keyboard answers within milliseconds when it is in DAW mode; retry a
    // few times in case it was still enumerating, then say so plainly.
    this.helloTimer = setTimeout(() => {
      if (this.connected) return;
      if (this.helloAttempts < 5) this._hello();
      else {
        setBadge($('dawStatus'), 'DAW mode', 'no answer from keyboard', false);
        log('No handshake reply. Check the DAW port and that the firmware is 2.0 or later.');
      }
    }, 1200);
  },

  onHelloAck(version) {
    clearTimeout(this.helloTimer);
    this.protocol = version;
    log(`keyboard acknowledged protocol v${version}`);
    if (version < NIHIA.PROTOCOL_V4) {
      setBadge($('dawStatus'), 'DAW mode', `v${version} only — needs firmware 2.0`, false);
      return;
    }
    setBadge($('dawStatus'), 'DAW mode', `connected (v${version})`, true);

    // v4 initialisation, in the order the reference integration uses.
    this.cc(NIHIA.CC.USE_SYSEX_PARAM, 1);
    this.sysex(NIHIA.SX.DAW_IDENTITY, 21, 0, 'LUNA');
    this.sysex(NIHIA.SX.SURFACE_CONFIG, 0, 0, 'track_orientation');

    // Buttons this surface does not implement are explicitly dark, so the
    // keyboard does not keep whatever the previous host lit. TEMPO stays on:
    // the tempo readout belongs to it and this surface does report the tempo.
    this.cc(NIHIA.CC.TEMPO, 1);
    for (const dark of ['COUNT_IN', 'CLEAR', 'QUANTIZE', 'AUTO']) this.cc(NIHIA.CC[dark], 0);

    this.resetCache();
    this.pushAll();
    // An idle LUNA meter emits nothing, so without this the keyboard would keep
    // showing whatever the previous host left on its meters.
    this.sysex(NIHIA.SX.PEAK, 2, 0, new Array(BANK_SIZE * 2).fill(0));
    this.lastMeters = new Array(BANK_SIZE * 2).fill(0);
    // The plugin pages are part of the initialisation, not an afterthought: the
    // PLUG-IN button is lit by the chain arriving, so a surface that never sends
    // one leaves that button dark however well the mixer works.
    Rack.rebuild('handshake');
    UI.paintEngage();
  },

  goodbye() {
    if (this.protocol && this.engaged) this.cc(NIHIA.CC.GOODBYE, 1);
    this.protocol = 0;
  },

  onLinkLost() {
    clearTimeout(this.helloTimer);
    this.protocol = 0;
    this.resetCache();
    if (this.engaged) setBadge($('dawStatus'), 'DAW mode', 'keyboard not connected', false);
  },

  /* ---- handing the keyboard over ----
   * Deep integration is exclusive in practice: while this surface holds it the
   * keyboard answers to LUNA, and Komplete Kontrol cannot drive its screens for
   * browsing instruments. Releasing sends the protocol's goodbye and then stays
   * quiet, so the keyboard is free until the user asks for it back. */
  release() {
    if (!this.engaged) return;
    this.cc(NIHIA.CC.GOODBYE, 1);      // still engaged, so this one goes out
    this.engaged = false;
    this.protocol = 0;
    clearTimeout(this.helloTimer);
    this.resetCache();
    setBadge($('dawStatus'), 'DAW mode', 'released — keyboard is free', undefined);
    log('Released the keyboard. Komplete Kontrol can take it now.');
    UI.paintEngage();
  },
  engage() {
    if (this.engaged) return;
    this.engaged = true;
    log('Taking the keyboard back.');
    UI.paintEngage();
    this.startHandshake();
  },

  /* Forget what the keyboard has been told about the eight slots. All a bank
   * change needs. */
  resetSlots() {
    this.slots = Array.from({ length: BANK_SIZE }, () => ({}));
    this.lastMeters = null;
  },
  /* Forget everything, tempo and button LEDs included. Only right after a
   * handshake, where the keyboard's state is genuinely unknown — a bank change
   * must not use this, or it drops the tempo cache with nothing left to re-send it. */
  resetCache() {
    this.resetSlots();
    this.lastTempo = null;
    this.lights = {};
  },

  /* ---- button LEDs ---- */
  light(name, mode) {
    const id = NIHIA.CC[name];
    if (id === undefined) return;
    if (this.lights[name] === mode) return;
    this.lights[name] = mode;
    this.cc(id, mode);
  },

  /* ---- per-slot mixer state ----
   * Each setter is a no-op when the value has not moved: the keyboard redraws on
   * every message and LUNA's subscriptions are chatty. */
  setSlot(i, key, value, send) {
    // Everything below draws on the eight strips. While the keyboard is showing
    // plugin pages none of it is visible and all of it competes with whoever owns
    // those pages, so it is not sent — and not cached either, so that returning to
    // the mixer redraws from scratch rather than believing the keyboard already
    // knows. Returning to mixer mode clears the cache and pushes the lot.
    if (!this.mixerVisible) return;
    const cache = this.slots[i];
    if (cache[key] === value) return;
    cache[key] = value;
    send();
  },
  slotExist(i, type) { this.setSlot(i, 'exist', type, () => this.sysex(NIHIA.SX.EXIST, type, i)); },
  slotName(i, name) { this.setSlot(i, 'name', name, () => this.sysex(NIHIA.SX.NAME, 0, i, name)); },
  slotVolumeText(i, t) { this.setSlot(i, 'volText', t, () => this.sysex(NIHIA.SX.VOLUME, 0, i, t)); },
  slotPanText(i, t) { this.setSlot(i, 'panText', t, () => this.sysex(NIHIA.SX.PAN, 0, i, t)); },
  slotVolumeGraph(i, normalized) {
    const v = clamp(Math.round((normalized || 0) * 127), 0, 127);
    this.setSlot(i, 'volGraph', v, () => this.cc(NIHIA.CC.VOL_GRAPH + i, v));
  },
  slotPanGraph(i, real) {
    // -1..1 to 0..127 with a hard centre at 64, as the reference does it.
    const p = real ?? 0;
    const v = clamp(p < 0 ? Math.trunc(64 - Math.abs(p) * 64)
                  : p > 0 ? Math.trunc(64 + p * 63)
                  : 64, 0, 127);
    this.setSlot(i, 'panGraph', v, () => this.cc(NIHIA.CC.PAN_GRAPH + i, v));
  },
  slotFlag(i, key, sxId, on) {
    this.setSlot(i, key, !!on, () => this.sysex(sxId, on ? 1 : 0, i));
  },
  slotColor(i, hex) {
    if (!hex || !/^#[0-9A-F]{6}$/.test(hex)) return;
    this.setSlot(i, 'color', hex, () => this.sysex(NIHIA.SX.TRACK_COLOR, 0, i, hex));
  },

  clearSlot(i) {
    this.slotExist(i, NIHIA.TRACK_TYPE.EMPTY);
    this.slotName(i, '');
    this.slotVolumeText(i, ' ');
    this.slotPanText(i, ' ');
    this.slotVolumeGraph(i, 0);
    this.slotPanGraph(i, 0);          // 0 is centre, not hard left
    this.slotFlag(i, 'mute', NIHIA.SX.IS_MUTE, false);
    this.slotFlag(i, 'solo', NIHIA.SX.IS_SOLO, false);
    this.slotFlag(i, 'armed', NIHIA.SX.IS_ARMED, false);
    this.slotFlag(i, 'selected', NIHIA.SX.SELECTED, false);
    this.slotFlag(i, 'mutedBySolo', NIHIA.SX.MUTED_BY_SOLO, false);
  },

  /* The keyboard is the only screen the user is looking at while playing, so a
   * surface with nothing to show says why on the first strip rather than going
   * blank and looking broken. */
  showNotice(text) {
    if (!this.connected) return;
    this.slotExist(0, NIHIA.TRACK_TYPE.GENERIC);
    this.slotName(0, text);
    this.slotVolumeText(0, ' ');
    this.slotPanText(0, ' ');
  },

  pushMeters(values) {
    if (!this.mixerVisible) return;
    if (this.lastMeters && values.every((v, i) => v === this.lastMeters[i])) return;
    this.lastMeters = values.slice();
    this.sysex(NIHIA.SX.PEAK, 2, 0, values);
  },

  pushTempo(bpm) {
    if (!this.connected || !bpm) return;
    const rounded = Math.round(bpm * 10) / 10;
    if (rounded === this.lastTempo) return;
    this.lastTempo = rounded;
    this.sysex(NIHIA.SX.TEMPO, 0, 0, tempoToBytes(rounded));
  },

  /* navigation LEDs: bit 0 = previous available, bit 1 = next */
  pushNavLights() {
    if (!this.connected) return;
    const total = Mix.channels().length;
    const prevBank = Mix.bankStart > 0;
    const nextBank = Mix.bankStart + BANK_SIZE < total;
    if (this.bankMode === NIHIA.BANK_MODE_MIXER) {
      this.light('NAV_BANKS', (prevBank ? 1 : 0) | (nextBank ? 2 : 0));
    }
    const abs = Mix.selectedAbsolute();
    this.light('ENCODER_X', (abs > 0 ? 1 : 0) | (abs < total - 1 ? 2 : 0));
    this.light('ENCODER_Y', (prevBank ? 1 : 0) | (nextBank ? 2 : 0));
  },

  pushAll() {
    if (!this.connected) return;
    Mix.pushBank(true);
    Transport.pushLights();
    this.pushNavLights();
    if (knownBpm) this.pushTempo(knownBpm);
  },
};

/* =====================================================================
 * LUNA side
 * ===================================================================== */
let luna = null;
let session = null;
let undoWorks = true;
let sensitivity = Number(store.get('kontrol.sens')) || 1;
let knownBpm = 0;

const gestures = new Map();      // Control -> idle timer

/* A knob sweep is bracketed into one LUNA undo entry: touch on the first tick,
 * release once the knob has been still for a moment. */
function knobTick(control, apply) {
  if (!control) return;
  if (!gestures.has(control)) { try { control.begin(); } catch (e) {} }
  else clearTimeout(gestures.get(control));
  apply();
  gestures.set(control, setTimeout(() => {
    gestures.delete(control);
    try { control.end(); } catch (e) {}
  }, GESTURE_IDLE_MS));
}

const Mix = {
  bankStart: 0,
  selectedOffset: 0,
  _cache: null,
  strips: [],

  /* Mixer order: tracks, then aux buses, with MAIN last. visibleTracks already
   * leaves out LUNA's own click and count-in tracks. */
  channels() {
    if (!session) return [];
    if (this._cache) return this._cache;
    const tracks = session.visibleTracks || [];
    const master = session.master;
    const buses = (session.buses.items || []).filter(
      (b) => b !== master && !b.isFolder && b.busType.value === 'aux');
    this._cache = [...tracks, ...buses, ...(master ? [master] : [])];
    return this._cache;
  },
  invalidate() { this._cache = null; },
  at(offset) { return this.channels()[this.bankStart + offset]; },
  selected() { return this.at(this.selectedOffset); },
  selectedAbsolute() { return this.bankStart + this.selectedOffset; },

  clickTrack() {
    if (!session) return null;
    return session.tracks.items.find((t) => t.trackType.value === 'click') || null;
  },

  soloOf(ch) { return ch && ch.solo ? ch.solo : null; },
  armOf(ch) { return ch && ch.recordEnabled ? ch.recordEnabled : null; },

  /* A LUNA stereo channel has no single pan value: it carries a pan_left and a
   * pan_right position, which sit at -1 and +1 on a full-width channel. Reading
   * one alone would report every stereo track as hard left. What one knob can
   * sensibly mean here is the balance, the midpoint of the two. */
  pans(ch) { return (ch && ch.main && ch.main.pans) || []; },
  panPosition(ch) {
    const cs = this.pans(ch);
    if (!cs.length) return 0;
    if (cs.length < 2) return Number(cs[0].real.value) || 0;
    return ((Number(cs[0].real.value) || 0) + (Number(cs[1].real.value) || 0)) / 2;
  },
  panText(ch) {
    const v = this.panPosition(ch);
    if (v > -0.005 && v < 0.005) return 'Centered';
    return `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'Right' : 'Left'}`;
  },
  /* LUNA's gain readout is "+1.5", "-6.0" or "-∞". The keyboard's display is
   * 7-bit ASCII, so the infinity sign would arrive as "?". */
  volText(ch) {
    const s = String(ch.gain.display.value ?? '');
    return `${s.replace(/[−-]?∞/, '-inf')} dB`;
  },

  /* A channel's gain, pan and mute live on its main output, which the SDK reads
   * separately from the channel node. Nothing can be drawn until that lands. */
  async loadStrips() {
    const chans = this.channels();
    const results = await Promise.allSettled(chans.map((c) => c.loadStrip()));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) log(`${failed} of ${chans.length} strips could not be read`);
  },

  /* Rebuild LUNA subscriptions for the visible bank and push it to the device. */
  pushBank(force) {
    for (const s of this.strips) s.offs.forEach((off) => { try { off(); } catch (e) {} });
    this.strips = [];
    const chans = this.channels();
    if (force) Surface.resetSlots();

    for (let i = 0; i < BANK_SIZE; i++) {
      const ch = chans[this.bankStart + i];
      if (!ch) { Surface.clearSlot(i); this.strips.push({ ch: null, offs: [] }); continue; }

      // The reference integration reports every track as GENERIC, master
      // included; that is the combination the firmware is known to render.
      Surface.slotExist(i, NIHIA.TRACK_TYPE.GENERIC);
      this.pushSlot(i, ch);

      const solo = this.soloOf(ch);
      const arm = this.armOf(ch);
      const offs = [
        ch.name.onChange(() => { Surface.slotName(i, ch.name.value || ''); UI.paint(i); }),
        ch.color.onChange(() => { Surface.slotColor(i, colorHex(ch.color.value)); UI.paint(i); }),
        ch.gain.normalized.onChange(() => { Surface.slotVolumeGraph(i, ch.gain.normalized.value); UI.paint(i); }),
        ch.gain.display.onChange(() => { Surface.slotVolumeText(i, this.volText(ch)); UI.paint(i); }),
        // Both sides of a stereo pan move the balance, so both have to be watched.
        ...this.pans(ch).map((ctl) => ctl.real.onChange(() => {
          Surface.slotPanGraph(i, this.panPosition(ch));
          Surface.slotPanText(i, this.panText(ch));
          UI.paint(i);
        })),
        ch.mute.real.onChange(() => {
          Surface.slotFlag(i, 'mute', NIHIA.SX.IS_MUTE, ch.mute.on);
          if (i === this.selectedOffset) Surface.light('MUTE_SELECTED', ch.mute.on ? 1 : 0);
          UI.paint(i);
        }),
        ...(solo ? [solo.real.onChange(() => {
          Surface.slotFlag(i, 'solo', NIHIA.SX.IS_SOLO, solo.on);
          if (i === this.selectedOffset) Surface.light('SOLO_SELECTED', solo.on ? 1 : 0);
          // One solo dims every other track, so the whole bank's dimming changes.
          this.pushMutedBySolo();
          UI.paint(i);
        })] : []),
        ...(arm ? [arm.onChange(() => {
          Surface.slotFlag(i, 'armed', NIHIA.SX.IS_ARMED, arm.value);
          UI.paint(i);
        })] : []),
        ch.meter.level.onChange(() => Meters.schedule()),
      ];
      this.strips.push({ ch, offs });
    }
    this.pushSelection();
    this.pushMutedBySolo();
    Surface.pushNavLights();
  },

  pushSlot(i, ch) {
    const solo = this.soloOf(ch);
    const arm = this.armOf(ch);
    Surface.slotName(i, ch.name.value || '');
    Surface.slotColor(i, colorHex(ch.color.value));
    Surface.slotVolumeText(i, this.volText(ch));
    Surface.slotVolumeGraph(i, ch.gain.normalized.value);
    Surface.slotPanText(i, this.panText(ch));
    Surface.slotPanGraph(i, this.panPosition(ch));
    Surface.slotFlag(i, 'mute', NIHIA.SX.IS_MUTE, ch.mute.on);
    Surface.slotFlag(i, 'solo', NIHIA.SX.IS_SOLO, solo ? solo.on : false);
    Surface.slotFlag(i, 'armed', NIHIA.SX.IS_ARMED, arm ? !!arm.value : false);
  },

  /* The keyboard dims a channel that a solo elsewhere has silenced, which is a
   * separate flag from its own mute. Only tracks dim: an aux bus still carries
   * whatever feeds it, and MAIN is where the solo comes out, so dimming either
   * would be a lie. */
  pushMutedBySolo() {
    const anySolo = this.channels().some((c) => { const s = this.soloOf(c); return s && s.on; });
    for (let i = 0; i < BANK_SIZE; i++) {
      const ch = this.at(i);
      const solo = this.soloOf(ch);
      const isTrack = !!ch && !!ch.trackType;
      Surface.slotFlag(i, 'mutedBySolo', NIHIA.SX.MUTED_BY_SOLO,
        !!ch && anySolo && isTrack && !(solo && solo.on));
    }
  },

  pushSelection() {
    for (let i = 0; i < BANK_SIZE; i++) {
      Surface.slotFlag(i, 'selected', NIHIA.SX.SELECTED, i === this.selectedOffset && !!this.at(i));
    }
    const ch = this.selected();
    const solo = this.soloOf(ch);
    // The selection and the MUTE/SOLO button lamps belong to the mixer pages too.
    if (Surface.mixerVisible) {
      Surface.cc(NIHIA.CC.SELECTED_AVAILABLE, ch ? NIHIA.TRACK_TYPE.GENERIC : NIHIA.TRACK_TYPE.EMPTY);
      Surface.light('MUTE_SELECTED', ch && ch.mute.on ? 1 : 0);
      Surface.light('SOLO_SELECTED', solo && solo.on ? 1 : 0);
    }
    // The plugin pages follow the selected channel. Unlike the strips they are
    // sent in both modes: the chain is what lights the PLUG-IN button, so it has
    // to be there before the user presses it.
    if (Rack.channel !== ch) Rack.rebuild('selection moved');
    UI.rebuild();
  },

  selectAbsolute(abs) {
    const chans = this.channels();
    if (!chans.length) return;
    const target = clamp(abs, 0, chans.length - 1);
    const maxStart = Math.max(0, chans.length - BANK_SIZE);
    let newStart = this.bankStart;
    if (target < newStart) newStart = target;
    else if (target >= newStart + BANK_SIZE) newStart = target - BANK_SIZE + 1;
    newStart = clamp(newStart, 0, maxStart);
    if (newStart !== this.bankStart) {
      this.bankStart = newStart;
      this.selectedOffset = target - newStart;
      this.pushBank(false);
    } else {
      this.selectedOffset = target - newStart;
      this.pushSelection();
      Surface.pushNavLights();
    }
    this.syncToLuna(this.selected());
  },

  moveBank(delta) {
    const chans = this.channels();
    const maxStart = Math.max(0, chans.length - BANK_SIZE);
    const next = clamp(this.bankStart + delta * BANK_SIZE, 0, maxStart);
    if (next === this.bankStart) return;
    this.bankStart = next;
    this.selectedOffset = clamp(this.selectedOffset, 0,
      Math.max(0, Math.min(BANK_SIZE, chans.length - next) - 1));
    this.pushBank(false);
    this.syncToLuna(this.selected());
  },

  /* ---- Selection, shared with LUNA ----------------------------------------
   *
   * The keyboard's selection and LUNA's are one selection: moving it on the
   * 4-D encoder moves the arrangement's, and clicking a track in LUNA moves the
   * keyboard's.
   *
   * The loop closes on identity rather than on a flag. LUNA echoes a selection
   * write back as a focus change, which calls selectAbsolute again; a "we are
   * writing" flag cleared when the write resolves would already be down by the
   * time that echo lands. Both directions compare uids instead and do nothing
   * when they already agree, so either one can start and neither bounces. */
  async syncToLuna(ch) {
    // Only timeline tracks can be selected in the arrangement: an aux bus or
    // MAIN has no row there, so those move the keyboard and leave LUNA alone.
    if (!session || !ch || !ch.trackType) return;
    const ctx = session.context;
    const uid = ch.uid.value;
    if (!ctx || !uid || ctx.lastSelectedTrack.value === uid) return;
    try {
      // Only the track set moves. The time range, the selected playlists and
      // the editor focus are the user's, and repointing a range at a different
      // track would change what their next edit lands on. Writing the selection
      // makes no undo entry.
      await ctx.select({ trackUids: [uid] });
      await ctx.lastSelectedTrack.set(uid);
    } catch (e) {
      log(`could not select "${ch.name.value}" in LUNA: ${e.code || e.message || e}`);
    }
  },

  /* LUNA's focused track is its last selected track, falling back to the first
   * selected and then the first visible one, and it only notifies when the
   * answer actually moves. */
  followLuna() {
    if (!session || !session.focusedTrack) return;
    const t = session.focusedTrack.value;
    const uid = t && t.uid && t.uid.value;
    if (!uid) return;
    const abs = this.channels().findIndex((c) => c.uid && c.uid.value === uid);
    if (abs < 0 || abs === this.selectedAbsolute()) return;
    this.selectAbsolute(abs);
  },

  /* Record arm. NIHIA has no arm message of its own — the protocol's button
   * list stops at MUTE and SOLO — so this is reached from controls the mixer
   * pages leave free: the 4-D encoder's push for the selected track, SHIFT with
   * a strip's MUTE for one that is not selected. The keyboard already draws the
   * state, since IS_ARMED has been going out with the rest of the strip. */
  async toggleArm(ch) {
    const arm = this.armOf(ch);
    if (!arm) {
      log(`${ch ? `"${ch.name.value}"` : 'that channel'} cannot be record-armed`);
      return;
    }
    try { await arm.set(!arm.value); }
    catch (e) { log(`arm failed: ${e.code || e.message || e}`); }
  },

  /* `delta` is a fraction of full scale, already scaled. Both the CC knobs and
   * the high-resolution SysEx end up here so the clamping and the undo
   * bracketing are written once. */
  nudgeVolume(ch, delta) {
    if (!ch || !delta) return;
    knobTick(ch.gain, () => ch.gain.normalized.set(clamp(ch.gain.normalized.value + delta, 0, 1)));
  },
  nudgePan(ch, delta) {
    if (!ch || !delta) return;
    // Shifting both positions together moves the image as a whole, which is what
    // a single balance knob should do; each side clamps at its own end, so a
    // full-width image narrows towards the edge instead of refusing to move.
    for (const ctl of this.pans(ch)) {
      knobTick(ctl, () => ctl.real.set(clamp((Number(ctl.real.value) || 0) + delta, -1, 1)));
    }
  },
  /* `ticks` is a 7-bit encoder delta: ±1 per detent, more when spun fast. */
  adjustVolume(ch, ticks) { this.nudgeVolume(ch, ticks * BASE_VOL_STEP * sensitivity); },
  adjustPan(ch, ticks) { this.nudgePan(ch, ticks * BASE_PAN_STEP * sensitivity); },
};

/* =====================================================================
 * The plugin pages
 *
 * The Mk3 has two sets of screens and two buttons for them: DAW shows the mixer,
 * PLUG-IN shows the selected channel's plugin chain. Both buttons light from the
 * same deep-integration session — the keyboard lights PLUG-IN once a DAW has told
 * it there is a chain to show, and leaves it dark otherwise. So a surface that
 * sends only mixer messages gets exactly one live button, and the only way to
 * reach a plugin is to drop the connection and let NI's agent take the keyboard
 * instead, which puts the DAW button out. Sending the chain is what makes both
 * live at once.
 *
 * On a track carrying an NI instrument there is a second step. FOCUS_FOLLOW
 * carries the plugin's own NKS instance id — a hidden parameter Komplete Kontrol
 * publishes as "NIKB03" and Kontakt as "NIKT0008" — and that is what lets the
 * keyboard hand its plugin pages to the instrument's NKS screens for browsing
 * and preset work while this surface keeps the mixer and the transport.
 * ===================================================================== */
const Rack = {
  channel: null,          // the LUNA channel the chain was built for
  chain: [],              // [{ slot, name }], nearest the source first
  index: 0,               // which link of the chain the keyboard is showing
  page: 0,
  pages: 0,
  params: [],             // the eight Controls on the current page
  sent: [],               // what the keyboard was last told about those eight
  offs: [],               // subscriptions to those eight
  chainOffs: [],          // subscriptions that notice the chain itself changing
  chainTimer: null,
  catalog: null,          // pluginId → display name, read once
  building: null,
  again: null,

  get entry() { return this.chain[this.index] || null; },

  /* A loaded slot often reports a null plugin_name — the SDK is explicit that
   * it is not a load signal — so the name comes from LUNA's plugin catalog,
   * which is the same list its browser shows. */
  async nameFor(slot) {
    const direct = slot.pluginName.value;
    if (direct) return direct;
    const id = slot.pluginId.value || '';
    if (!this.catalog) {
      this.catalog = new Map();
      try {
        for (const row of await luna.plugins.query({})) this.catalog.set(row.pluginId, row.name);
      } catch (e) { log(`plugin catalog unavailable: ${e.code || e.message || e}`); }
    }
    if (this.catalog.has(id)) return this.catalog.get(id);
    // A channel's built-in slots carry a variant id the catalog does not list —
    // the tape machine is `uaudio_studer_a800_console` where the browser knows
    // `uaudio_studer_a800` — so trim one suffix at a time until something matches
    // rather than putting a raw plugin id on the keyboard's screen.
    for (let key = id; key.includes('_'); ) {
      key = key.slice(0, key.lastIndexOf('_'));
      if (this.catalog.has(key)) return this.catalog.get(key);
    }
    return id || 'Plugin';
  },

  /* The chain the keyboard sees, in signal order: the instrument, the channel's
   * tape and console, then the insert slots.
   *
   * LUNA puts its console strip in the effect slots as an alias — `effect_0`
   * reports the plugin id `alias.console` and carries no parameters of its own,
   * because the real plugin lives in the `console` slot. Following the alias is
   * what the chain needs; taking it at face value gives a link with a name and
   * an empty parameter page. */
  slotsOf(ch) {
    if (!ch || !ch.effects) return [];
    const items = ch.effects.items || [];
    const byType = new Map(items.map((e) => [e.insertType.value, e]));
    const follow = (e) => {
      const id = String(e.pluginId.value || '');
      return id.startsWith('alias.') ? byType.get(id.slice('alias.'.length)) : e;
    };
    const out = [];
    for (const raw of [byType.get('instrument'), byType.get('tape'), ...(ch.effectSlots || [])]) {
      if (!raw) continue;
      const slot = follow(raw);
      const id = slot && String(slot.pluginId.value || '');
      if (!id || id.startsWith('alias.')) continue;     // empty slot, or a dangling alias
      if (!out.includes(slot)) out.push(slot);
    }
    return out;
  },

  /* Read a slot's parameters.
   *
   * A slot that has just had its plugin swapped keeps the old plugin's
   * parameters as ghosts until the engine publishes the new ones, and
   * `controls.load()` is once-only, so it hands back the ghosts for ever. The
   * instance id is what actually changes on a swap, so it is the key: a slot
   * read at a different plugin or instance is re-fetched rather than remembered.
   *
   * Measured on a Komplete Kontrol → Kontakt swap: the plugin id flips within a
   * second, the instance id only three and a half seconds later, and the new
   * parameters arrive with it. So the instance id is also what the chain watcher
   * listens to — reading on the plugin id alone lands squarely in the window
   * where the slot still holds the old plugin's parameters. */
  _readAt: new WeakMap(),
  async readControls(slot) {
    try {
      await slot.waitForPlugin(10000);
    } catch (e) { /* an empty or broken slot still has a parameter list to read */ }
    const now = { inst: slot.instanceId.value, pid: slot.pluginId.value };
    const seen = this._readAt.get(slot);
    const swapped = seen && (seen.inst !== now.inst || seen.pid !== now.pid);
    try {
      await (swapped ? slot.controls.reload() : slot.controls.load());
      this._readAt.set(slot, now);
    } catch (e) {
      log(`could not read ${slot.pluginId.value}'s parameters: ${e.code || e.message || e}`);
    }
  },

  /* The NKS instance id, read from the plugin's own parameter list. Only NI
   * plugins publish one, and only they are worth the round trip: Kontakt reports
   * two thousand parameters and reading them all for a UAD compressor would be
   * waste. */
  isNative(slot) {
    const id = String(slot.pluginId.value || '');
    const name = String(slot.pluginName.value || '');
    return /-NI-|native.?instruments/i.test(id) ||
           /komplete kontrol|kontakt|maschine|reaktor/i.test(name);
  },
  async focusIdOf(slot) {
    if (!slot || !this.isNative(slot)) return '';
    await this.readControls(slot);
    for (const c of slot.controls.items) {
      const n = String(c.name.value || '');
      if (NKS_FOCUS_ID.test(n)) return n;
    }
    return '';
  },

  /* Rebuilds are several awaited reads and the selection can move while they
   * run, so one runs at a time and a request arriving during one re-runs it
   * afterwards rather than interleaving. */
  rebuild(why) {
    if (this.building) { this.again = why || 'again'; return this.building; }
    this.building = this._rebuild(why)
      .catch((e) => log(`plugin chain failed: ${e.code || e.message || e}`))
      .then(() => {
        this.building = null;
        if (this.again) { const w = this.again; this.again = null; return this.rebuild(w); }
      });
    return this.building;
  },

  async _rebuild(why) {
    if (!Surface.connected) return;
    const ch = Mix.selected();
    const slots = this.slotsOf(ch);
    const chain = [];
    for (const slot of slots) chain.push({ slot, name: await this.nameFor(slot) });
    // Reading names is a round trip, and the selection can move while it runs.
    // The channel is only recorded once it is still the right one, so that the
    // next selection change is still seen as a change.
    if (ch !== Mix.selected()) return;

    this.channel = ch;
    this.chain = chain;
    this.watchChain(ch);
    this.index = 0;
    this.page = 0;
    this.sendChain();
    Surface.sysex(NIHIA.SX.SELECT_PLUGIN, 0, 0);
    await this.sendSelected();
    // The reference integration re-sends the selection after everything else, so
    // the keyboard's renderer rebuilds its chain buttons against a model that is
    // fully populated. Without it the chain draws but nothing in it lights.
    Surface.sysex(NIHIA.SX.SELECT_PLUGIN, 0, this.index);
    log(`plugin chain (${why}): ${chain.length ? chain.map((e) => e.name).join(' → ') : 'empty'}`);
    UI.paintRack();
  },

  /* Loading or clearing a plugin changes what the PLUG-IN button has to show, so
   * the chain follows the channel's slots as well as the selection. The rebuild
   * is debounced because swapping a plugin moves several properties at once and
   * because a rebuild re-subscribes, which must not feed itself. */
  watchChain(ch) {
    for (const off of this.chainOffs) { try { off(); } catch (e) {} }
    this.chainOffs = [];
    if (!ch || !ch.effects) return;
    const changed = () => {
      clearTimeout(this.chainTimer);
      this.chainTimer = setTimeout(() => {
        this.channel = null;              // force the selection guard to see a change
        this.rebuild('plugins changed');
      }, 800);     // long enough to swallow the instance id's null-then-new pair
    };
    try { this.chainOffs.push(ch.effects.onChange(changed)); } catch (e) {}
    for (const slot of (ch.effects.items || [])) {
      try {
        this.chainOffs.push(slot.pluginId.onChange(changed), slot.instanceId.onChange(changed));
      } catch (e) {}
    }
  },

  sendChain() {
    Surface.sysex(NIHIA.SX.PLUGIN_CHAIN, 0, 0, nulJoin(this.chain.map((e) => e.name)));
    Surface.sysex(NIHIA.SX.PLUGIN_TRACK, 0, 0,
      (this.channel && this.channel.name.value) || '');
  },

  /* Everything that belongs to the selected link: who owns the NKS session, what
   * preset it is on, and the current page of parameters. */
  async sendSelected() {
    const entry = this.entry;
    // FOCUS_FOLLOW anchors to the instrument — the head of the chain — whichever
    // link is showing. Sending an empty id while an effect is selected would tell
    // the keyboard the NKS instance had gone and it would drop the NKS pages.
    const head = this.chain[0];
    if (head && head.focusId === undefined) head.focusId = await this.focusIdOf(head.slot);
    const focusId = (head && head.focusId) || '';
    Surface.sysex(NIHIA.SX.FOCUS_FOLLOW, 0, 0, focusId);
    if (focusId) Diag.set(Diag.state, `${head.name} holds the NKS pages (${focusId})`);

    if (!entry) { this.clearParams(); return; }
    Surface.sysex(NIHIA.SX.PLUGIN_PRESET, 0, 0, entry.slot.presetName.value || '');
    // Preset stepping is the NKS client's job on an NI plugin; on anything else
    // this surface does not implement it, so the arrows stay dark.
    if (!this.isNative(entry.slot)) Surface.cc(NIHIA.CC.NAV_PRESET, 0);
    await this.sendPage(this.page);
  },

  async sendPage(page) {
    const entry = this.entry;
    if (!entry) { this.clearParams(); return; }
    await this.readControls(entry.slot);
    if (entry !== this.entry) return;

    // The NKS id is a hidden parameter, not something to put on a knob: it has
    // no value and turning it would mean nothing.
    const all = (entry.slot.params || []).filter((c) => !NKS_FOCUS_ID.test(String(c.name.value || '')));
    const per = NIHIA.PARAMS_PER_PAGE;
    // A page index is a 7-bit SysEx byte, so 127 pages is the protocol's ceiling.
    this.pages = Math.min(127, Math.ceil(all.length / per));
    this.page = clamp(page, 0, Math.max(0, this.pages - 1));
    Surface.sysex(NIHIA.SX.PARAM_PAGE, this.pages, this.page);

    this.unwatch();
    this.params = [];
    this.sent = [];                 // a new page is a redraw, not an update
    for (let i = 0; i < per; i++) {
      const ctl = all[this.page * per + i];
      this.params.push(ctl || null);
      this.pushParam(i);
      if (ctl) {
        this.offs.push(
          ctl.display.onChange(() => this.pushParam(i)),
          ctl.normalized.onChange(() => this.pushParam(i)),
        );
      }
    }
    UI.paintRack();
  },

  /* A parameter's name, its reading and its knob position. One LUNA change moves
   * both `display` and `normalized`, and both are watched, so each slot keeps its
   * last values and sends only what actually moved — otherwise every turn of a
   * knob goes out twice. */
  pushParam(i) {
    const ctl = this.params[i];
    const cache = (this.sent[i] = this.sent[i] || {});
    const name = ctl ? String(ctl.name.value ?? '') : '';
    const value = ctl ? String(ctl.display.value ?? '') : '';
    const pos = ctl ? clamp(Math.round((ctl.normalized.value || 0) * 127), 0, 127) : 0;
    if (cache.name !== name) { cache.name = name; Surface.sysex(NIHIA.SX.PARAM_NAME, 0, i, name); }
    if (cache.value !== value) { cache.value = value; Surface.sysex(NIHIA.SX.PARAM_VALUE, 0, i, value); }
    if (cache.pos !== pos) { cache.pos = pos; Surface.cc(NIHIA.CC.PLUGIN_PARAM + i, pos); }
  },

  clearParams() {
    this.unwatch();
    this.params = [];
    this.sent = [];
    this.pages = 0;
    this.page = 0;
    Surface.sysex(NIHIA.SX.PARAM_PAGE, 0, 0);
    for (let i = 0; i < NIHIA.PARAMS_PER_PAGE; i++) this.pushParam(i);
    Surface.sysex(NIHIA.SX.PLUGIN_PRESET, 0, 0, '');
    Surface.cc(NIHIA.CC.NAV_PRESET, 0);
  },

  unwatch() {
    for (const off of this.offs) { try { off(); } catch (e) {} }
    this.offs = [];
  },

  /* The keyboard picked another link of the chain. */
  select(i) {
    if (!this.chain[i] || i === this.index) {
      // Echo anyway: the renderer keys its chain buttons off this message.
      Surface.sysex(NIHIA.SX.SELECT_PLUGIN, 0, clamp(i, 0, Math.max(0, this.chain.length - 1)));
      return;
    }
    this.index = i;
    this.page = 0;
    Surface.sysex(NIHIA.SX.SELECT_PLUGIN, 0, i);
    this.sendSelected().catch((e) => log(`plugin select failed: ${e.code || e.message || e}`));
    UI.paintRack();
  },

  turnPage(delta) {
    if (!this.pages) return;
    const next = clamp(this.page + delta, 0, this.pages - 1);
    if (next === this.page) return;
    this.sendPage(next).catch((e) => log(`page change failed: ${e.code || e.message || e}`));
  },
  gotoPage(page) {
    if (!this.pages) return;
    this.sendPage(page).catch((e) => log(`page change failed: ${e.code || e.message || e}`));
  },

  /* A knob on a plugin page. The delta is already a fraction of full scale. */
  adjust(i, delta) {
    const ctl = this.params[i];
    if (!ctl || !delta) return;
    knobTick(ctl, () => ctl.normalized.set(clamp((ctl.normalized.value || 0) + delta, 0, 1)));
  },

  /* The keyboard just turned its plugin pages on. It may have dropped what it
   * knew while the mixer had the screens, so say it all again. */
  refresh() {
    if (!Surface.connected) return;
    if (this.channel !== Mix.selected()) { this.rebuild('entering plugin pages'); return; }
    this.sendChain();
    // The closing SELECT_PLUGIN has to be the last message of the group, after
    // the chain and the parameters, or the keyboard rebuilds its chain buttons
    // against a half-filled model and none of them light.
    this.sendSelected()
      .then(() => Surface.sysex(NIHIA.SX.SELECT_PLUGIN, 0, this.index))
      .catch((e) => log(`plugin refresh failed: ${e.code || e.message || e}`));
  },

  clear() {
    this.unwatch();
    this.watchChain(null);
    clearTimeout(this.chainTimer);
    this.channel = null;
    this.chain = [];
    this.index = 0;
    if (Surface.connected) {
      Surface.sysex(NIHIA.SX.PLUGIN_CHAIN, 0, 0, []);
      Surface.sysex(NIHIA.SX.PLUGIN_TRACK, 0, 0, '');
      Surface.sysex(NIHIA.SX.FOCUS_FOLLOW, 0, 0, '');
      this.clearParams();
    }
    UI.paintRack();
  },
};

/* Meters are coalesced: LUNA pushes per channel, the keyboard wants one 16-byte
 * frame for the whole bank. */
const Meters = {
  timer: null,
  schedule() {
    // Not gated on the keyboard: the on-screen mirror draws the same frame, and
    // pushMeters decides whether any MIDI goes out.
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.send(); }, METER_INTERVAL_MS);
  },
  send() {
    const frame = new Array(BANK_SIZE * 2).fill(0);
    for (let i = 0; i < BANK_SIZE; i++) {
      const ch = Mix.at(i);
      if (!ch) continue;
      const levels = ch.meter.level.value || [];
      const l = levels[0] ?? 0;
      const r = levels[1] ?? l;
      frame[i * 2] = clamp(Math.round(l * 127), 0, 127);
      frame[i * 2 + 1] = clamp(Math.round(r * 127), 0, 127);
    }
    Surface.pushMeters(frame);
    UI.paintMeters();
  },
};

const Transport = {
  offs: [],
  bind() {
    for (const off of this.offs) { try { off(); } catch (e) {} }
    this.offs = [];
    if (!session) return;
    const t = session.transport;
    this.offs.push(
      t.playing.onChange(() => { this.pushLights(); UI.paintTransport(); }),
      t.recordEnabled.onChange(() => { this.pushLights(); UI.paintTransport(); }),
      t.looping.onChange(() => { this.pushLights(); UI.paintTransport(); }),
      t.tempo.onChange(() => {
        const bpm = t.tempo.value;
        if (bpm) { knownBpm = bpm; Surface.pushTempo(bpm); }
      }),
      t.location.onChange(() => UI.paintLocation(t.location.value)),
      session.canUndo.onChange(() => this.pushLights()),
    );
    const click = Mix.clickTrack();
    if (click) this.offs.push(click.mute.real.onChange(() => this.pushLights()));
    if (t.tempo.value) { knownBpm = t.tempo.value; }
  },
  pushLights() {
    if (!Surface.connected || !session) return;
    const t = session.transport;
    Surface.light('PLAY', t.playing.value ? 1 : 0);
    Surface.light('REC', t.recordEnabled.value ? 1 : 0);
    Surface.light('LOOP', t.looping.value ? 1 : 0);
    Surface.light('STOP', t.playing.value ? 0 : 1);
    Surface.light('UNDO', undoWorks && session.canUndo.value !== false ? 1 : 0);
    Surface.light('REDO', undoWorks ? 1 : 0);
    const click = Mix.clickTrack();
    if (click) Surface.light('METRO', click.mute.on ? 0 : 1);
  },
};

async function doUndo(which) {
  if (!session || !undoWorks) return;
  try {
    await (which === 'undo' ? session.undo() : session.redo());
  } catch (e) {
    undoWorks = false;
    Transport.pushLights();
    log(`${which} is not available on this LUNA build (${e.code || e.message})`);
  }
}

/* =====================================================================
 * Device → DAW
 * ===================================================================== */
function onMidi(m) {
  if (m.type === 'sysex') {
    const bytes = m.sysex || [];
    if (!isNihiaSysex(bytes)) return;
    const id = bytes[NIHIA.HEADER.length];
    const payload = bytes.slice(NIHIA.HEADER.length + 1, -1);
    if (id === NIHIA.SX.ADJUST_PARAM) { handleAdjustParam(payload); return; }
    // The plugin pages talk back: SELECT_PLUGIN when the user picks another link
    // of the chain, PARAM_PAGE when they page through its parameters. Both carry
    // their argument in the index byte, which is payload[1].
    if (id === NIHIA.SX.SELECT_PLUGIN) { Rack.select(payload[1] | 0); return; }
    if (id === NIHIA.SX.PARAM_PAGE) { Rack.gotoPage(payload[1] | 0); return; }
    if (id === NIHIA.SX.TEMPO) {
      // The keyboard's tempo encoder. Reported but not acted on: LUNA's tempo
      // lives in the session's tempo map, and following a jog there would write
      // a tempo event rather than nudge a value.
      log(`keyboard asked for ${bytesToTempo(payload.slice(2)).toFixed(1)} BPM — tempo is read-only here`);
      return;
    }
    log(`sysex in: id 0x${id.toString(16)} (${bytes.length} bytes)`);
    return;
  }
  if (m.type !== 'controlChange' || m.channel !== 15) return;   // NIHIA is channel 16
  const d1 = m.data1, d2 = m.data2;

  // The handshake reply must be recognised before anything else: it is what
  // tells us the protocol version. A v3 answer means firmware older than 2.0.
  if (d1 === NIHIA.CC.HELLO) {
    if (d2 === NIHIA.PROTOCOL_V3) {
      clearTimeout(Surface.helloTimer);
      Surface.protocol = NIHIA.PROTOCOL_V3;
      setBadge($('dawStatus'), 'DAW mode', 'keyboard answered v3 — update to firmware 2.0', false);
      log('Keyboard speaks NIHIA v3 (Mk2-era). The Mk3 mixer needs firmware 2.0 for v4.');
    } else {
      Surface.onHelloAck(d2);
    }
    return;
  }
  handleCC(d1, d2).catch((e) => log(`error on CC ${d1}: ${e.code || e.message || e}`));
}

/* Once USE_SYSEX_PARAM is on the keyboard reports knob movement as a
 * high-resolution SysEx rather than a 7-bit CC — and the Mk3 uses only this
 * form, so without it the knobs are silent. The payload is
 * [group, slot, lsb, msb]: a 14-bit two's-complement delta where a full encoder
 * rotation is 8192, so it is already in units of full scale. Group 0 is the
 * slot's volume, group 1 its pan, group 2 a parameter on the plugin page. */
function handleAdjustParam(payload) {
  if (!payload || payload.length < 4) return;
  const [group, slot, lsb, msb] = payload;
  let raw = (lsb & 0x7F) | ((msb & 0x7F) << 7);
  if (raw & 0x2000) raw -= 0x4000;
  const delta = (raw / 8192) * sensitivity;
  if (group === NIHIA.ADJUST_PLUGIN) return Rack.adjust(slot, delta);
  const ch = Mix.at(slot);
  if (group === NIHIA.ADJUST_VOLUME) Mix.nudgeVolume(ch, delta);
  else if (group === NIHIA.ADJUST_PAN) Mix.nudgePan(ch, delta);
  else log(`adjust-param: unknown group ${group}`);
}

async function handleCC(d1, d2) {
  const C = NIHIA.CC;
  const t = session && session.transport;

  // Knobs: eight for volume, eight more when shift is held for pan.
  if (d1 >= NIHIA.KNOB_VOL_BASE && d1 < NIHIA.KNOB_VOL_BASE + BANK_SIZE) {
    return Mix.adjustVolume(Mix.at(d1 - NIHIA.KNOB_VOL_BASE), toSigned7(d2));
  }
  if (d1 >= NIHIA.KNOB_PAN_BASE && d1 < NIHIA.KNOB_PAN_BASE + BANK_SIZE) {
    return Mix.adjustPan(Mix.at(d1 - NIHIA.KNOB_PAN_BASE), toSigned7(d2));
  }

  switch (d1) {
    // The keyboard reports SHIFT as its own message and then sends the shifted
    // form of whatever is touched (CC 97 rather than 96, pan rather than volume),
    // so there is nothing to do but note it.
    case C.SHIFT:
      Surface.shift = !!d2;
      return;

    case C.BANK_MAPPING: {
      const was = Surface.bankMode;
      Surface.bankMode = d2;
      const mixer = d2 === NIHIA.BANK_MODE_MIXER;
      if (was === d2) return;
      log(`keyboard switched to ${mixer ? 'MIXER' : 'PLUGIN'} pages`);

      if (!mixer) {
        // The keyboard is drawing the plugin pages. The connection stays — this
        // is the same deep-integration session, just its other half — so the DAW
        // button stays lit and pressing it comes straight back. Only the eight
        // mixer strips go quiet, because the plugin pages are drawn over them.
        Diag.set('plugin mode', Rack.chain.length
          ? `showing ${Rack.chain.map((e) => e.name).join(' → ')}`
          : 'nothing on this channel to show');
        Rack.refresh();
        return;
      }

      // Back on the mixer. The plugin pages have drawn over the strips, so
      // re-send everything rather than trusting the cache.
      Diag.set('mixer mode', 'redrawing the strips');
      Surface.resetSlots();
      Surface.pushAll();
      return;
    }

    case C.PLAY: if (d2 && t) await t.toggle(); return;
    case C.STOP: if (d2 && t) await t.stop(); return;
    case C.REC:  if (d2 && t) await t.toggleRecord(); return;
    case C.LOOP: if (d2 && t) await t.looping.set(!t.looping.value); return;
    case C.RESTART:
      if (d2 && t) { await t.stop(); await t.returnToZero(); await t.play(); }
      return;
    case C.METRO: {
      if (!d2) return;
      const click = Mix.clickTrack();
      if (click) await click.mute.toggle();
      return;
    }
    case C.UNDO: if (d2) await doUndo('undo'); return;
    case C.REDO: if (d2) await doUndo('redo'); return;

    // MUTE and SOLO carry the bank slot in data2, not a pressed/released value.
    // SHIFT is not a modifier here: the keyboard's own solo gesture is SHIFT
    // with MUTE, and the firmware resolves it, sending SOLO (68) rather than
    // MUTE (67). A shifted MUTE never reaches this surface. (Measured.)
    case C.MUTE: { const ch = Mix.at(d2); if (ch) await ch.mute.toggle(); return; }
    case C.SOLO: { const s = Mix.soloOf(Mix.at(d2)); if (s) await s.toggle(); return; }
    case C.MUTE_SELECTED: { if (!d2) return; const ch = Mix.selected(); if (ch) await ch.mute.toggle(); return; }
    case C.SOLO_SELECTED: { if (!d2) return; const s = Mix.soloOf(Mix.selected()); if (s) await s.toggle(); return; }

    // SHIFT with the 4-D encoder's push arms the selected track. The protocol
    // has no arm message at all, so it has to come from somewhere, and this is
    // the one spare control that costs nothing: the push arrives as a single
    // event with no release (so there is no tap to read), and an unshifted push
    // is the opening message of push-and-turn, which this keyboard answers with
    // ENCODER_GENERAL — a jog. Arming on 96 would arm a track every time the
    // playhead was jogged that way; 97 leaves that gesture alone.
    case C.ENCODER_BUTTON:
      // The start of a push-and-turn jog. Nothing to do, and not worth logging.
      return;
    case C.ENCODER_BUTTON_SHIFT:
      if (d2) await Mix.toggleArm(Mix.selected());
      return;

    case C.ENCODER_X: Mix.selectAbsolute(Mix.selectedAbsolute() + toSigned7(d2)); return;
    case C.ENCODER_Y: Mix.moveBank(Math.sign(toSigned7(d2))); return;
    // The arrows are dual-role: banks of eight channels on the mixer pages,
    // pages of eight parameters on the plugin pages.
    case C.NAV_BANKS:
      if (Surface.bankMode === NIHIA.BANK_MODE_MIXER) Mix.moveBank(Math.sign(toSigned7(d2)));
      else Rack.turnPage(Math.sign(toSigned7(d2)));
      return;

    // Preset stepping belongs to the NKS client on an NI plugin, and is not
    // implemented for anything else; the arrows are reported but dark.
    case C.NAV_PRESET:
      return;

    // The reference gives the 4-D encoder twice the step of the knobs. Kept for
    // the keyboards that send them: a Kontrol Mk3 answers push-and-turn with
    // ENCODER_GENERAL instead, and never sends either of these. (Measured.)
    case C.ENCODER_VOL_SEL: return Mix.adjustVolume(Mix.selected(), toSigned7(d2) * 2);
    case C.ENCODER_PAN_SEL: return Mix.adjustPan(Mix.selected(), toSigned7(d2) * 2);

    case C.ENCODER_GENERAL: {
      // Jog the playhead a beat at a time. LUNA ignores seeks while rolling.
      if (!t || t.playing.value) return;
      const now = t.tick;
      if (typeof now !== 'number') return;
      await t.seek(Math.max(0, now + toSigned7(d2) * Luna.TICKS_PER_BEAT));
      return;
    }

    case C.COUNT_IN: case C.CLEAR: case C.QUANTIZE: case C.AUTO: case C.TEMPO:
      log(`unused control: CC ${d1} = ${d2}`);
      return;

    default:
      log(`unhandled CC ${d1} = ${d2}`);
  }
}

/* =====================================================================
 * On-screen mirror of what the keyboard shows
 * ===================================================================== */
const UI = {
  els: [],
  rebuild() {
    const bank = $('bank');
    if (!bank) return;
    bank.textContent = '';
    this.els = [];
    const chans = Mix.channels();
    $('bankLabel').textContent = chans.length
      ? `${Mix.bankStart + 1}–${Math.min(Mix.bankStart + BANK_SIZE, chans.length)} of ${chans.length}`
      : '—';
    for (let i = 0; i < BANK_SIZE; i++) {
      const ch = Mix.at(i);
      const el = document.createElement('div');
      el.className = 'strip' + (i === Mix.selectedOffset && ch ? ' selected' : '');
      if (!ch) {
        const nm = document.createElement('div');
        nm.className = 'nm'; nm.textContent = '—';
        el.append(nm); bank.append(el); this.els.push(null); continue;
      }
      el.innerHTML = `
        <div class="nm"></div>
        <div class="panline"><div class="dot"></div></div>
        <div class="fader-wrap"><div class="fader"><div class="fill"></div></div><div class="meterbar"><div class="fill"></div></div></div>
        <div class="val"></div>
        <div class="ms"><button class="mute">M</button><button class="solo">S</button><button class="arm">R</button></div>`;
      bank.append(el);
      const refs = {
        el,
        nm: el.querySelector('.nm'), fill: el.querySelector('.fader .fill'),
        meter: el.querySelector('.meterbar .fill'), val: el.querySelector('.val'),
        dot: el.querySelector('.dot'), mute: el.querySelector('.mute'),
        solo: el.querySelector('.solo'), arm: el.querySelector('.arm'),
      };
      el.onclick = () => Mix.selectAbsolute(Mix.bankStart + i);
      refs.mute.onclick = (e) => { e.stopPropagation(); ch.mute.toggle(); };
      const solo = Mix.soloOf(ch);
      refs.solo.style.visibility = solo ? '' : 'hidden';
      refs.solo.onclick = (e) => { e.stopPropagation(); if (solo) solo.toggle(); };
      const arm = Mix.armOf(ch);
      refs.arm.style.visibility = arm ? '' : 'hidden';
      refs.arm.onclick = (e) => { e.stopPropagation(); if (arm) arm.set(!arm.value); };
      this.els.push(refs);
      this.paint(i);
    }
  },
  paint(i) {
    const r = this.els[i], ch = Mix.at(i);
    if (!r || !ch) return;
    r.nm.textContent = ch.name.value || '';
    r.nm.style.color = colorHex(ch.color.value) || '';
    r.fill.style.height = `${(ch.gain.normalized.value || 0) * 100}%`;
    r.val.textContent = Mix.volText(ch);
    r.dot.style.left = `${((Mix.panPosition(ch) + 1) / 2) * 100}%`;
    r.mute.classList.toggle('on', !!ch.mute.on);
    const solo = Mix.soloOf(ch);
    if (solo) r.solo.classList.toggle('on', !!solo.on);
    const arm = Mix.armOf(ch);
    if (arm) r.arm.classList.toggle('on', !!arm.value);
    r.el.classList.toggle('selected', i === Mix.selectedOffset);
  },
  paintMeters() {
    for (let i = 0; i < BANK_SIZE; i++) {
      const r = this.els[i], ch = Mix.at(i);
      if (!r || !ch) continue;
      const levels = ch.meter.level.value || [];
      r.meter.style.height = `${Math.max(0, ...levels, 0) * 100}%`;
    }
  },
  paintTransport() {
    if (!session) return;
    const t = session.transport;
    $('btnPlay').classList.toggle('active', !!t.playing.value);
    $('btnRec').classList.toggle('active', !!t.recordEnabled.value);
    $('btnLoop').classList.toggle('active', !!t.looping.value);
  },
  paintLocation(loc) {
    if (!loc || !loc.bar_beat) return;
    const parts = [Luna.formatBarBeat(loc.bar_beat)];
    if (session) parts.push(Luna.formatMinSec(session.transport.seconds, { fraction: 1 }));
    const bpm = session && session.transport.tempo.value;
    if (bpm) parts.push(`${Math.round(bpm * 10) / 10} BPM`);
    $('loc').textContent = parts.join('  ·  ');
  },
  /* The plugin pages, mirrored. Worth showing because the keyboard's own copy is
   * the thing under test: if the chain is wrong here it is wrong there. */
  paintRack() {
    const el = $('rack');
    if (!el) return;
    if (!Rack.chain.length) {
      el.textContent = Rack.channel
        ? `${Rack.channel.name.value || 'channel'}: no plugins — the PLUG-IN button has nothing to show`
        : 'no channel selected';
      return;
    }
    const names = Rack.chain.map((e, i) => (i === Rack.index ? `[${e.name}]` : e.name)).join('  →  ');
    const page = Rack.pages ? `  ·  page ${Rack.page + 1}/${Rack.pages}` : '';
    const params = Rack.params
      .map((p, i) => (p ? `${i + 1} ${p.name.value}: ${p.display.value}` : null))
      .filter(Boolean).join('   ');
    el.textContent = `${names}${page}\n${params}`;
  },
  paintEngage() {
    const b = $('btnRelease');
    if (!b) return;
    b.textContent = Surface.engaged ? 'Release to Komplete Kontrol' : 'Take the keyboard back';
    b.classList.toggle('active', !Surface.engaged);
    this.paintCompact();
  },

  /* The compact strip: one lamp, one line for the keyboard and one for LUNA.
   * It is drawn whatever the mode, so expanding never shows a stale strip. */
  paintCompact() {
    const dot = $('cDot'), main = $('cMain'), sub = $('cSub');
    if (!dot || !main || !sub) return;
    let lamp, text;
    if (!Surface.engaged) { lamp = 'bad'; text = 'Released to Komplete Kontrol'; }
    else if (Surface.connected) { lamp = 'ok'; text = `Keyboard connected · protocol v${Surface.protocol}`; }
    else if (Link.ready) { lamp = 'warn'; text = 'Keyboard not answering'; }
    else { lamp = 'bad'; text = 'No DAW port'; }
    const n = session ? Mix.channels().length : 0;
    dot.className = `dot ${lamp}`;
    main.textContent = text;
    sub.textContent = session
      ? `${session.name.value} · ${n} channel${n === 1 ? '' : 's'}`
      : 'no LUNA session open';
  },
  paintDevices(devices) {
    const sel = $('devSelect');
    if (!sel) return;
    const current = Link.device ? Link.device.name.value : '';
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = devices.length ? 'choose automatically' : 'no MIDI devices';
    sel.append(auto);
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.name.value; o.textContent = d.name.value;
      if (Link.deviceName ? d.name.value === Link.deviceName : d.name.value === current) o.selected = true;
      sel.append(o);
    }
  },
};

/* ---------- session binding ----------
 * Binding is several awaited reads, and the focus can change while they run, so
 * only one runs at a time and a request that arrives during one re-runs it
 * afterwards rather than interleaving. */
let binding = null, bindAgain = false;
function rebind() {
  if (binding) { bindAgain = true; return binding; }
  binding = bindSession()
    .catch((e) => log(`bind failed: ${e.code || e.message || e}`))
    .then(() => {
      binding = null;
      if (bindAgain) { bindAgain = false; return rebind(); }
    });
  return binding;
}

async function bindSession() {
  // A focus notification can arrive when nothing moved. Re-reading every strip
  // and redrawing the keyboard for that is pure waste.
  if (session && luna.sessions.focused.value === session && Mix.strips.length) return;

  Mix.invalidate();
  for (const s of Mix.strips) s.offs.forEach((off) => { try { off(); } catch (e) {} });
  Mix.strips = [];
  for (const off of Transport.offs) { try { off(); } catch (e) {} }
  Transport.offs = [];
  if (bindSession._offs) { bindSession._offs.forEach((o) => { try { o(); } catch (e) {} }); }
  bindSession._offs = [];

  // luna.session() resolves to the focused session already loaded and subscribed;
  // the collections and each strip's controls are separate reads.
  session = null;
  Diag.set('binding', 'asking LUNA for the focused session');
  try {
    session = await luna.session();
  } catch (e) {
    const code = (e && (e.code || e.name)) || '';
    if (code !== 'no_session' && !(Luna.NoSessionOpen && e instanceof Luna.NoSessionOpen)) {
      log(`session unavailable: ${code} ${e && e.message}`);
      Diag.set('no session', `${code} ${(e && e.message) || ''}`);
    } else {
      Diag.set('no session', 'LUNA has none open');
    }
  }
  if (!session) {
    setBadge($('lunaStatus'), 'LUNA', 'connected — no session open', undefined);
    Mix.invalidate();
    if (Surface.connected) {
      for (let i = 0; i < BANK_SIZE; i++) Surface.clearSlot(i);
      Surface.showNotice('NO SESSION');
      Rack.clear();
    }
    UI.rebuild();
    scheduleRetry('no session');
    return;
  }

  const bound = session;
  Diag.set('binding', 'reading tracks and buses');
  await Promise.all([session.tracks.membersReady(), session.buses.membersReady()]);
  if (session !== bound) return;             // focus moved while we were reading
  Mix.invalidate();
  Diag.set('binding', `reading ${Mix.channels().length} strips`);
  // gain, pan and mute live on each channel's main output, which is its own read.
  await Mix.loadStrips();
  if (session !== bound) return;

  setBadge($('lunaStatus'), 'LUNA', `session "${session.name.value}"`, true);
  Mix.bankStart = 0; Mix.selectedOffset = 0; undoWorks = true;
  knownBpm = session.transport.tempo.value || 0;

  // Tracks and buses come and go; either changes the strip order.
  const refreshChannels = () => {
    Mix.invalidate();
    Mix.loadStrips()
      .then(() => { if (session === bound) Mix.pushBank(true); })
      .catch((e) => log(`channel refresh failed: ${e.code || e.message || e}`));
  };
  bindSession._offs.push(
    session.tracks.onChange(refreshChannels),
    session.buses.onChange(refreshChannels),
    // Clicking a track in LUNA moves the keyboard's selection to match.
    session.focusedTrack.onChange(() => Mix.followLuna()),
  );

  Transport.bind();
  Mix.pushBank(true);
  // Start on whatever LUNA has focused rather than on channel 1, so the two
  // selections agree from the first frame instead of the keyboard moving LUNA's.
  Mix.followLuna();
  Transport.pushLights();
  if (knownBpm) Surface.pushTempo(knownBpm);
  UI.paintTransport();
  UI.paintLocation(session.transport.location.value);
  const n = Mix.channels().length;
  log(`bound to "${session.name.value}" (${n} channels)`);
  Diag.set(n ? 'ready' : 'bound but empty', `${session.name.value}: ${n} channels`);
  UI.paintCompact();

  // A session that reports no channels at all is a session the surface cannot
  // draw. Inside LUNA the page can load before the session's tree is readable,
  // so try again rather than sitting on an empty mixer for ever.
  if (!n) scheduleRetry('no channels yet');
  else retries = 0;
}

let retries = 0, retryTimer = null;
function scheduleRetry(why) {
  if (retryTimer || retries >= 10) return;
  const wait = Math.min(8000, 750 * Math.pow(1.6, retries++));
  log(`${why}; retrying in ${Math.round(wait)} ms (attempt ${retries})`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    Mix.invalidate();
    Mix.strips = [];        // defeat the "nothing moved" guard
    rebind();
  }, wait);
}

/* ---------- boot ---------- */
function fatal(where, e) {
  const msg = `${where}: ${(e && (e.code || e.message)) || e}`;
  log(msg);
  setBadge($('lunaStatus'), 'LUNA', msg, false);
  try { console.error(where, e); } catch (_) {}
}

// A page that renders but never boots looks exactly like a page that is working
// and simply not connected, so say so loudly rather than failing in silence.
window.addEventListener('error', (ev) => fatal('script error', ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => fatal('unhandled rejection', ev.reason));

(async () => {
  const params = new URLSearchParams(location.search);
  // `?dev=1` puts the internals on the window. The add-on runs in a web view with
  // no console and no way in from outside, so without a hook like this the only
  // way to exercise a message path is to perform it on the keyboard by hand.
  if (params.has('dev')) {
    window.Kontrol = { Surface, Link, Mix, Rack, Meters, Transport, Win, UI, onMidi, NIHIA, log };
  }

  $('btnExpand').onclick = () => Win.set('full');
  $('btnCompact').onclick = () => Win.set('compact');
  Win.applyClass();
  UI.paintCompact();

  $('btnHandshake').onclick = () => Surface.startHandshake();
  // With unload_on_close off, LUNA keeps this page loaded when the window is
  // closed, so closing and reopening no longer picks up an edit to these files.
  // The cache-buster has to reach index.html too, and LUNA's own add_on_inst
  // query parameter has to survive, or thisInstance() comes back empty and the
  // window stops resizing.
  $('btnReload').onclick = () => {
    const u = new URL(location.href);
    u.searchParams.set('reload', String(Date.now()));
    location.replace(u.toString());
  };
  $('btnRelease').onclick = () => (Surface.engaged ? Surface.release() : Surface.engage());
  $('devSelect').onchange = (e) => Link.choose(e.target.value);
  UI.paintEngage();

  $('sens').value = String(sensitivity);
  $('sens').onchange = (e) => {
    sensitivity = Number(e.target.value) || 1;
    store.set('kontrol.sens', String(sensitivity));
    log(`knob sensitivity ×${sensitivity}`);
  };
  $('btnPlay').onclick = () => session && session.transport.toggle();
  $('btnStop').onclick = () => session && session.transport.stop();
  $('btnRec').onclick = () => session && session.transport.toggleRecord();
  $('btnLoop').onclick = () => session && session.transport.looping.set(!session.transport.looping.value);
  $('btnBankL').onclick = () => Mix.moveBank(-1);
  $('btnBankR').onclick = () => Mix.moveBank(1);

  const savedDevice = store.get('kontrol.device');
  if (savedDevice) Link.deviceName = savedDevice;

  window.addEventListener('pagehide', () => Surface.goodbye());

  try {
    luna = params.has('mock')
      ? await Luna.connect({
          engine: 'mock',
          setup: (e) => e.addSession('kontrol', {
            name: 'Mock Session',
            focused: true,
            tracks: ['Kick', 'Snare', 'Bass', 'Keys', 'Gtr', 'Vox', 'Pad', 'FX', 'Perc'],
          }),
        })
      : await Luna.connect();
  } catch (e) {
    setBadge($('lunaStatus'), 'LUNA', `not reachable (${e.message || e})`, false);
    return;
  }
  window.luna = luna;
  // Needs the connection: the window's size lives on this page's instance node.
  await Win.attach();

  // Which engine answered matters: a page that reaches a mock or headless engine
  // connects happily and then has no session to show, which looks identical to a
  // broken surface. Name it up front.
  const engine = (luna.engine && (luna.engine.value ?? luna.engine)) || 'unknown';
  log(`connected to ${engine} ${luna.version || ''} (${location.protocol}//${location.host || 'file'})`);
  Diag.set('connected', `${engine} ${luna.version || ''}`);
  if (String(engine).toLowerCase().includes('mock') && !params.has('mock')) {
    log('WARNING: this is a mock engine, so there is no real session to control.');
  }

  luna.status.onChange(() => {
    const s = luna.status.value;
    if (s !== 'connected') setBadge($('lunaStatus'), 'LUNA', s, false);
  });

  // Start MIDI first and do not await it alongside the session: the keyboard's
  // handshake must not wait on reading a mixer, or a slow or stuck session read
  // leaves the DAW button dark with nothing to say why.
  Link.start().catch((e) => {
    setBadge($('portStatus'), 'Port', `MIDI unavailable (${e.code || e.message})`, false);
    log(`MIDI could not start: ${e.code || e.message || e}`);
  });

  try {
    await luna.sessions.ready();
  } catch (e) {
    log(`session list unavailable: ${e.code || e.message || e}`);
  }
  // The SDK follows LUNA's focused session itself, so opening or closing one
  // while this page is up rebinds the surface without a reload.
  luna.sessions.focused.onChange(() => rebind());
  rebind();
})();
