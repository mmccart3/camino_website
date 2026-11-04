// camino/jstests/plan-share.test.js
// Tests for the plan code (camino/static/camino/js/plan-share.js): a plan as a short code for a QR code or link.
// Run from the project folder with:  node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../static/camino/js/plan-core.js');
const S = require('../static/camino/js/plan-share.js');

const FLAT = Math.exp(-2.25 * 0.07);

// A tiny guide: Alpha (1) to Bravo (2) by the main road through Midway (4) or by the hills, then Bravo to Charlie (3).
//   path 11  Alpha to Midway   stage 1      path 13  Alpha to Bravo   stage 2 (the hills)
//   path 12  Midway to Bravo   stage 1      path 14  Bravo to Charlie stage 3
// Each path row: [id, origin, destination, stage, distance, weighted, first distance, first weighted, shape].
const data = {
  v: 1, guide: '0123456789abcdef', flat: FLAT, pace: { default: 4.2, min: 2, max: 6 },
  sections: [{ n: 1, stages: [1, 2] }, { n: 2, stages: [3] }],
  stages: {
    '1': { ref: '1', name: 'Alpha to Bravo', start: 1, finish: 2, m: 20000, w: 25000, paths: [11, 12], section: 1, kind: 'main' },
    '2': { ref: '2', name: 'Alpha to Bravo via the hills', start: 1, finish: 2, m: 21000, w: 29000, paths: [13], section: 1, kind: 'mountain' },
    '3': { ref: '3', name: 'Bravo to Charlie', start: 2, finish: 3, m: 15000, w: 16000, paths: [14], section: 2, kind: 'main' }
  },
  places: { '1': 'St Jean Pied de Port', '2': 'Bravo', '3': 'Charlie', '4': 'Midway', '5': 'A fountain' },
  routes: {
    paths: [
      [11, 1, 4, 1, 9050, 11060, 50, 60, 'aaaa'],
      [12, 4, 2, 1, 11000, 14000, 40, 45, 'bbbb'],
      [13, 1, 2, 2, 21050, 29050, 50, 50, 'cccc'],
      [14, 2, 3, 3, 15060, 16070, 60, 70, 'dddd']
    ],
    next: { '11': [[12, 1]], '12': [[14, 0]], '13': [[14, 0]] }
  },
  stays: [[0, 100, 2, 'Albergue Bravo'], [1, 200, 2, 'Hotel Bravo'], [0, 300, 3, 'Albergue Charlie'], [0, 400, 4, 'Albergue Midway']],
  skipped: []
};

// What a round trip should give back: the plan, except that a journey place that is a guide place comes back
// under the guide's own name ("Saint Jean Pied de Port" becomes "St Jean Pied de Port").
function expected(state) {
  const s = P.clean(state, data);
  s.days.forEach((d) => {
    if (d.t !== 't' && !(d.t === 'r' && d.at)) return;
    (d.t === 't' ? ['from', 'to'] : ['at']).forEach((k) => {
      const id = P.placeIdByName(d[k], data);
      if (id !== null && id > 0) d[k] = data.places[id];
    });
  });
  return s;
}

const NOW = '2026-11-01T12:00:00.000000Z';

function bigPlan() {
  let s = P.setMeta(P.newState(data), { name: 'Pelgrimstocht été ☀️', startDate: '2027-04-20', pace: 3.7 }, data);
  s = P.setTravel(P.addTravel(s, data), 0, { from: 'Madrid Barajas', to: 'Saint Jean Pied de Port' });   // by name, in the guide
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Considering' }, data);       // (a stay on a journey is allowed)
  s = P.addStage(s, 1);                                                                                  // Alpha to Bravo
  s = P.setStay(s, 1, { k: 'p', id: 200, name: 'Hotel Bravo', status: 'Booked' }, data);
  s = P.addRest(s);
  s = P.setStay(s, 2, { k: 'c', id: 0, name: 'Casa de la Ñ — near the bridge', status: 'Confirmed' }, data);
  s = P.addRoute(s, [14], data);                                                                         // Bravo to Charlie (stage 3)
  s = P.setStay(s, 3, { k: 'a', id: 300, name: 'Albergue Charlie', status: 'Requested' }, data);
  s = P.setTravel(P.addTravel(s, data, undefined, true), 4, { to: 'Madrid' });                           // the bus on, the same day
  return s;
}

test('CRC-16 gives the standard check value', () => {
  assert.strictEqual(S.crc16(Array.from(Buffer.from('123456789'))), 0x29B1);
  assert.strictEqual(S.crc16([]), 0xFFFF);
});

test('base64url round-trips every length, and refuses anything else', () => {
  let seed = 7;
  for (let n = 0; n <= 40; n++) {
    const bytes = [];
    for (let i = 0; i < n; i++) { seed = (seed * 31 + 17) % 251; bytes.push(seed); }
    const text = S.toBase64Url(bytes);
    assert.ok(/^[A-Za-z0-9_-]*$/.test(text));
    assert.deepStrictEqual(S.fromBase64Url(text), bytes);
    assert.strictEqual(text, Buffer.from(bytes).toString('base64url'));
  }
  assert.strictEqual(S.fromBase64Url('abc='), null);        // no padding
  assert.strictEqual(S.fromBase64Url('ab+/'), null);        // not the url-safe alphabet
  assert.strictEqual(S.fromBase64Url('a'), null);           // cannot be a whole number of bytes
  assert.strictEqual(S.fromBase64Url(null), null);
});

test('a plan survives the round trip: stages, own routes, rest days, journeys, all three kinds of stay', () => {
  const s = bigPlan();
  const e = S.encode(s, data);
  assert.deepStrictEqual(e.notes, []);
  const back = S.decode(e.text, data);
  assert.strictEqual(back.ok, true, back.message);
  assert.deepStrictEqual(back.state, expected(s));
  // and what the app would be sent is the same file
  assert.deepStrictEqual(P.buildFile(back.state, data, NOW).plans, P.buildFile(expected(s), data, NOW).plans);
  assert.deepStrictEqual(P.checkFile(P.buildFile(back.state, data, NOW)), []);
});

test('an empty plan, and a plan with no date, name or stays', () => {
  const empty = S.decode(S.encode(P.newState(data), data).text, data);
  assert.deepStrictEqual(empty.state, P.newState(data));
  let s = P.addStage(P.newState(data), 3);
  s.name = '';
  const back = S.decode(S.encode(s, data).text, data);
  assert.strictEqual(back.ok, true);
  assert.deepStrictEqual(back.state, P.clean(s, data));
});

test('the format is fixed: a known plan gives a known code', () => {
  let s = P.setMeta(P.newState(data), { name: 'Test', startDate: '2027-04-10', pace: 4 }, data);
  s = P.addStage(s, 1);
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.addRest(s);
  s = P.setTravel(P.addTravel(s, data, undefined, true), 2, { to: 'Madrid' });
  const e = S.encode(s, data);
  // 01 version | 01234567 guide | 28 pace | ea4d first day | 04 'Test' | 03 days:
  //   84 01 64   stage 1, albergue 100, Booked     02   rest day     0b 05 0c 'Madrid'   same-day journey from place 2 to 'Madrid'
  // then the checksum 6041
  assert.strictEqual(Buffer.from(e.bytes).toString('hex'), '010123456728ea4d045465737403840164020b050c4d61647269646041');
});

test('each reason a code is refused gives its own answer', () => {
  const good = S.encode(bigPlan(), data);
  const ok = S.decode(good.text, data);
  assert.strictEqual(ok.ok, true);
  // cut off, and one character changed
  assert.strictEqual(S.decode(good.text.slice(0, -3), data).reason, 'damaged');
  const flipped = good.text.slice(0, 20) + (good.text[20] === 'A' ? 'B' : 'A') + good.text.slice(21);
  assert.strictEqual(S.decode(flipped, data).reason, 'damaged');
  assert.strictEqual(S.decode('', data).reason, 'damaged');
  assert.strictEqual(S.decode('not a code!', data).reason, 'damaged');
  // a newer format version than this page knows (versions 1 and 2 are read), with a valid checksum
  const bytes = good.bytes.slice(0, -2);
  bytes[0] = 3;
  const crc = S.crc16(bytes);
  assert.strictEqual(S.decode(S.toBase64Url(bytes.concat([crc >> 8, crc & 255])), data).reason, 'version');
  // made for another edition of the guide
  const other = Object.assign({}, data, { guide: 'ffffffffffffffff' });
  assert.strictEqual(S.decode(good.text, other).reason, 'guide');
  // refers to a stage that is not there
  const gone = P.clean(bigPlan(), data);
  gone.days[1] = { t: 's', stage: 99, stay: null };
  assert.strictEqual(S.decode(S.encode(gone, data).text, data).reason, 'unknown');
  // a place to stay the guide does not have
  const richer = Object.assign({}, data, { stays: data.stays.concat([[0, 999, 2, 'Albergue New']]) });
  let withNew = P.addStage(P.newState(richer), 1);
  withNew = P.setStay(withNew, 0, { k: 'a', id: 999, name: 'Albergue New', status: 'Considering' }, richer);
  assert.strictEqual(S.decode(S.encode(withNew, richer).text, data).reason, 'unknown');
  // every refusal carries words for the visitor
  ['damaged', 'version', 'guide', 'unknown'].forEach((r) => assert.ok(S.decode(r === 'guide' ? good.text : '!', r === 'guide' ? other : data).message.length > 20));
});

test('a stay that is not in the guide is kept by name', () => {
  let s = P.addStage(P.newState(data), 1);
  s = P.setStay(s, 0, { k: 'a', id: 424242, name: 'Albergue Gone', status: 'Requested' }, data);
  const back = S.decode(S.encode(s, data).text, data);
  assert.strictEqual(back.ok, true);
  assert.deepStrictEqual(back.state.days[0].stay, { k: 'c', id: 0, name: 'Albergue Gone', status: 'Requested' });
});

test('dates: the range of the code, and what it leaves out', () => {
  ['2000-01-01', '2027-04-10', '2100-02-28', '2136-01-01'].forEach((date) => {
    const s = P.setMeta(P.addStage(P.newState(data), 1), { startDate: date }, data);
    assert.strictEqual(S.decode(S.encode(s, data).text, data).state.startDate, date);
  });
  const early = P.setMeta(P.addStage(P.newState(data), 1), { startDate: '1999-12-31' }, data);
  const e = S.encode(early, data);
  assert.strictEqual(e.notes.length, 1);
  assert.strictEqual(S.decode(e.text, data).state.startDate, '');
});

test('links: the code goes after #p=, and comes back out of a link, a fragment or the bare text', () => {
  const url = S.toUrl('https://example.test/plan/?x=1#old', 'abc_-123');
  assert.strictEqual(url, 'https://example.test/plan/?x=1#p=abc_-123');
  assert.strictEqual(S.fromUrl(url), 'abc_-123');
  assert.strictEqual(S.fromUrl('#p=abc'), 'abc');
  assert.strictEqual(S.fromUrl('p=abc'), 'abc');
  assert.strictEqual(S.fromUrl('  https://example.test/plan/#p=abc\n'), 'abc');
  assert.strictEqual(S.fromUrl('https://example.test/plan/'), null);
  assert.strictEqual(S.fromUrl('https://example.test/plan/#q=abc'), null);
  assert.strictEqual(S.fromUrl('https://example.test/plan/#p=ab c'), null);
  assert.strictEqual(S.fromUrl(''), null);
  assert.strictEqual(S.fromUrl(undefined), null);
});

// ------------------------------------------------------------------ hostile and damaged input

function withHeader(body) {         // a code that passes the version, guide and checksum tests, with the given content after them
  const bytes = [1, 0x01, 0x23, 0x45, 0x67].concat(body);
  const crc = S.crc16(bytes);
  return S.toBase64Url(bytes.concat([crc >> 8, crc & 255]));
}

test('whatever the content, reading a code never throws and only gives back plans the planner accepts', () => {
  let seed = 99;
  function next(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; }
  function pick(list) { return list[next(list.length)]; }
  function text(s2) { return [s2.length].concat(Array.from(Buffer.from(s2))); }
  function place() { return next(2) ? [pick([1, 2, 3, 4, 5, 99]) * 2 + 1] : [12].concat(Array.from(Buffer.from('Madrid'))); }
  function randomDay() {
    const type = next(4), stay = next(3) === 0, kind = next(4), same = next(4) === 0;
    let flags = type | (stay ? 4 : 0) | (same ? 8 : 0) | (stay ? kind << 4 : 0) | (stay ? next(4) << 6 : 0);
    if (next(30) === 0) flags |= 0x30;      // stay bits without a stay, or the unused kind
    const out = [flags];
    if (type === 0) out.push(pick([1, 2, 3, 99]));
    else if (type === 1) { const n = 1 + next(3); out.push(n); for (let i = 0; i < n; i++) out.push(pick([11, 12, 13, 14, 99])); }
    else if (type === 3) out.push(...place(), ...place());
    if (stay) { if (kind === 2 || next(8) === 0) out.push(...text(pick(['Own', '', 'Casa Ñ']))); else out.push(pick([100, 200, 300, 400, 999])); }
    return out;
  }
  let accepted = 0, refused = 0;
  for (let round = 0; round < 6000; round++) {
    let body;
    if (round % 4 === 0) {                                           // plain noise, with small numbers so that it reaches further
      body = [30 + next(20)];
      for (let n = next(40), i = 0; i < n; i++) body.push(next(round % 8 === 0 ? 256 : 12));
    } else {                                                         // the right shape, with some wrong parts
      body = [30 + next(20), next(3) === 0 ? 0 : 0xEA, ...(next(2) ? [0x4D] : []), ...text(pick(['', 'Plan', 'Pé'])), 0];
      const days = [];
      for (let n = next(6), i = 0; i < n; i++) days.push(randomDay());
      body = body.slice(0, body.length - 1).concat([days.length].concat(...days));
      if (next(10) === 0) body.push(next(256));                      // a stray byte
    }
    let result;
    assert.doesNotThrow(() => { result = S.decode(withHeader(body), data); });
    if (!result.ok) { refused++; assert.ok(['damaged', 'unknown'].includes(result.reason), result.reason); continue; }
    accepted++;
    assert.deepStrictEqual(P.clean(result.state, data), result.state);
    // a plan may have a day the planner flags (a rest day before any walking); the page shows that, and the file waits until it is fixed
    if (result.state.days.length && !P.layout(result.state, data).days.some((d) => d.invalid)) assert.deepStrictEqual(P.checkFile(P.buildFile(result.state, data, NOW)), []);
  }
  assert.ok(accepted > 300 && refused > 300, 'accepted ' + accepted + ', refused ' + refused);
});

test('limits: too many days, a text that is not UTF-8, a varint that does not end, bytes left over', () => {
  const name = [0];                                                  // an empty name
  assert.strictEqual(S.decode(withHeader([42, 0].concat(name, [121])), data).reason, 'damaged');         // 121 days
  assert.strictEqual(S.decode(withHeader([42, 0, 2, 0xC3, 0x28, 0]), data).reason, 'damaged');            // a name that is not UTF-8
  assert.strictEqual(S.decode(withHeader([42, 0x80, 0x80, 0x80, 0x80, 0x80, 1]), data).reason, 'damaged');   // a date that never ends
  assert.strictEqual(S.decode(withHeader([42, 0].concat(name, [0, 7])), data).reason, 'damaged');         // a day count of 0 and a byte left over
  assert.strictEqual(S.decode(withHeader([42, 0].concat(name, [1, 0x80 | 2])), data).reason, 'damaged'); // stay bits on a day with no stay
});

test('round trip on many random plans', () => {
  let seed = 5;
  function next(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; }
  const names = ['', 'A', 'Casa X', 'Hostal Álvaro', 'Zoë', 'a'.repeat(80)];
  for (let round = 0; round < 300; round++) {
    let s = P.setMeta(P.newState(data), { name: names[next(names.length)], startDate: next(2) ? '2027-0' + (1 + next(9)) + '-1' + next(9) : '', pace: 2 + next(41) / 10 }, data);
    const days = 1 + next(12);
    for (let i = 0; i < days; i++) {
      const kind = next(6);
      if (kind === 0) s = P.addStage(s, 1 + next(3));
      else if (kind === 1) s = P.addRoute(s, [[11], [12], [11, 12], [13], [14], [12, 14]][next(6)], data);
      else if (kind === 2) {
        s = P.addRest(s);
        if (s.days.length === 1) s = P.setRestPlace(s, 0, ['Bravo', 'Madrid', 'Charlie', 'Saint Jean Pied de Port', 'Ñ'][next(5)]);
      }
      else if (kind === 3) {
        s = P.setTravel(P.addTravel(s, data, undefined, next(2) === 1), s.days.length, { to: ['Madrid', 'Charlie', '', 'Bravo'][next(4)] });
        if (next(2)) s = P.setTravel(s, s.days.length - 1, { mode: P.MODES[next(P.MODES.length)], dep: next(2) ? next(1440) : null, arr: next(2) ? next(1440) : null, ref: ['', 'TK 7', 'Ñandú-1'][next(3)], notes: ['', 'Gate 4', 'Ring the bell ☎'][next(3)] });
      }
      if (s.days.length && next(3) === 0) {
        const k = next(3), at = next(s.days.length), status = P.STATUSES[next(4)];
        const stay = k === 0 ? { k: 'a', id: [100, 300, 400][next(3)], name: 'x', status } : k === 1 ? { k: 'p', id: 200, name: 'x', status } : { k: 'c', id: 0, name: 'Own place ' + next(9), status };
        s = P.setStay(s, at, stay, data);
        if (next(2)) s = P.setStayDetails(s, at, { ref: ['AB-12', 'Reserva 7', 'ñ'][next(3)], notes: 'not in the code', contact: '+34 1' });
      }
    }
    const back = S.decode(S.encode(s, data).text, data);
    assert.strictEqual(back.ok, true, back.message);
    const want = expected(s);
    // a guide stay's name comes from the guide, whatever the plan carried
    want.days.forEach((d) => { if (d.stay && d.stay.k !== 'c') d.stay.name = data.stays.find((x) => x[1] === d.stay.id)[3]; });
    // a stay's notes and contact go in the file only, never in the code
    want.days.forEach((d) => { if (d.stay) { delete d.stay.notes; delete d.stay.contact; } });
    assert.deepStrictEqual(back.state, want);
  }
});

// ------------------------------------------------------------------ version 2: a first rest day, references, travel details

function v2Plan() {
  let s = P.setMeta(P.newState(data), { name: 'Test', startDate: '2027-04-10', pace: 4 }, data);
  s = P.setRestPlace(P.addRest(s), 0, 'Bravo');
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.setStayDetails(s, 0, { ref: 'AB1', notes: 'file only', contact: 'file only' });
  s = P.addStage(s, 1);
  s = P.setTravel(P.addTravel(s, data, undefined, true), 2, { to: 'Madrid', mode: 'train', dep: 545, arr: 780, ref: 'T7', notes: 'Gate 4' });
  return s;
}

test('version 2 is used only when the plan needs it', () => {
  assert.strictEqual(S.encode(S.decode(S.encode(bigPlan(), data).text, data).state, data).version, 1);
  assert.strictEqual(S.encode(P.addStage(P.newState(data), 1), data).version, 1);
  assert.strictEqual(S.encode(P.newState(data), data).version, 1);
  assert.strictEqual(S.encode(v2Plan(), data).version, 2);
  // each thing that needs it, on its own
  const rest = P.setRestPlace(P.addRest(P.newState(data)), 0, 'Bravo');
  const ref = P.setStayDetails(P.setStay(P.addStage(P.newState(data), 1), 0, { k: 'a', id: 100, name: 'x', status: 'Booked' }, data), 0, { ref: 'R' });
  const trip = P.setTravel(P.addTravel(P.addStage(P.newState(data), 1), data), 1, { to: 'Madrid', mode: 'bus' });
  [rest, ref, trip].forEach((s) => assert.strictEqual(S.encode(s, data).version, 2));
  // notes and a contact on a stay never need it
  const quiet = P.setStayDetails(P.setStay(P.addStage(P.newState(data), 1), 0, { k: 'a', id: 100, name: 'x', status: 'Booked' }, data), 0, { notes: 'n', contact: 'c' });
  assert.strictEqual(S.encode(quiet, data).version, 1);
});

test('version 2: the format is fixed', () => {
  const e = S.encode(v2Plan(), data);
  // 02 version | 01234567 guide | 28 pace | ea4d first day | 04 'Test' | 03 days
  //   86 05 64     rest day, albergue Booked, as the first day at place 2; albergue 100
  //   00 01        stage 1
  //   0b 05 0c 'Madrid'   same-day journey from place 2 to 'Madrid'
  // extras: 02 entries
  //   00 01 03 'AB1'                       day 0: stay reference
  //   02 3e 02 a104 8c06 02 'T7' 06 'Gate 4'   day 2: train, 09:05, 13:00, reference, notes
  const body = '020123456728ea4d0454657374' + '03' + '860564' + '0001' + '0b050c4d6164726964' +
    '02' + '000103414231' + '023e02a1048c0602' + '5437' + '06' + '476174652034';
  const crc = S.crc16(Array.from(Buffer.from(body, 'hex')));
  assert.strictEqual(Buffer.from(e.bytes).toString('hex'), body + crc.toString(16).padStart(4, '0'));
  assert.strictEqual(S.encode(v2Plan(), data).text.length, Math.ceil((body.length / 2 + 2) * 4 / 3));
});

test('version 2: everything comes back, except a stay\'s notes and contact', () => {
  const s = v2Plan();
  const back = S.decode(S.encode(s, data).text, data);
  assert.strictEqual(back.ok, true, back.message);
  const want = expected(s);
  want.days.forEach((d) => { if (d.stay) { delete d.stay.notes; delete d.stay.contact; } });
  want.days[0].stay.name = 'Albergue Bravo';
  assert.deepStrictEqual(back.state, want);
  assert.strictEqual(back.state.days[0].at, 'Bravo');
  assert.strictEqual(back.state.days[0].stay.ref, 'AB1');
  const t = back.state.days[2];
  assert.deepStrictEqual([t.mode, t.dep, t.arr, t.ref, t.notes, t.same], ['train', 545, 780, 'T7', 'Gate 4', true]);
  assert.deepStrictEqual(P.checkFile(P.buildFile(back.state, data, NOW)), []);
});

test('version 1 still opens; a first rest day in a version 1 code is flagged, not refused', () => {
  const old = S.decode(withHeader([42, 0, 0, 1, 0x02]), data);       // 1 day: a rest day, no place
  assert.strictEqual(old.ok, true);
  assert.match(P.layout(old.state, data).days[0].invalid, /where this rest day is/);
});

// A version 2 code made from the bytes after the guide fingerprint, with a valid checksum.
function v2(body) {
  const bytes = [2, 0x01, 0x23, 0x45, 0x67].concat(body);
  const crc = S.crc16(bytes);
  return S.toBase64Url(bytes.concat([crc >> 8, crc & 255]));
}
const HEAD = [42, 0, 0];                                  // pace, no date, an empty name
function varint(n) { const out = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; }
const text = (t) => varint(Buffer.byteLength(t)).concat(Array.from(Buffer.from(t)));

test('version 2: each kind of damage is refused', () => {
  const stayDay = [4 | 0 | (2 << 6), 1, 100];              // a stage 1 day with albergue 100, Booked
  const stageDay = [0, 1];
  const journey = [3, 5, 5];                               // a journey from place 2 to place 2
  const ok = (days, extras) => S.decode(v2(HEAD.concat([days.length], ...days, extras)), data);
  assert.strictEqual(ok([stageDay], [0]).ok, true);                                    // no extras at all
  assert.strictEqual(ok([stayDay], [1, 0, 1, ...text('R1')]).ok, true);
  // a first rest day needs its place
  assert.strictEqual(S.decode(v2(HEAD.concat([1, 2], [0])), data).reason, 'damaged');
  assert.strictEqual(S.decode(v2(HEAD.concat([1, 2, 0], [0])), data).reason, 'damaged');   // an empty place
  assert.strictEqual(S.decode(v2(HEAD.concat([1, 2, 5], [0])), data).ok, true);
  assert.strictEqual(S.decode(v2(HEAD.concat([1, 2, 99 * 2 + 1], [0])), data).reason, 'unknown');   // a place the guide lacks
  // the extras section must be there, and must end the code
  assert.strictEqual(S.decode(v2(HEAD.concat([1], stageDay)), data).reason, 'damaged');
  assert.strictEqual(ok([stageDay], [0, 7]).reason, 'damaged');                         // a byte left over
  assert.strictEqual(ok([stageDay], [2]).reason, 'damaged');                            // more entries than days
  // entries: in order, in range, with something to say, with nothing reserved
  assert.strictEqual(ok([stayDay, stayDay], [2, 1, 1, ...text('A'), 0, 1, ...text('B')]).reason, 'damaged');   // out of order
  assert.strictEqual(ok([stayDay, stayDay], [2, 0, 1, ...text('A'), 0, 1, ...text('B')]).reason, 'damaged');   // the same day twice
  assert.strictEqual(ok([stayDay], [1, 1, 1, ...text('A')]).reason, 'damaged');         // day 1 does not exist
  assert.strictEqual(ok([stayDay], [1, 0, 0]).reason, 'damaged');                       // flags say nothing
  assert.strictEqual(ok([stayDay], [1, 0, 0x41, ...text('A')]).reason, 'damaged');      // reserved bit
  assert.strictEqual(ok([stayDay], [1, 0, 0x81, ...text('A')]).reason, 'damaged');      // reserved bit
  // a stay reference needs a stay; travel parts need a journey
  assert.strictEqual(ok([stageDay], [1, 0, 1, ...text('A')]).reason, 'damaged');
  assert.strictEqual(ok([stageDay], [1, 0, 2, 1]).reason, 'damaged');
  assert.strictEqual(ok([stayDay], [1, 0, 4, 0]).reason, 'damaged');
  assert.strictEqual(ok([journey], [1, 0, 2, 1]).ok, true);
  // each value in range
  assert.strictEqual(ok([journey], [1, 0, 2, 0]).reason, 'damaged');                    // way 0
  assert.strictEqual(ok([journey], [1, 0, 2, 7]).reason, 'damaged');                    // way 7 (there are 6)
  assert.strictEqual(ok([journey], [1, 0, 2, 6]).ok, true);
  assert.strictEqual(ok([journey], [1, 0, 4, 0xDF, 0x0B]).reason, 'damaged');           // 1503
  assert.strictEqual(ok([journey], [1, 0, 4, 0x9F, 0x0B]).ok, true);                    // 1439
  assert.strictEqual(ok([journey], [1, 0, 8, 0xA0, 0x0B]).reason, 'damaged');           // 1440
  // text: not empty, not too long, valid UTF-8
  assert.strictEqual(ok([stayDay], [1, 0, 1, 0]).reason, 'damaged');
  assert.strictEqual(ok([stayDay], [1, 0, 1, ...text(' ')]).reason, 'damaged');
  assert.strictEqual(ok([stayDay], [1, 0, 1, ...text('x'.repeat(P.MAX_REF))]).ok, true);
  assert.strictEqual(ok([stayDay], [1, 0, 1, ...text('x'.repeat(P.MAX_REF + 1))]).reason, 'damaged');
  assert.strictEqual(ok([stayDay], [1, 0, 1, 2, 0xC3, 0x28]).reason, 'damaged');
  assert.strictEqual(ok([journey], [1, 0, 32, ...text('n'.repeat(P.MAX_TRAVEL_NOTES))]).ok, true);
  assert.strictEqual(ok([journey], [1, 0, 32, ...text('n'.repeat(P.MAX_TRAVEL_NOTES + 1))]).reason, 'damaged');
  assert.strictEqual(ok([journey], [1, 0, 16, ...text('x'.repeat(P.MAX_REF + 1))]).reason, 'damaged');
});

test('version 2: whatever the content, reading a code never throws and only gives back plans the planner accepts', () => {
  let seed = 4242;
  function next(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; }
  function pick(list) { return list[next(list.length)]; }
  function place() { return next(2) ? [pick([1, 2, 3, 4, 5, 99]) * 2 + 1] : (() => { const t = Array.from(Buffer.from(pick(['Madrid', '', 'Ñ']))); return varint(t.length * 2).concat(t); })(); }
  function day(index) {
    const type = next(4), stay = next(3) === 0, kind = next(3), same = next(4) === 0;
    const out = [type | (stay ? 4 | (kind << 4) | (next(4) << 6) : 0) | (same ? 8 : 0)];
    if (type === 0) out.push(pick([1, 2, 3, 99]));
    else if (type === 1) { const n = 1 + next(3); out.push(n); for (let i = 0; i < n; i++) out.push(pick([11, 12, 13, 14])); }
    else if (type === 3) out.push(...place(), ...place());
    else if (type === 2 && index === 0 && next(8) !== 0) out.push(...place());
    if (stay) { if (kind === 2) out.push(...text(pick(['Own', 'Casa Ñ']))); else out.push(pick([100, 200, 300, 400])); }
    return out;
  }
  function entry(at) {
    const flags = next(5) === 0 ? next(256) : next(64);
    const out = [at, flags];
    if (flags & 1) out.push(...text(pick(['R1', '', 'ñ'])));
    if (flags & 2) out.push(next(9));
    if (flags & 4) out.push(...pick([[0], [0xA1, 4], [0x9F, 0x0B], [0xA0, 0x0B]]));
    if (flags & 8) out.push(...pick([[0], [0x8C, 6], [0xFF, 0xFF, 0x7F]]));
    if (flags & 16) out.push(...text(pick(['T7', '', 'x'.repeat(41)])));
    if (flags & 32) out.push(...text(pick(['Gate 4', '', 'n'.repeat(201)])));
    return out;
  }
  let accepted = 0, refused = 0;
  for (let round = 0; round < 8000; round++) {
    const count = next(6), days = [];
    for (let i = 0; i < count; i++) days.push(day(i));
    let extras = [];
    const n = next(4) === 0 ? next(count + 2) : next(Math.min(count, 3) + 1);
    let at = 0;
    for (let i = 0; i < n; i++) { extras = extras.concat(entry(at)); at += next(3) === 0 ? 0 : 1 + next(2); }
    const body = HEAD.concat([count], ...days, [n], extras, next(30) === 0 ? [next(256)] : []);
    let result;
    assert.doesNotThrow(() => { result = S.decode(v2(body), data); });
    if (!result.ok) { refused++; assert.ok(['damaged', 'unknown'].includes(result.reason), result.reason); continue; }
    accepted++;
    assert.deepStrictEqual(P.clean(result.state, data), result.state);
    if (result.state.days.length && !P.layout(result.state, data).days.some((d) => d.invalid)) assert.deepStrictEqual(P.checkFile(P.buildFile(result.state, data, NOW)), []);
    // and it is written again as the same plan
    const again = S.decode(S.encode(result.state, data).text, data);
    assert.strictEqual(again.ok, true, again.message);
    assert.deepStrictEqual(again.state, result.state);
  }
  assert.ok(accepted > 200 && refused > 200, 'accepted ' + accepted + ', refused ' + refused);
});
