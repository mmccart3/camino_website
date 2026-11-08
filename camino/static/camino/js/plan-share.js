/* plan-share.js: a plan as a short code, for a QR code or a link.
 *
 * encode(state, data) turns the planner's state into bytes and text (base64url), and decode(text, data)
 * turns it back, checking everything. The code holds the choices only (stage numbers, routes, places to
 * stay, the day's date and pace), never distances or times: the app works those out from its own guide,
 * as the file does. So it is small enough for a QR code. The layout is written up in the app project,
 * docs/itinerary_qr_code_spec.md, with test vectors; keep the two in step.
 *
 *   byte 0       format version: 1, or 2 when the plan needs what version 2 adds (see below)
 *   bytes 1-4    the guide: the first 8 hex characters of the guide fingerprint
 *   byte 5       pace x 10
 *   varint       first day: 0 for none, else days since 2000-01-01, plus 1
 *   varint+utf8  plan name
 *   varint       number of days
 *   each day     a flags byte, then what that kind of day needs (see writeDay)
 *   version 2:   an extras section, one entry for each day that has more to say (see writeExtras)
 *   2 bytes      CRC-16/CCITT-FALSE of everything before it, high byte first
 *
 * Version 2 adds to version 1, so a plan that needs nothing new is still written as version 1: a rest day
 * as the first day of the plan (it carries its own place), the booking reference of a stay, and the way,
 * times, reference and notes of a travel day.
 *
 * It runs in the browser (window.CaminoShare) and in Node tests.
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./plan-core.js') : root.CaminoPlan);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaminoShare = api;
})(typeof self !== 'undefined' ? self : this, function (Plan) {
  'use strict';

  var VERSION = 2;                         // the newest version this file reads and writes
  var STATUSES = Plan.STATUSES;
  var EPOCH = '2000-01-01';
  var DAY_TYPES = { s: 0, c: 1, r: 2, t: 3 };
  var TYPE_LETTERS = ['s', 'c', 'r', 't'];
  var STAY_KINDS = { a: 0, p: 1, c: 2 };
  var KIND_LETTERS = ['a', 'p', 'c'];
  // Bounds on what is read, so that a damaged or hostile code cannot make the page do much work.
  var MAX_NAME_BYTES = 320, MAX_PLACE_BYTES = 400, MAX_STAY_BYTES = 800, MAX_PATHS = 200, MAX_DAYS = Plan.MAX_DAYS;
  var MAX_REF_BYTES = Plan.MAX_REF * 4, MAX_NOTES_BYTES = Plan.MAX_TRAVEL_NOTES * 4;   // a character is up to 4 bytes
  var MODES = Plan.MODES;

  var MESSAGES = {
    damaged: 'This plan code looks cut off or damaged. Ask for the QR code or link again.',
    version: 'This plan code was made by a newer version of the planner. Reload this page, or update the app, and try again.',
    guide: 'This plan code was made for a different edition of the guide, so its days cannot be matched. Ask the sender to make it again from this site.',
    unknown: 'This plan code refers to stages or places that are not in this guide, so it cannot be opened.'
  };

  // The words go through camT (i18n.js) when the page has it, so the Spanish page can translate them.
  function say(message) { return typeof globalThis !== 'undefined' && typeof globalThis.camT === 'function' ? globalThis.camT(message) : message; }
  function failure(reason) { return { ok: false, reason: reason, message: say(MESSAGES[reason]) }; }

  // ---------------------------------------------------------------- bytes

  function utf8(text) { return Array.prototype.slice.call(new TextEncoder().encode(text)); }

  function fromUtf8(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  }

  // CRC-16/CCITT-FALSE: polynomial 0x1021, start 0xFFFF, no reflection, no final xor. ("123456789" gives 0x29B1.)
  function crc16(bytes) {
    var crc = 0xFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (var j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  }

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // base64url without padding
  function toBase64Url(bytes) {
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    if (bytes.length - i === 1) {
      out += ALPHABET[bytes[i] >> 2] + ALPHABET[(bytes[i] << 4) & 63];
    } else if (bytes.length - i === 2) {
      var m = (bytes[i] << 8) | bytes[i + 1];
      out += ALPHABET[m >> 10] + ALPHABET[(m >> 4) & 63] + ALPHABET[(m << 2) & 63];
    }
    return out;
  }

  // Returns the bytes, or null for anything that is not base64url (padding is not accepted).
  function fromBase64Url(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    var bytes = [], bits = 0, value = 0;
    for (var i = 0; i < text.length; i++) {
      value = (value << 6) | ALPHABET.indexOf(text[i]);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((value >> bits) & 255);
        value &= (1 << bits) - 1;
      }
    }
    return bytes;
  }

  // ---------------------------------------------------------------- writing

  function Writer() { this.bytes = []; }
  Writer.prototype.byte = function (n) { this.bytes.push(n & 255); };
  Writer.prototype.varint = function (n) {       // unsigned, 7 bits at a time, low bits first
    while (n >= 128) { this.bytes.push((n % 128) | 128); n = Math.floor(n / 128); }
    this.bytes.push(n);
  };
  Writer.prototype.text = function (s) {
    var b = utf8(s);
    this.varint(b.length);
    for (var i = 0; i < b.length; i++) this.bytes.push(b[i]);
  };

  var stayIndexes = typeof WeakMap === 'function' ? new WeakMap() : null;

  // 'a:123' -> the name of albergue 123, from the guide data
  function stayIndex(data) {
    var index = stayIndexes && stayIndexes.get(data);
    if (index) return index;
    index = {};
    data.stays.forEach(function (s) { index[(s[0] === 0 ? 'a' : 'p') + ':' + s[1]] = s[3]; });
    if (stayIndexes) stayIndexes.set(data, index);
    return index;
  }

  // A place in a journey: a guide place by number (odd), or text (even: twice the length, then the bytes).
  function writePlace(w, name, data) {
    var id = Plan.placeIdByName(name, data);
    if (id !== null && id > 0) w.varint(id * 2 + 1);
    else { var b = utf8(name); w.varint(b.length * 2); b.forEach(function (x) { w.byte(x); }); }
  }

  // A day: a flags byte, then the body for its kind, then its place to stay.
  //   flags: bits 0-1 kind (0 stage, 1 own route, 2 rest day, 3 journey), bit 2 has a stay,
  //          bit 3 journey on the same date as the day before, bits 4-5 kind of stay (0 albergue, 1 private,
  //          2 own), bits 6-7 status (0 Considering, 1 Requested, 2 Booked, 3 Confirmed)
  //   stage: varint stage number          own route: varint count, then each path number
  //   rest day: nothing, except in version 2 as the first day of the plan: its place
  //   journey: the place it starts at, the place it ends at
  //   stay: guide albergue or private: varint accommodation number; own: varint length, utf-8 name
  function writeDay(w, day, index, data, v2) {
    var stay = day.stay, kind = 2, name = '';
    if (stay) {
      kind = STAY_KINDS[stay.k];
      name = stay.name;
      if (kind !== 2 && !(((kind === 0 ? 'a' : 'p') + ':' + stay.id) in stayIndex(data))) kind = 2;   // not in the guide: keep it as the name
    }
    var flags = DAY_TYPES[day.t];
    if (stay) flags |= 4 | (kind << 4) | (Math.max(0, STATUSES.indexOf(stay.status)) << 6);
    if (day.t === 't' && day.same && index > 0) flags |= 8;
    w.byte(flags);
    if (day.t === 's') w.varint(day.stage);
    else if (day.t === 'c') { w.varint(day.paths.length); day.paths.forEach(function (p) { w.varint(p); }); }
    else if (day.t === 't') { writePlace(w, day.from, data); writePlace(w, day.to, data); }
    else if (day.t === 'r' && index === 0 && v2) {
      if (!String(day.at || '').trim()) throw new Error('a rest day at the start needs a place');
      writePlace(w, day.at, data);
    }
    if (stay) {
      if (kind === 2) w.text(name);
      else w.varint(stay.id);
    }
  }

  // The days with more to say, in order: [index, flags]. Flags: bit 0 the stay's booking reference,
  // bits 1-5 (travel days only) how it is made, departure, arrival, reference, notes.
  function extrasOf(state) {
    var out = [];
    state.days.forEach(function (day, index) {
      var flags = 0;
      if (day.stay && day.stay.ref) flags |= 1;
      if (day.t === 't') {
        if (day.mode) flags |= 2;
        if (day.dep !== undefined) flags |= 4;
        if (day.arr !== undefined) flags |= 8;
        if (day.ref) flags |= 16;
        if (day.notes) flags |= 32;
      }
      if (flags) out.push([index, flags]);
    });
    return out;
  }

  // Version 2 only: a count, then for each day with extras: its position (varint), a flags byte, and in
  // this order what the flags name: stay reference (text), way (1 + position in MODES), departure and
  // arrival (varint, minutes after midnight), travel reference (text), travel notes (text).
  function writeExtras(w, state, entries) {
    w.varint(entries.length);
    entries.forEach(function (entry) {
      var day = state.days[entry[0]], flags = entry[1];
      w.varint(entry[0]);
      w.byte(flags);
      if (flags & 1) w.text(day.stay.ref);
      if (flags & 2) w.byte(MODES.indexOf(day.mode) + 1);
      if (flags & 4) w.varint(day.dep);
      if (flags & 8) w.varint(day.arr);
      if (flags & 16) w.text(day.ref);
      if (flags & 32) w.text(day.notes);
    });
  }

  function daysSinceEpoch(iso) {
    return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(EPOCH + 'T00:00:00Z')) / 86400000);
  }

  // Returns { bytes, text, notes }. `notes` lists anything the code leaves out.
  function encode(state, data) {
    var w = new Writer(), notes = [];
    var guide = String(data.guide || '');
    if (!/^[0-9a-f]{8,}/.test(guide)) throw new Error('the guide data has no fingerprint');
    var extras = extrasOf(state), v2 = extras.length > 0 || (state.days.length > 0 && state.days[0].t === 'r');
    w.byte(v2 ? 2 : 1);
    for (var i = 0; i < 4; i++) w.byte(parseInt(guide.substr(i * 2, 2), 16));
    w.byte(Math.min(255, Math.max(0, Math.round(state.pace * 10))));
    var date = 0;
    if (state.startDate) {
      var n = daysSinceEpoch(state.startDate);
      if (n >= 0 && n < 50000) date = n + 1;
      else notes.push('The first day is outside 2000 to 2136, so the code leaves it out.');
    }
    w.varint(date);
    w.text(String(state.name || ''));
    w.varint(state.days.length);
    state.days.forEach(function (day, index) { writeDay(w, day, index, data, v2); });
    if (v2) writeExtras(w, state, extras);
    var crc = crc16(w.bytes);
    w.byte(crc >> 8);
    w.byte(crc);
    return { bytes: w.bytes, text: toBase64Url(w.bytes), notes: notes, version: v2 ? 2 : 1 };
  }

  // ---------------------------------------------------------------- reading

  function Reader(bytes) { this.bytes = bytes; this.pos = 0; this.end = bytes.length; }
  function Bad() { this.bad = true; }
  Reader.prototype.byte = function () {
    if (this.pos >= this.end) throw new Bad();
    return this.bytes[this.pos++];
  };
  Reader.prototype.varint = function () {        // up to 4 bytes (28 bits); nothing here is bigger
    var value = 0, scale = 1;
    for (var i = 0; i < 4; i++) {
      var b = this.byte();
      value += (b & 127) * scale;
      if (b < 128) return value;
      scale *= 128;
    }
    throw new Bad();
  };
  Reader.prototype.take = function (n, limit) {
    if (n > limit || this.pos + n > this.end) throw new Bad();
    var out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };
  Reader.prototype.text = function (limit) {
    var bytes = this.take(this.varint(), limit);
    try { return fromUtf8(bytes); } catch (e) { throw new Bad(); }
  };

  function readPlace(r, data) {
    var v = r.varint();
    if (v % 2 === 1) {
      var id = (v - 1) / 2, name = data.places[String(id)];
      if (typeof name !== 'string') throw new Unknown();
      return name;
    }
    var bytes = r.take(v / 2, MAX_PLACE_BYTES);
    try { return fromUtf8(bytes); } catch (e) { throw new Bad(); }
  }

  function Unknown() { this.unknown = true; }

  function readDay(r, data, index, version) {
    var flags = r.byte(), type = TYPE_LETTERS[flags & 3], day, i;
    if (type === 's') {
      var stage = r.varint();
      if (!data.stages[String(stage)]) throw new Unknown();
      day = { t: 's', stage: stage, stay: null };
    } else if (type === 'c') {
      var count = r.varint();
      if (count < 1 || count > MAX_PATHS) throw new Bad();
      var paths = [];
      for (i = 0; i < count; i++) paths.push(r.varint());
      day = { t: 'c', paths: paths, stay: null };
    } else if (type === 'r') {
      day = { t: 'r', stay: null };
      if (version >= 2 && index === 0) {     // the first day has no day before to say where it is
        day.at = readPlace(r, data).trim();
        if (!day.at) throw new Bad();
      }
    } else {
      day = { t: 't', from: readPlace(r, data), to: readPlace(r, data), stay: null, same: (flags & 8) !== 0 };
    }
    if (type !== 't' && (flags & 8)) throw new Bad();
    if (flags & 4) {
      var kind = (flags >> 4) & 3, status = STATUSES[flags >> 6];
      if (kind === 3) throw new Bad();
      if (kind === 2) {
        var name = r.text(MAX_STAY_BYTES).trim();
        if (!name) throw new Bad();
        day.stay = { k: 'c', id: 0, name: name, status: status };
      } else {
        var id = r.varint(), found = stayIndex(data)[(kind === 0 ? 'a' : 'p') + ':' + id];
        if (typeof found !== 'string') throw new Unknown();
        day.stay = { k: KIND_LETTERS[kind], id: id, name: found, status: status };
      }
    } else if ((flags & 0xF0) !== 0) throw new Bad();   // stay bits without a stay
    return day;
  }

  // Text that may not be empty and may not be longer than `chars` characters.
  function readLimited(r, byteLimit, chars) {
    var s = r.text(byteLimit).trim();
    if (!s || s.length > chars) throw new Bad();
    return s;
  }

  function readMinutes(r) {
    var m = r.varint();
    if (m > 1439) throw new Bad();
    return m;
  }

  // The extras section (see writeExtras), put onto the days already read.
  function readExtras(r, days) {
    var count = r.varint(), last = -1;
    if (count > days.length) throw new Bad();
    for (var n = 0; n < count; n++) {
      var index = r.varint(), flags = r.byte();
      if (index <= last || index >= days.length || flags === 0 || (flags & 0xC0)) throw new Bad();
      last = index;
      var day = days[index];
      if (flags & 1) {
        if (!day.stay) throw new Bad();
        day.stay.ref = readLimited(r, MAX_REF_BYTES, Plan.MAX_REF);
      }
      if ((flags & 0x3E) && day.t !== 't') throw new Bad();
      if (flags & 2) {
        var mode = r.byte();
        if (mode < 1 || mode > MODES.length) throw new Bad();
        day.mode = MODES[mode - 1];
      }
      if (flags & 4) day.dep = readMinutes(r);
      if (flags & 8) day.arr = readMinutes(r);
      if (flags & 16) day.ref = readLimited(r, MAX_REF_BYTES, Plan.MAX_REF);
      if (flags & 32) day.notes = readLimited(r, MAX_NOTES_BYTES, Plan.MAX_TRAVEL_NOTES);
    }
  }

  // Reads a plan code. Returns { ok: true, state } (a state already passed through the planner's own
  // clean-up), or { ok: false, reason: 'damaged' | 'version' | 'guide' | 'unknown', message }.
  function decode(text, data) {
    var bytes = fromBase64Url(text);
    if (!bytes || bytes.length < 10) return failure('damaged');
    var version = bytes[0];
    if (version < 1 || version > VERSION) return failure(version > VERSION ? 'version' : 'damaged');
    var body = bytes.slice(0, bytes.length - 2), crc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    if (crc16(body) !== crc) return failure('damaged');
    var guide = String(data.guide || '');
    for (var i = 0; i < 4; i++) {
      if (bytes[1 + i] !== parseInt(guide.substr(i * 2, 2), 16)) return failure('guide');
    }
    try {
      var r = new Reader(body);
      r.pos = 5;
      var pace = r.byte() / 10, date = r.varint(), name = r.text(MAX_NAME_BYTES), count = r.varint();
      if (count > MAX_DAYS) throw new Bad();
      var days = [];
      for (var k = 0; k < count; k++) days.push(readDay(r, data, k, version));
      if (version >= 2) readExtras(r, days);
      if (r.pos !== r.end) throw new Bad();
      var startDate = '';
      if (date > 0) {
        startDate = Plan.addDays(EPOCH, date - 1);
        if (!Plan.isIsoDate(startDate)) throw new Bad();
      }
      var state = Plan.clean({ v: 1, name: name, startDate: startDate, pace: pace, days: days }, data);
      // clean() quietly drops what it cannot use; a code that loses anything is refused instead
      if (state.days.length !== days.length) throw new Unknown();
      for (var d = 0; d < days.length; d++) {
        if (!!state.days[d].stay !== !!days[d].stay) throw new Unknown();
        if (!sameExtras(state.days[d], days[d])) throw new Unknown();
      }
      if (date > 0 && !state.startDate) throw new Bad();
      return { ok: true, state: state };
    } catch (e) {
      if (e && e.unknown) return failure('unknown');
      if (e && e.bad) return failure('damaged');
      throw e;
    }
  }

  // True when clean() kept everything version 2 carries: the place of a first rest day, a stay's reference,
  // and a travel day's way, times, reference and notes.
  function sameExtras(a, b) {
    var keys = ['at', 'mode', 'dep', 'arr', 'ref', 'notes'], i;
    for (i = 0; i < keys.length; i++) if (a[keys[i]] !== b[keys[i]]) return false;
    return (a.stay ? a.stay.ref : undefined) === (b.stay ? b.stay.ref : undefined);
  }

  // ---------------------------------------------------------------- links

  // The page the code opens: its own address, then #p=<code>. The code is in the fragment, which the
  // browser never sends to a server.
  function toUrl(pageUrl, code) {
    return String(pageUrl).split('#')[0] + '#p=' + code;
  }

  // The code from a link (or just a fragment, "#p=..." or "p=..."). Null when there is none.
  function fromUrl(text) {
    var s = String(text || '').trim(), at = s.indexOf('#');
    if (at >= 0) s = s.slice(at + 1);
    var m = /^p=([A-Za-z0-9_-]+)$/.exec(s);
    return m ? m[1] : null;
  }

  return {
    VERSION: VERSION, encode: encode, decode: decode, toUrl: toUrl, fromUrl: fromUrl,
    crc16: crc16, toBase64Url: toBase64Url, fromBase64Url: fromBase64Url
  };
});
