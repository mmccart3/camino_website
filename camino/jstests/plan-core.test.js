// camino/jstests/plan-core.test.js
// Tests for the planner's logic (camino/static/camino/js/plan-core.js). No browser or Django needed.
// Run from the project folder with:  node --test      (Node 18 or newer; it finds every *.test.js)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../static/camino/js/plan-core.js');

const FLAT = Math.exp(-2.25 * 0.07);
const data = {
  v: 1, guide: '0123456789abcdef', flat: FLAT, pace: { default: 4.2, min: 2, max: 6 },
  sections: [{ n: 1, stages: [1, 2] }, { n: 2, stages: [3] }],
  stages: {
    '1': { ref: '1', name: 'Alpha to Bravo', start: 1, finish: 2, m: 20000, w: 25000, paths: [11, 12], section: 1, kind: 'main' },
    '2': { ref: '2', name: 'Alpha to Bravo via the hills', start: 1, finish: 2, m: 21000, w: 29000, paths: [13], section: 1, kind: 'mountain' },
    '3': { ref: '3', name: 'Bravo to Charlie', start: 2, finish: 3, m: 15000, w: 16000, paths: [14], section: 2, kind: 'main' }
  },
  places: { '1': 'St Jean Pied de Port', '2': 'Bravo', '3': 'Charlie' },
  stays: [[0, 100, 2, 'Albergue Bravo'], [1, 200, 2, 'Hotel Bravo'], [0, 300, 3, 'Albergue Charlie']],
  skipped: []
};
const NOW = '2026-11-01T12:00:00.000000Z';

function plan() {
  let s = P.newState(data);
  s = P.addStage(s, 1);
  s = P.addStage(s, 3);
  return s;
}

test('walking time follows the app: weighted distance, flat factor, pace, whole seconds', () => {
  assert.strictEqual(P.walkingSeconds(25000, 4.2, FLAT), Math.floor(Math.round(25000 * FLAT / 4.2 * 1e6) / 1e6));
  assert.strictEqual(P.walkingSeconds(25000, 4.2, FLAT), 5084); // fixed value, so a change in the maths shows up
  assert.ok(P.walkingSeconds(25000, 3.5, FLAT) > P.walkingSeconds(25000, 4.2, FLAT));
});

test('first choices are stages that start where no other stage finishes', () => {
  assert.deepStrictEqual(P.nextOptions(P.newState(data), data), { mode: 'start', stages: [1, 2] });
  assert.deepStrictEqual(P.startPlaces(data).map(p => p.name), ['St Jean Pied de Port', 'Bravo']);
});

test('next choices come from where the last day ended, and the end of the guide is recognised', () => {
  const afterOne = P.addStage(P.newState(data), 2);
  const n = P.nextOptions(afterOne, data);
  assert.strictEqual(n.mode, 'next'); assert.deepStrictEqual(n.stages, [3]); assert.strictEqual(n.place.name, 'Bravo');
  assert.strictEqual(P.nextOptions(plan(), data).mode, 'finished');
});

test('a day that starts somewhere else than the last ended gets a warning, not a failure', () => {
  let s = P.addStage(P.addStage(P.newState(data), 3), 1);
  const l = P.layout(s, data);
  assert.match(l.days[1].warning, /starts at St Jean Pied de Port, but the day before ended at Charlie/);
});

test('rest and travel days', () => {
  let s = P.addRest(P.newState(data));
  assert.match(P.layout(s, data).days[0].invalid, /needs a place/);
  s = P.addRest(plan());
  const rest = P.layout(s, data).days[2];
  assert.strictEqual(rest.end.name, 'Charlie'); assert.strictEqual(rest.metres, 0);
  let t = P.addTravel(plan(), data);
  assert.strictEqual(P.layout(t, data).days[2].invalid, 'Say where this journey ends.');
  t = P.setTravel(t, 2, { to: 'saint-jean pied de port' });
  assert.strictEqual(P.layout(t, data).end.id, 1); // forgiving match to a place in the guide
  t = P.setTravel(t, 2, { to: 'Biarritz' });
  assert.ok(P.layout(t, data).end.id < 0);
  assert.strictEqual(P.nextOptions(t, data).mode, 'elsewhere');
});

test('same start and finish means another route for the same stage', () => {
  assert.deepStrictEqual(P.siblings(1, data), [1, 2]);
  assert.deepStrictEqual(P.siblings(3, data), [3]);
  assert.strictEqual(P.layout(P.setStage(plan(), 0, 2), data).days[0].metres, 21000);
});

test('the file has what the app expects for stage, rest, travel and stay rows', () => {
  let s = P.setMeta(plan(), { name: 'Test walk', startDate: '2027-04-10', pace: 3.5 }, data);
  s = P.addRest(s);
  s = P.addTravel(s, data);
  s = P.setTravel(s, 3, { to: 'Madrid' });
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.setStay(s, 1, { k: 'c', id: 0, name: 'Friend', status: 'Considering' }, data);
  const doc = P.buildFile(s, data, NOW);
  assert.deepStrictEqual(P.checkFile(doc), []);
  assert.strictEqual(doc.format, 'camino-personal-backup'); assert.strictEqual(doc.version, 1);
  const [d0, d1, d2, d3] = doc.plans[0].days;
  assert.deepStrictEqual([d0.ordinal, d0.start_id, d0.end_id, d0.metres], [0, 1, 2, 20000]);
  const r0 = JSON.parse(d0.route);
  assert.deepStrictEqual(r0.paths, [11, 12]); assert.strictEqual(r0.pace, 3.5); assert.strictEqual(r0.date, '2027-04-10');
  assert.strictEqual(r0.departureMinutes, 480); assert.strictEqual(r0.id, 'web-01234567-1');
  assert.strictEqual(d0.seconds, P.walkingSeconds(25000, 3.5, FLAT));
  assert.deepStrictEqual(JSON.parse(d0.stay), { id: 100, kind: 'albergue', name: 'Albergue Bravo', status: 'Booked', reference: '', notes: '', contact: '' });
  assert.strictEqual(JSON.parse(d1.stay).kind, 'custom'); assert.ok(JSON.parse(d1.stay).id > 1e15);
  assert.deepStrictEqual([d2.metres, d2.seconds, d2.start_id, d2.end_id], [0, 0, 3, 3]);
  assert.strictEqual(JSON.parse(d2.route).isRestDay, true);
  assert.deepStrictEqual([d3.metres, d3.seconds, d3.start_id < 0 || d3.start_id === 3, d3.end_id < 0], [null, null, true, true]);
  assert.strictEqual(d3.stay, null);
});

test('an incomplete plan cannot be turned into a file', () => {
  assert.throws(() => P.buildFile(P.newState(data), data, NOW), /at least one day/);
  assert.throws(() => P.buildFile(P.addTravel(plan(), data), data, NOW), /Day 3/);
});

test('the import checks catch what the app would refuse', () => {
  const doc = P.buildFile(plan(), data, NOW);
  const bad = JSON.parse(JSON.stringify(doc));
  bad.plans[0].days[0].start_id = -1;
  assert.ok(P.checkFile(bad).length);
  assert.ok(P.checkFile({ format: 'other' }).length);
});

test('saved plans are cleaned: unknown stages dropped, values kept in range', () => {
  const raw = { name: 'x'.repeat(200), startDate: '2027-02-31', pace: 99, days: [{ t: 's', stage: 1 }, { t: 's', stage: 77 }, { t: 'nope' }, null] };
  const s = P.clean(raw, data);
  assert.strictEqual(s.days.length, 1); assert.strictEqual(s.name.length, 80);
  assert.strictEqual(s.startDate, ''); assert.strictEqual(s.pace, 4.2);
});

test('dates run on from the first day and totals add up', () => {
  const s = P.setMeta(plan(), { startDate: '2027-02-27' }, data);
  assert.deepStrictEqual(P.layout(s, data).days.map(d => d.date), ['2027-02-27', '2027-02-28']);
  const t = P.totals(s, data);
  assert.strictEqual(t.metres, 35000); assert.strictEqual(t.walking, 2);
  assert.strictEqual(P.addDays('2027-02-28', 1), '2027-03-01');
});

test('moving and removing days', () => {
  const s = P.moveDay(plan(), 0, 1);
  assert.deepStrictEqual(s.days.map(d => d.stage), [3, 1]);
  assert.strictEqual(P.moveDay(s, 0, -1), s);
  assert.deepStrictEqual(P.removeDay(s, 0).days.map(d => d.stage), [1]);
});
