// camino/jstests/plan-core.test.js
// Tests for the planner's logic (camino/static/camino/js/plan-core.js). No browser or Django needed.
// Run from the project folder with:  node --test      (Node 18 or newer; it finds every *.test.js)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../static/camino/js/plan-core.js');

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

test('a chain of paths adds every point except the first of the day and of a path that starts another stage', () => {
  assert.deepStrictEqual(P.chainTotals([11], data), { metres: 9000, weighted: 11000, from: 1, to: 4 });
  assert.strictEqual(P.chainTotals([11, 12], data).metres, 20000);          // same stage: the join counts
  assert.strictEqual(P.chainTotals([12], data).metres, 10960);               // alone, its first point adds nothing
  assert.strictEqual(P.chainTotals([12, 14], data).metres, 10960 + 15000);   // another stage: 14's first point adds nothing
  assert.strictEqual(P.chainTotals([11, 14], data), null);                   // the paths do not join
  assert.strictEqual(P.chainTotals([11, 11], data), null);
  assert.strictEqual(P.chainTotals([99], data), null);
});

test('every guidebook stage adds up to the figures stored for it', () => {
  for (const id of Object.keys(data.stages)) {
    const t = P.chainTotals(data.stages[id].paths, data);
    assert.ok(Math.abs(t.metres - data.stages[id].m) < 0.001, id);
    assert.ok(Math.abs(t.weighted - data.stages[id].w) < 0.001, id);
  }
});

test('routes between two places follow whole stages; a stage that is exactly the chain is a stage day', () => {
  assert.deepStrictEqual(P.routesBetween(1, 2, data).routes, [[11, 12], [13]]);
  assert.deepStrictEqual(P.routesBetween(4, 3, data).routes, [[12, 14]]);
  assert.deepStrictEqual(P.routesBetween(1, 3, data).routes, [[11, 12, 14], [13, 14]]);
  assert.deepStrictEqual(P.routesBetween(3, 1, data).routes, []);
  assert.deepStrictEqual(P.routesBetween(2, 2, data).routes, []);
  assert.strictEqual(P.stageForChain([11, 12], data), 1);
  assert.strictEqual(P.stageForChain([11], data), null);
  assert.strictEqual(P.addRoute(P.newState(data), [11, 12], data).days[0].t, 's');
  assert.strictEqual(P.addRoute(P.newState(data), [11], data).days[0].t, 'c');
});

test('alternative routes are named by what tells them apart', () => {
  const found = P.routesBetween(1, 2, data).routes;                       // the road, and the hills
  assert.deepStrictEqual(P.routeLabels(found, data), ['Main route', 'Via the hills']);
  assert.deepStrictEqual(P.routeLabels([found[0]], data), ['Alpha to Bravo']);  // one route keeps its full name
  const to3 = P.routesBetween(1, 3, data).routes;                         // both go on to Charlie
  assert.deepStrictEqual(P.routeLabels(to3, data).length, 2);
  assert.notStrictEqual(P.routeLabels(to3, data)[0], P.routeLabels(to3, data)[1]);
});

test('stops are towns only, nearest first, each with its routes and shortest distance', () => {
  const stops = P.stopsFrom(1, data, 60000);
  assert.deepStrictEqual(stops.map(s => s.name), ['Midway', 'Bravo', 'Charlie']);
  assert.deepStrictEqual(stops.map(s => s.metres), [9000, 20000, 35000]);
  assert.strictEqual(stops[1].routes.length, 2);                              // by the road or by the hills
  assert.deepStrictEqual(P.stopsFrom(1, data, 15000).map(s => s.name), ['Midway']);
  assert.deepStrictEqual(P.stopsFrom(3, data, 60000), []);                    // nothing beyond the end
  assert.ok(!P.stopsFrom(1, data, 60000).some(s => s.name === 'A fountain')); // not a place to stay
});

test('where a day starts: where the last ended if that is on the route, otherwise the visitor picks', () => {
  assert.deepStrictEqual(P.startFor(P.newState(data), data, null, null).fixed, false);
  assert.strictEqual(P.startFor(P.newState(data), data, null, null).name, 'St Jean Pied de Port');
  const afterOne = P.addRoute(P.newState(data), [11], data);
  const s = P.startFor(afterOne, data, null, null);
  assert.deepStrictEqual([s.fixed, s.name], [true, 'Midway']);
  const away = P.setTravel(P.addTravel(P.newState(data), data), 0, { from: 'Home', to: 'Biarritz' });
  assert.deepStrictEqual([P.startFor(away, data, null, 4).fixed, P.startFor(away, data, null, 4).name], [false, 'Midway']);
  assert.strictEqual(P.startFor(plan(), data, 1, null).name, 'Bravo');        // inserting after day 1
});

test('a day that starts somewhere else than the last ended gets a warning, not a failure', () => {
  const s = P.addStage(P.addStage(P.newState(data), 3), 1);
  assert.match(P.layout(s, data).days[1].warning, /starts at St Jean Pied de Port, but the day before ended at Charlie/);
});

test('the visitor\'s own stage: distance, time, warning and the way the file records it', () => {
  let s = P.setMeta(P.addRoute(P.newState(data), [11], data), { pace: 3.5, startDate: '2027-04-10' }, data);
  s = P.addRoute(s, [12], data);
  const l = P.layout(s, data);
  assert.deepStrictEqual([l.days[0].start.name, l.days[0].end.name, l.days[0].metres], ['St Jean Pied de Port', 'Midway', 9000]);
  assert.strictEqual(l.days[0].seconds, P.walkingSeconds(11000, 3.5, FLAT));
  assert.strictEqual(l.days[1].warning, '');
  assert.strictEqual(P.totals(s, data).walking, 2);
  const doc = P.buildFile(s, data, NOW);
  assert.deepStrictEqual(P.checkFile(doc), []);
  const day = doc.plans[0].days[0];
  assert.deepStrictEqual([day.start_id, day.end_id, day.metres], [1, 4, 9000]);
  assert.deepStrictEqual(JSON.parse(day.route).paths, [11]);
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

test('saved plans are cleaned: unknown stages and broken routes dropped, values kept in range', () => {
  const raw = { name: 'x'.repeat(200), startDate: '2027-02-31', pace: 99, days: [
    { t: 's', stage: 1 }, { t: 's', stage: 77 }, { t: 'nope' }, null,
    { t: 'c', paths: [11] }, { t: 'c', paths: [11, 14] }, { t: 'c', paths: 'x' }] };
  const s = P.clean(raw, data);
  assert.deepStrictEqual(s.days.map(d => d.t), ['s', 'c']);
  assert.strictEqual(s.name.length, 80);
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

test('a day can be inserted anywhere', () => {
  const base = plan();                                  // Alpha to Bravo, Bravo to Charlie
  const back = P.addStage(P.removeDay(base, 0), 1, 0);  // the first day taken out and put back at the start
  assert.deepStrictEqual(back.days.map(d => d.stage), [1, 3]);
  assert.strictEqual(P.layout(back, data).days[1].warning, '');
  const middle = P.addRest(base, 1);                    // a rest day between the two stages
  assert.deepStrictEqual(middle.days.map(d => d.t), ['s', 'r', 's']);
  assert.strictEqual(P.layout(middle, data).days[1].end.name, 'Bravo');
  const travel = P.addTravel(base, data, 1);
  assert.strictEqual(travel.days[1].from, 'Bravo');
  assert.strictEqual(P.addStage(base, 2).days.length, 3);              // no position still means the end
  assert.ok(P.layout(P.addStage(base, 2, 1), data).days[1].warning);  // a stage that does not connect is flagged
});

test('the end of the guide and how far it is from anywhere', () => {
  assert.strictEqual(P.guideEnd(data), 3);
  assert.strictEqual(P.metresToEnd(1, data), 9050 + 11000 + 15060);   // by the road, the shorter way
  assert.strictEqual(P.metresToEnd(4, data), 11000 + 15060);
  assert.strictEqual(P.metresToEnd(3, data), 0);
  assert.strictEqual(P.metresToEnd(5, data), null);                    // a place the paths never reach
  assert.strictEqual(P.metresToEnd(99, data), null);
});

test('a day can be changed to end somewhere else; the stay goes unless the place is the same', () => {
  let s = P.addRoute(P.newState(data), [11, 12], data);                // Alpha to Bravo
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.addRoute(s, [14], data);
  const shorter = P.setDayRoute(s, 0, [11], data);                      // stop at Midway instead
  assert.deepStrictEqual(shorter.days[0], { t: 'c', paths: [11], stay: null });
  assert.match(P.layout(shorter, data).days[1].warning, /starts at Bravo, but the day before ended at Midway/);
  const hills = P.setDayRoute(s, 0, [13], data);                        // another way to Bravo
  assert.deepStrictEqual(hills.days[0], { t: 's', stage: 2, stay: { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' } });
  assert.strictEqual(P.setDayRoute(s, 1, [11], data).days[1].paths.length, 1);
  assert.strictEqual(P.setDayRoute(s, 0, [11, 14], data), s);           // paths that do not join: nothing changes
  assert.strictEqual(P.setDayRoute(P.addRest(s), 2, [11], data).days.length, 3);
  assert.deepStrictEqual(s.days[0].paths, undefined);                   // the old plan is left alone
});

test('a day that no longer follows on can start from where the day before ended', () => {
  let s = P.addRoute(P.newState(data), [11, 12], data);
  s = P.addRoute(s, [14], data);
  s = P.setStay(s, 1, { k: 'c', id: 0, name: 'Friend', status: 'Considering' }, data);
  assert.strictEqual(P.refitStart(s, 1, data), null);                   // nothing to fix yet
  const moved = P.setDayRoute(s, 0, [11], data);                        // day 1 now ends at Midway
  const fix = P.refitStart(moved, 1, data);
  assert.deepStrictEqual(fix.chain, [12, 14]);
  assert.strictEqual(fix.from.name, 'Midway');
  assert.deepStrictEqual(fix.state.days[1], { t: 'c', paths: [12, 14], stay: { k: 'c', id: 0, name: 'Friend', status: 'Considering' } });
  assert.strictEqual(P.layout(fix.state, data).days[1].warning, '');
  assert.strictEqual(P.layout(fix.state, data).days[1].metres, 10960 + 15000);
  // no way to walk from where the day before ended
  let back = P.addRoute(P.addRoute(P.newState(data), [14], data), [11, 12], data);  // Bravo to Charlie, then Alpha to Bravo
  assert.ok(P.layout(back, data).days[1].warning);
  assert.strictEqual(P.refitStart(back, 1, data), null);
  assert.strictEqual(P.refitStart(back, 0, data), null);                // the first day has nothing before it
  assert.strictEqual(P.refitStart(P.addRest(moved), 2, data), null);    // rest days follow on by themselves
});

test('the summary says where the plan goes and how far is left', () => {
  assert.deepStrictEqual(P.progress(P.newState(data), data).start, null);
  let s = P.addRoute(P.newState(data), [11], data);
  let p = P.progress(s, data);
  assert.deepStrictEqual([p.start.name, p.end.name, p.metres, p.reachesEnd, p.remaining], ['St Jean Pied de Port', 'Midway', 9000, false, 26060]);
  s = P.addRoute(s, [12, 14], data);
  p = P.progress(s, data);
  assert.deepStrictEqual([p.end.name, p.reachesEnd, p.remaining, p.warnings], ['Charlie', true, 0, []]);
  s = P.addRoute(P.addRoute(P.newState(data), [14], data), [11], data);   // the second day starts at the wrong place
  assert.deepStrictEqual(P.progress(s, data).warnings, [1]);
  let away = P.setTravel(P.addTravel(P.addRoute(P.newState(data), [11], data), data), 1, { to: 'Madrid' });
  assert.strictEqual(P.progress(away, data).remaining, null);           // ended somewhere off the route
});

test('asking for the same routes again does not search again', () => {
  const a = P.routesBetween(1, 3, data), b = P.routesBetween(1, 3, data);
  assert.strictEqual(a, b);
});

test('a journey on the same day as the day before shares its date and adds no day', () => {
  let s = P.setMeta(P.addRoute(P.newState(data), [11, 12], data), { startDate: '2027-04-10' }, data);   // Alpha to Bravo
  s = P.setTravel(P.addTravel(s, data, undefined, true), 1, { to: 'Charlie' });                          // the bus on to Charlie, same day
  s = P.addRest(s);                                                                                       // rest in Charlie, next day
  const l = P.layout(s, data);
  assert.deepStrictEqual(l.days.map(d => d.date), ['2027-04-10', '2027-04-10', '2027-04-11']);
  assert.deepStrictEqual(l.days.map(d => d.same), [false, true, false]);
  assert.strictEqual(l.days[2].end.name, 'Charlie');
  const total = P.totals(s, data);
  assert.deepStrictEqual([total.days, total.entries, total.walking, total.travel, total.rest], [2, 3, 1, 1, 1]);
  // dates in the file
  const doc = P.buildFile(s, data, NOW);
  assert.deepStrictEqual(P.checkFile(doc), []);
  assert.deepStrictEqual(doc.plans[0].days.map(d => JSON.parse(d.route).date), ['2027-04-10', '2027-04-10', '2027-04-11']);
  assert.deepStrictEqual(doc.plans[0].days.map(d => d.ordinal), [0, 1, 2]);
  // switching it off gives the journey a day of its own
  const own = P.setTravel(s, 1, { same: false });
  assert.deepStrictEqual(P.layout(own, data).days.map(d => d.date), ['2027-04-10', '2027-04-11', '2027-04-12']);
});

test('the first day cannot be a same-day journey, and saved plans are kept in line', () => {
  assert.strictEqual(P.addTravel(P.newState(data), data, undefined, true).days[0].same, false);
  const first = P.setTravel(P.addTravel(P.newState(data), data), 0, { same: true });
  assert.strictEqual(first.days[0].same, false);
  const s = P.clean({ days: [{ t: 't', from: 'A', to: 'B', same: true }, { t: 't', from: 'B', to: 'C', same: true }, { t: 't', from: 'C', to: 'D' }] }, data);
  assert.deepStrictEqual(s.days.map(d => d.same), [false, true, false]);
  const l = P.layout(P.setMeta(s, { startDate: '2027-01-01' }, data), data);
  assert.deepStrictEqual(l.days.map(d => d.date), ['2027-01-01', '2027-01-01', '2027-01-02']);
});

test('a night counts once however many rows the day has', () => {
  let s = P.addRoute(P.newState(data), [11, 12], data);
  s = P.setTravel(P.addTravel(s, data, undefined, true), 1, { to: 'Charlie' });
  assert.strictEqual(P.totals(s, data).stays, 0);
  s = P.setStay(s, 1, { k: 'a', id: 300, name: 'Albergue Charlie', status: 'Booked' }, data);
  assert.strictEqual(P.totals(s, data).stays, 1);
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  assert.strictEqual(P.totals(s, data).stays, 1);                         // still one night
  assert.strictEqual(P.totals(P.addRest(s), data).stays, 1);              // the rest day has none yet
});

test('a rest day can be moved to another place; the journey is added in front of it', () => {
  let s = P.setMeta(P.addRoute(P.newState(data), [11, 12], data), { startDate: '2027-04-10' }, data);   // Alpha to Bravo
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.addRest(s);
  s = P.setStay(s, 1, { k: 'a', id: 200, name: 'Hotel Bravo', status: 'Considering' }, data);
  const moved = P.moveRest(s, 1, ' charlie ', data);                         // forgiving spelling
  assert.deepStrictEqual(moved.days.map(d => d.t), ['s', 't', 'r']);
  assert.deepStrictEqual([moved.days[1].from, moved.days[1].to, moved.days[1].same], ['Bravo', 'Charlie', false]);
  assert.strictEqual(moved.days[2].stay, null);                              // the old stay was for Bravo
  assert.strictEqual(moved.days[0].stay.name, 'Albergue Bravo');
  const l = P.layout(moved, data);
  assert.strictEqual(l.days[2].end.name, 'Charlie');
  assert.deepStrictEqual(l.days.map(d => d.date), ['2027-04-10', '2027-04-11', '2027-04-12']);
  assert.strictEqual(l.days.filter(d => d.warning).length, 0);
  assert.strictEqual(s.days.length, 2);                                       // the old plan is untouched
  // a place that is not in the guide
  const off = P.moveRest(s, 1, 'Madrid', data);
  assert.strictEqual(off.days[1].to, 'Madrid');
  assert.ok(P.layout(off, data).days[2].end.id < 0);
  assert.deepStrictEqual(P.checkFile(P.buildFile(off, data, NOW)), []);
  // nothing to do: the place it already is, empty text, a walking day
  assert.strictEqual(P.moveRest(s, 1, 'Bravo', data), s);
  assert.strictEqual(P.moveRest(s, 1, '  ', data), s);
  assert.strictEqual(P.moveRest(s, 0, 'Charlie', data), s);
  assert.strictEqual(P.moveRest(s, 5, 'Charlie', data), s);
});
