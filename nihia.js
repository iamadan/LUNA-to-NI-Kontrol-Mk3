'use strict';
(function () {
/* =====================================================================
 * NIHIA protocol v4 — Native Instruments Host Integration Agent
 *
 * Constants and message builders for the Kontrol S-Series Mk3 DAW port
 * (firmware 2.0 and later), which is what lights the DAW button and drives
 * the keyboard's mixer screens.
 *
 * Message numbers and the handshake sequence follow Native Instruments'
 * FL Studio integration scripts (MIT licensed, © 2021 Pablo Peral), which are
 * the reference implementation for this protocol.
 *
 * Two things share a number space but never collide, because one is a CC
 * data1 and the other a SysEx message id: CC 67/68 are the device's MUTE and
 * SOLO buttons, SysEx 67/68 report a track's mute and solo state.
 * ===================================================================== */

const NIHIA = {
  /* Every SysEx to and from the keyboard starts with this. */
  HEADER: [0xF0, 0x00, 0x21, 0x09, 0x00, 0x00, 0x44, 0x43, 0x01, 0x00],
  EOX: 0xF7,
  /* All CC traffic is on MIDI channel 16. */
  STATUS: 0xBF,

  PROTOCOL_V3: 3,
  PROTOCOL_V4: 4,

  CC: {
    HELLO: 0x01,              // DAW→device: protocol version. Device replies with the same CC.
    GOODBYE: 0x02,            // DAW→device: leave deep-integration mode
    SHIFT: 0x04,              // device→DAW: SHIFT held (1) or released (0)
    BANK_MAPPING: 0x05,       // device→DAW: 0 = mixer mode, 1 = plugin mode
    USE_SYSEX_PARAM: 0x06,    // DAW→device: enable v4 SysEx parameter messages

    PLAY: 16, RESTART: 17, REC: 18, COUNT_IN: 19, STOP: 20,
    CLEAR: 21, LOOP: 22, METRO: 23, TEMPO: 24,
    UNDO: 32, REDO: 33, QUANTIZE: 34, AUTO: 35,

    ENCODER_X: 48,            // 4-D encoder left/right on S-series ("navigate tracks")
    NAV_BANKS: 49,            // bank arrows; also the LED bitmask going the other way
    ENCODER_Y: 50,            // 4-D encoder up/down on S-series ("navigate clips")
    ENCODER_GENERAL: 52,      // 4-D encoder turned: jog
    NAV_PRESET: 54,           // 0x36: preset arrows; LED bitmask going the other way

    MUTE: 67, SOLO: 68,       // device→DAW: data2 is the bank slot (0-7), not a value

    VOL_GRAPH: 80,            // DAW→device: 80+slot, fader position 0-127
    PAN_GRAPH: 88,            // DAW→device: 88+slot, pan position 0-127 (64 = centre)

    /* Plugin pages: the eight knob positions drawn above the parameter names.
     * 0x70 + slot, 0-127. Shares its number with SysEx 0x70 (SELECT_PLUGIN) the
     * way MUTE/SOLO do, and never collides for the same reason. */
    PLUGIN_PARAM: 0x70,

    ENCODER_BUTTON: 96, ENCODER_BUTTON_SHIFT: 97,
    ENCODER_VOL_SEL: 100,     // 4-D encoder adjusting the selected track's volume
    ENCODER_PAN_SEL: 101,
    MUTE_SELECTED: 102, SOLO_SELECTED: 103,
    SELECTED_AVAILABLE: 104,
  },

  /* Knob rows: unshifted knobs send volume, shifted knobs send pan. */
  KNOB_VOL_BASE: 80,
  KNOB_PAN_BASE: 88,

  SX: {
    SURFACE_CONFIG: 0x03,
    DAW_IDENTITY: 0x07,
    TEMPO: 0x19,
    EXIST: 64,
    KOMPLETE_INSTANCE: 65,
    SELECTED: 66,
    IS_MUTE: 67,
    IS_SOLO: 68,
    IS_ARMED: 69,
    VOLUME: 70,               // display string, e.g. "-6.0 dB"
    PAN: 71,                  // display string, e.g. "50% Left"
    NAME: 72,
    PEAK: 73,                 // also v4 SYSEX_LEVEL_METERS
    MUTED_BY_SOLO: 74,
    FOCUS_FOLLOW: 0x41,       // the NKS instance id that owns the plugin chain
    TRACK_COLOR: 0x4B,        // "#RRGGBB"

    /* The plugin pages. SELECT_PLUGIN travels both ways: the DAW sends it to say
     * which link of the chain is showing, the keyboard sends it when the user
     * picks another. PLUGIN_CHAIN carries the names NUL-separated, so its payload
     * is bytes rather than a string. */
    SELECT_PLUGIN: 0x70,
    PLUGIN_CHAIN: 0x71,
    PARAM_NAME: 0x72,
    PARAM_VALUE: 0x73,
    PARAM_PAGE: 0x74,         // value = page count, index = current page
    PARAM_SECTION: 0x75,
    PLUGIN_PRESET: 0x76,
    PLUGIN_TRACK: 0x77,       // the mixer track the selected plugin sits on
    ADJUST_PARAM: 0x7F,
  },

  /* ADJUST_PARAM groups: which row of eight the delta belongs to. */
  ADJUST_VOLUME: 0,
  ADJUST_PAN: 1,
  ADJUST_PLUGIN: 2,

  PARAMS_PER_PAGE: 8,

  TRACK_TYPE: { EMPTY: 0, GENERIC: 1, MIDI: 2, AUDIO: 3, GROUP: 4, RETURN_BUS: 5, MASTER: 6 },

  BANK_MODE_MIXER: 0,
  BANK_MODE_PLUGIN: 1,
};

/* A 7-bit two's-complement encoder delta. */
function toSigned7(v) {
  const m = v & 0x7F;
  return (m & 0x40) ? m - 0x80 : m;
}

/* The same delta as a fraction of a full-scale move.
 *
 * Note this is NOT what a knob handler wants. The keyboard's knobs and the 4-D
 * encoder are relative encoders: one detent sends a delta of ±1, and a fast turn
 * sends a larger one. Scaling that by 1/63 first makes a detent worth 1/63 of the
 * step size, so at the reference's 0.02 step a fader needs some three thousand
 * detents to travel. Knob handlers use the raw signed delta and multiply by the
 * step, which is what the reference's "increments for each message" means and
 * gives a full sweep in fifty detents. */
function toNormalizedDelta(v) {
  return toSigned7(v) / 63;
}

/* SysEx payloads are 7-bit: anything outside ASCII becomes '?'. */
function str2bytes(s) {
  const out = [];
  for (const ch of String(s ?? '')) {
    const c = ch.charCodeAt(0);
    out.push(c >= 0x20 && c <= 0x7E ? c : 0x3F);
  }
  return out;
}

/* The plugin chain travels as one payload of NUL-separated names. A NUL would
 * not survive str2bytes, which replaces everything outside printable ASCII with
 * '?', so the join is done in bytes. */
function nulJoin(strings) {
  const out = [];
  (strings || []).forEach((s, i) => {
    if (i) out.push(0);
    out.push(...str2bytes(s));
  });
  return out;
}

/* An NKS focus id: the hidden parameter an NI plugin publishes to name its own
 * instance — "NIKB03" for Komplete Kontrol, "NIKT0008" for Kontakt, NIMA for
 * Maschine, NIRE for Reaktor. Sending it as FOCUS_FOLLOW is what lets the
 * keyboard's plugin pages show the instrument's own NKS screens while the DAW
 * keeps the mixer. */
const NKS_FOCUS_ID = /^NI[A-Z]{2}[0-9A-Za-z]*$/;

function buildSysex(messageId, value, index, data) {
  const msg = NIHIA.HEADER.concat([messageId & 0x7F, (value || 0) & 0x7F, (index || 0) & 0x7F]);
  if (typeof data === 'string') msg.push(...str2bytes(data));
  else if (Array.isArray(data)) msg.push(...data.map((b) => b & 0x7F));
  msg.push(NIHIA.EOX);
  return msg;
}

/* Tempo travels as the beat duration in units of 10 ns, little-endian in
 * 7-bit chunks. */
const TEN_NS_PER_MINUTE = 60e8;
function tempoToBytes(bpm) {
  const clamped = Math.min(999, Math.max(1, bpm || 120));
  const duration = Math.round(TEN_NS_PER_MINUTE / clamped);
  return [0, 1, 2, 3, 4].map((i) => Math.floor(duration / Math.pow(128, i)) & 0x7F);
}
function bytesToTempo(bytes) {
  let duration = 0;
  for (let i = 0; i < 5; i++) duration += (bytes[i] || 0) * Math.pow(128, i);
  return duration > 0 ? TEN_NS_PER_MINUTE / duration : 0;
}

/* Does this SysEx come from the keyboard? */
function isNihiaSysex(bytes) {
  if (!bytes || bytes.length < NIHIA.HEADER.length + 2) return false;
  for (let i = 0; i < NIHIA.HEADER.length; i++) if (bytes[i] !== NIHIA.HEADER[i]) return false;
  return true;
}

window.NIHIA = NIHIA;
window.NihiaCodec = {
  toSigned7, toNormalizedDelta, str2bytes, nulJoin, buildSysex,
  tempoToBytes, bytesToTempo, isNihiaSysex, NKS_FOCUS_ID,
};
})();
