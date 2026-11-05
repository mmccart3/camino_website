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
  assert.deepStrictEqual(P.chainTotals([11], data), { metres: 9000, weighted: 11000, up: null, down: null, from: 1, to: 4 });
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

// The same guide with heights: each path row also has climb, descent, first height and last height (metres).
function withHeights(rows) {
  return Object.assign({}, data, { routes: Object.assign({}, data.routes, {
    paths: data.routes.paths.map((r, i) => r.concat(rows[i])) }) });
}
const dataH = withHeights([[100, 20, 100, 180], [30, 150, 185, 65], [400, 380, 100, 120], [10, 40, 60, 30]]);

test('climb and descent add each path\'s own and the step from one path to the next', () => {
  assert.deepStrictEqual(P.chainTotals([11], dataH).up, 100);
  assert.deepStrictEqual(P.chainTotals([11], dataH).down, 20);
  const joined = P.chainTotals([11, 12], dataH);                 // 180 -> 185 is a 5 m step up
  assert.strictEqual(joined.up, 100 + 30 + 5);
  assert.strictEqual(joined.down, 20 + 150);
  const later = P.chainTotals([12, 14], dataH);                  // 65 -> 60 is a 5 m step down
  assert.strictEqual(later.up, 30 + 10);
  assert.strictEqual(later.down, 150 + 40 + 5);
  const hills = P.chainTotals([13, 14], dataH);                  // 120 -> 60 is a 60 m step down
  assert.strictEqual(hills.up, 400 + 10);
  assert.strictEqual(hills.down, 380 + 40 + 60);
  assert.strictEqual(P.chainTotals([11, 12], dataH).metres, P.chainTotals([11, 12], data).metres); // distance is untouched
});

test('no climb is given for a chain when any of its paths has no heights', () => {
  const partly = withHeights([[100, 20, 100, 180], [], [400, 380, 100, 120], [10, 40, 60, 30]]);
  assert.strictEqual(P.chainTotals([11], partly).up, 100);
  assert.strictEqual(P.chainTotals([11, 12], partly).up, null);
  assert.strictEqual(P.chainTotals([11, 12], partly).down, null);
  assert.strictEqual(P.chainTotals([11, 12], partly).metres, 20000);
});

test('a day shows its climb and descent in whole metres, and is called long above 30 km', () => {
  const longer = Object.assign({}, dataH, {
    stages: Object.assign({}, dataH.stages, { '3': Object.assign({}, dataH.stages['3'], { m: 30500, w: 32000 }) })
  });
  const s = P.addStage(P.addStage(P.newState(longer), 1), 3);
  const days = P.layout(s, longer).days;
  assert.deepStrictEqual([days[0].up, days[0].down, days[0].long], [135, 170, false]);
  assert.deepStrictEqual([days[1].up, days[1].down, days[1].long], [10, 40, true]);
  const t = P.totals(s, longer);
  assert.strictEqual(t.climb, true);
  assert.strictEqual(t.long, 1);
  assert.strictEqual(t.up, 145);
  assert.strictEqual(t.down, 210);
  assert.strictEqual(P.totals(P.addStage(P.newState(dataH), 1), dataH).long, 0);
  const exactly = Object.assign({}, dataH, { stages: Object.assign({}, dataH.stages, { '3': Object.assign({}, dataH.stages['3'], { m: 30000 }) }) });
  assert.strictEqual(P.layout(P.addStage(P.newState(exactly), 3), exactly).days[0].long, false);   // 30 km exactly is not long
});

test('a day of your own route has a climb too, and days without heights say so', () => {
  const own = P.layout(P.addRoute(P.newState(dataH), [11], dataH), dataH).days[0];
  assert.deepStrictEqual([own.up, own.down], [100, 20]);
  const bare = P.layout(P.addRoute(P.newState(data), [11], data), data).days[0];
  assert.deepStrictEqual([bare.up, bare.down, bare.long], [null, null, false]);
  assert.strictEqual(P.totals(P.addRoute(P.newState(data), [11], data), data).climb, false);
  const rest = P.layout(P.addRest(plan()), dataH).days;          // a rest day has no climb of its own
  assert.deepStrictEqual([rest[2].up, rest[2].down, rest[2].long], [null, null, false]);
});

test('the places you can reach carry the climb of the shortest way there', () => {
  const stops = P.stopsFrom(1, dataH, 60000);
  const bravo = stops.find(x => x.name === 'Bravo');
  assert.deepStrictEqual([bravo.up, bravo.down], [135, 170]);    // by the main road, 20 km, not the hills
  const midway = stops.find(x => x.name === 'Midway');
  assert.deepStrictEqual([midway.up, midway.down], [100, 20]);
  assert.strictEqual(P.stopsFrom(1, data, 60000).find(x => x.name === 'Bravo').up, null);
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
  assert.match(P.layout(s, data).days[0].invalid, /where this rest day is/);
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

test('a day split in parts is one numbered day: "Day 1 \u2013 part 1", "Day 1 \u2013 part 2"', () => {
  let s = P.addRoute(P.newState(data), [11, 12], data);                 // Alpha to Bravo
  let l = P.layout(s, data).days;
  assert.deepStrictEqual(l.map(d => P.dayLabel(d)), ['Day 1']);          // no parts, no suffix
  s = P.setTravel(P.addTravel(s, data, undefined, true), 1, { to: 'Charlie' });
  s = P.setTravel(P.addTravel(s, data, undefined, true), 2, { from: 'Charlie', to: 'Delta' });   // a third part
  s = P.addRest(s);
  s = P.setTravel(P.addTravel(s, data), 4, { from: 'Delta', to: 'Echo' });
  l = P.layout(s, data).days;                                            // no start date: numbers do not depend on dates
  assert.deepStrictEqual(l.map(d => [d.no, d.part, d.parts]), [[1, 1, 3], [1, 2, 3], [1, 3, 3], [2, 1, 1], [3, 1, 1]]);
  assert.deepStrictEqual(l.map(d => P.dayLabel(d)), ['Day 1 \u2013 part 1', 'Day 1 \u2013 part 2', 'Day 1 \u2013 part 3', 'Day 2', 'Day 3']);
  assert.deepStrictEqual(l.map(d => P.dayRef(d)), ['day 1, part 1', 'day 1, part 2', 'day 1, part 3', 'day 2', 'day 3']);
  assert.strictEqual(P.totals(s, data).days, 3);
  // taking the tick off the middle part: the third part now follows it, and so does its number
  const apart = P.setTravel(s, 1, { same: false });
  assert.deepStrictEqual(P.layout(apart, data).days.map(d => P.dayLabel(d)), ['Day 1', 'Day 2 \u2013 part 1', 'Day 2 \u2013 part 2', 'Day 3', 'Day 4']);
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

// ---------------------------------------------------------------- a rest day first, references, travel details

test('a rest day can be the first day: it names its own place', () => {
  let s = P.addRest(P.newState(data));
  assert.match(P.layout(s, data).days[0].invalid, /where this rest day is/);
  s = P.setRestPlace(s, 0, 'saint-jean pied de port');            // forgiving match to a guide place
  let info = P.layout(s, data).days[0];
  assert.strictEqual(info.invalid, '');
  assert.deepStrictEqual([info.start.id, info.end.id, info.metres, info.seconds], [1, 1, 0, 0]);
  s = P.addStage(s, 1);                                             // the walk then starts where the rest was
  assert.strictEqual(P.layout(s, data).days[1].warning, '');
  const doc = P.buildFile(s, data, NOW);
  assert.deepStrictEqual(P.checkFile(doc), []);
  const d0 = doc.plans[0].days[0];
  assert.deepStrictEqual([d0.start_id, d0.end_id, d0.metres, JSON.parse(d0.route).isRestDay, JSON.parse(d0.route).paths], [1, 1, 0, true, []]);
  // a place that is not in the guide is taken at its word, with a negative number
  s = P.setRestPlace(P.addRest(P.newState(data)), 0, 'Biarritz');
  info = P.layout(s, data).days[0];
  assert.ok(info.start.id < 0 && info.start.id === info.end.id);
  assert.strictEqual(P.buildFile(s, data, NOW).plans[0].days[0].start_name, 'Biarritz');
});

test('a rest day only names its own place while it is the first day', () => {
  let s = P.setRestPlace(P.addRest(P.newState(data)), 0, 'Bravo');
  s = P.addStage(s, 1, 0);                                          // a stage is put in front of it
  assert.strictEqual(s.days[1].at, undefined);
  assert.strictEqual(P.layout(s, data).days[1].end.name, 'Bravo');   // rests where the stage finished
  s = P.setRestPlace(s, 1, 'Charlie');                              // not the first day: nothing happens
  assert.strictEqual(s.days[1].at, undefined);
  // moving a day: the rest day that ends up first has no place yet
  const moved = P.moveDay(s, 1, -1);
  assert.strictEqual(moved.days[0].t, 'r');
  assert.match(P.layout(moved, data).days[0].invalid, /where this rest day is/);
  // saved plans: the place is kept on the first day only
  const raw = { days: [{ t: 'r', at: 'Bravo' }, { t: 'r', at: 'Charlie' }] };
  const cleaned = P.clean(raw, data);
  assert.deepStrictEqual(cleaned.days.map((d) => d.at), ['Bravo', undefined]);
});

test('a stay keeps a booking reference, notes and a contact; empty ones are left out', () => {
  let s = P.setStay(plan(), 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked', ref: '  AB-1234  ' }, data);
  assert.strictEqual(s.days[0].stay.ref, 'AB-1234');
  assert.ok(!('notes' in s.days[0].stay) && !('contact' in s.days[0].stay));
  s = P.setStayDetails(s, 0, { notes: 'Arrive after 4pm', contact: '+34 600 000 000' });
  assert.deepStrictEqual([s.days[0].stay.notes, s.days[0].stay.contact], ['Arrive after 4pm', '+34 600 000 000']);
  s = P.setStayStatus(s, 0, 'Confirmed');                           // changing the status keeps the details
  assert.strictEqual(s.days[0].stay.ref, 'AB-1234');
  const stay = JSON.parse(P.buildFile(s, data, NOW).plans[0].days[0].stay);
  assert.deepStrictEqual([stay.reference, stay.notes, stay.contact, stay.status], ['AB-1234', 'Arrive after 4pm', '+34 600 000 000', 'Confirmed']);
  s = P.setStayDetails(s, 0, { ref: '', notes: '' });
  assert.ok(!('ref' in s.days[0].stay) && !('notes' in s.days[0].stay) && s.days[0].stay.contact);
  s = P.setStay(s, 0, { k: 'p', id: 200, name: 'Hotel Bravo', status: 'Considering' }, data);   // another stay: no old details
  assert.deepStrictEqual(Object.keys(s.days[0].stay).sort(), ['id', 'k', 'name', 'status']);
  assert.strictEqual(P.setStayDetails(plan(), 0, { ref: 'x' }).days[0].stay, null);                // no stay, nothing to change
  assert.strictEqual(P.setStayDetails(s, 0, { ref: 'x'.repeat(100) }).days[0].stay.ref.length, P.MAX_REF);
});

test('a travel day keeps how it is made, its times, reference and notes', () => {
  let s = P.setTravel(P.addTravel(plan(), data), 2, { to: 'Madrid', mode: 'train', dep: 9 * 60 + 5, arr: 13 * 60, ref: ' TK-77 ', notes: 'Platform 3' });
  assert.deepStrictEqual([s.days[2].mode, s.days[2].dep, s.days[2].arr, s.days[2].ref, s.days[2].notes], ['train', 545, 780, 'TK-77', 'Platform 3']);
  const doc = P.buildFile(s, data, NOW);
  assert.deepStrictEqual(P.checkFile(doc), []);
  const route = JSON.parse(doc.plans[0].days[2].route);
  assert.strictEqual(route.departureMinutes, 545);
  assert.deepStrictEqual(route.travel, { mode: 'train', arrivalMinutes: 780, reference: 'TK-77', notes: 'Platform 3' });
  assert.strictEqual(JSON.parse(doc.plans[0].days[0].route).travel, undefined);   // walking days have none
  // an empty or bad value takes a field away; a plain travel day writes no travel object
  s = P.setTravel(s, 2, { mode: '', dep: null, arr: 5000, ref: '', notes: '' });
  assert.deepStrictEqual(Object.keys(s.days[2]).sort(), ['from', 'same', 'stay', 't', 'to']);
  const plain = JSON.parse(P.buildFile(s, data, NOW).plans[0].days[2].route);
  assert.deepStrictEqual([plain.departureMinutes, plain.travel], [480, undefined]);
  // saved plans are cleaned the same way
  const cleaned = P.clean({ days: [{ t: 't', from: 'A', to: 'B', mode: 'rocket', dep: 'soon', arr: 61, ref: 7, notes: 'n'.repeat(500) }] }, data);
  assert.deepStrictEqual([cleaned.days[0].mode, cleaned.days[0].dep, cleaned.days[0].arr, cleaned.days[0].ref, cleaned.days[0].notes.length], [undefined, undefined, 61, '7', P.MAX_TRAVEL_NOTES]);
});

test('the file check refuses travel details the app could not make sense of', () => {
  const s = P.setTravel(P.addTravel(plan(), data), 2, { to: 'Madrid', mode: 'bus' });
  const doc = P.buildFile(s, data, NOW);
  const bad = (change) => {
    const copy = JSON.parse(JSON.stringify(doc));
    const route = JSON.parse(copy.plans[0].days[2].route);
    change(route);
    copy.plans[0].days[2].route = JSON.stringify(route);
    return P.checkFile(copy);
  };
  assert.deepStrictEqual(bad((r) => { r.travel.mode = 'bus'; }), []);
  assert.ok(bad((r) => { r.travel.mode = 'rocket'; }).length);
  assert.ok(bad((r) => { r.travel.arrivalMinutes = 1440; }).length);
  assert.ok(bad((r) => { r.travel.notes = 5; }).length);
  assert.ok(bad((r) => { r.travel = 'bus'; }).length);
});

test('clock times: minutes after midnight and back', () => {
  assert.strictEqual(P.formatClock(0), '00:00');
  assert.strictEqual(P.formatClock(545), '09:05');
  assert.strictEqual(P.formatClock(1439), '23:59');
  assert.strictEqual(P.formatClock(1440), ''); assert.strictEqual(P.formatClock(-1), ''); assert.strictEqual(P.formatClock(null), '');
  assert.deepStrictEqual(['9:05', '09:05', '0905', ' 23:59 '].map(P.parseClock), [545, 545, 545, 1439]);
  assert.deepStrictEqual(['', '24:00', '9:60', '9', 'ab:cd', null].map(P.parseClock), [null, null, null, null, null, null]);
});

// ---------------------------------------------------------------- what the guide says about a place to stay

test('the picker line: price, beds and facilities for an albergue', () => {
  assert.strictEqual(P.stayLine('a', { p: 16, n: 32, f: 'kmwdr' }), 'from €16 · 32 beds · Kitchen · Meal · Washer · Dryer · Private rooms');
  assert.strictEqual(P.stayLine('a', { p: 10, px: 15, n: 1 }), '€10 to €15 · 1 bed');
  assert.strictEqual(P.stayLine('a', { p: 10, px: 10 }), 'from €10');
  assert.strictEqual(P.stayLine('a', { f: 'zk' }), 'Kitchen');           // a letter the page does not know is ignored
  assert.strictEqual(P.stayLine('a', {}), '');
  assert.strictEqual(P.stayLine('a', null), '');
});

test('the picker line: single and double prices for a private place', () => {
  assert.strictEqual(P.stayLine('p', { p: 45, p2: 55.5 }), 'single from €45 · double from €55.50');
  assert.strictEqual(P.stayLine('p', { p2: 60 }), 'double from €60');
  assert.strictEqual(P.stayLine('p', { n: 4, f: 'k' }), '');               // beds and facilities are an albergue's
});

test('facilities in full, and in short', () => {
  assert.deepStrictEqual(P.facilityNames('kmr'), ['Kitchen', 'Communal meal', 'Private rooms']);
  assert.deepStrictEqual(P.facilityNames('wd', true), ['Washer', 'Dryer']);
  assert.deepStrictEqual(P.facilityNames(''), []);
  assert.deepStrictEqual(P.facilityNames(undefined), []);
});

test('telephone numbers are shown the way people write them', () => {
  assert.strictEqual(P.formatPhone('+34987123456'), '+34 987 123 456');
  assert.strictEqual(P.formatPhone('+33617103189'), '+33 6 17 10 31 89');
  assert.strictEqual(P.formatPhone('+351912345678'), '+351 912 345 678');
  assert.strictEqual(P.formatPhone('+4415550123'), '+4415550123');
  assert.strictEqual(P.formatPhone(''), '');
  assert.strictEqual(P.formatPhone(undefined), '');
});

// The links the town pages make with attach_booking_affiliate (camino/models.py), worked out by that function.
const AFFILIATE = {
  aid: '818289',
  label: 'affnetcj-15734710_pub-8073556_site-101884570_pname-MM3+Enterprise+Limited_clkid-_cjevent-5b29e765ba1911f180aa00a10a18b8f7',
  utm_source: 'affnetcj', utm_medium: 'bannerindex', utm_campaign: 'fr', utm_term: 'index-15734710'
};
const ENDING = '&label=affnetcj-15734710_pub-8073556_site-101884570_pname-MM3%2BEnterprise%2BLimited_clkid-_cjevent-5b29e765ba1911f180aa00a10a18b8f7&utm_source=affnetcj&utm_medium=bannerindex&utm_campaign=fr&utm_term=index-15734710';

test('Booking.com links get the same affiliate details as the town pages', () => {
  assert.strictEqual(P.bookingLink('https://www.booking.com/hotel/es/casa.html', AFFILIATE),
    'https://www.booking.com/hotel/es/casa.html?aid=818289' + ENDING);
  assert.strictEqual(P.bookingLink('https://www.booking.com/hotel/es/casa.html?lang=en-gb&aid=1', AFFILIATE),
    'https://www.booking.com/hotel/es/casa.html?lang=en-gb&aid=818289' + ENDING);
  assert.strictEqual(P.bookingLink('https://www.booking.com/hotel/es/c.html#reviews', AFFILIATE),
    'https://www.booking.com/hotel/es/c.html?aid=818289' + ENDING + '#reviews');
});

test('a link that is not a web address is refused, and no affiliate details means none are added', () => {
  assert.strictEqual(P.bookingLink('javascript:alert(1)', AFFILIATE), null);
  assert.strictEqual(P.bookingLink('not a link', AFFILIATE), null);
  assert.strictEqual(P.bookingLink('', AFFILIATE), null);
  assert.strictEqual(P.bookingLink('https://www.booking.com/h.html', undefined), 'https://www.booking.com/h.html');
});

test('the ways to reach a place, in the order the place page in the guide shows them', () => {
  const d = { t: '+34987123456', wa: '34987123456', em: 'casa@example.es', web: 'https://casa.example.es/', bk: 'https://www.booking.com/h.html' };
  const links = P.stayLinks(d, { aid: '1' });
  assert.deepStrictEqual(links.map((l) => l.key), ['booking', 'whatsapp', 'call', 'email', 'website']);
  assert.deepStrictEqual(links.map((l) => l.href), ['https://www.booking.com/h.html?aid=1', 'https://wa.me/34987123456', 'tel:+34987123456',
    'mailto:casa@example.es', 'https://casa.example.es/']);
  assert.strictEqual(links[2].text, '+34 987 123 456');
  assert.deepStrictEqual(P.stayLinks({ t: '+34987123456' }, {}).map((l) => l.key), ['call']);
  assert.deepStrictEqual(P.stayLinks({}, {}), []);
  assert.deepStrictEqual(P.stayLinks(null, {}), []);
  assert.deepStrictEqual(P.stayLinks({ bk: 'ftp://x' }, {}), []);
});

// ---------------------------------------------------------------- reading a plan file back in

// A plan with every kind of day and stay, to save and read back.
function everything(dated) {
  let s = P.setMeta(P.addStage(P.addStage(P.newState(data), 1), 3), { name: 'Spring walk', pace: 3.6, startDate: dated ? '2027-04-10' : '' }, data);
  s = P.setStay(s, 0, { k: 'a', id: 100, name: 'Albergue Bravo', status: 'Booked' }, data);
  s = P.setStayDetails(s, 0, { ref: 'AB-123', notes: 'Bunk 12, late arrival', contact: '+34 600 000 000' });
  s = P.addRest(s);
  s = P.setStay(s, 2, { k: 'c', id: 0, name: 'A friend\'s flat', status: 'Considering' }, data);
  s = P.addTravel(s, data);
  s = P.setTravel(s, 3, { to: 'Madrid', mode: 'train', dep: 9 * 60 + 30, arr: 14 * 60, ref: 'Seat 12A', notes: 'Platform 3' });
  s = P.addTravel(s, data, undefined, true);
  s = P.setTravel(s, 4, { from: 'Madrid', to: 'Barajas airport', mode: 'taxi' });
  s = P.addRoute(s, [14], data);
  return s;
}
const inFile = (state) => JSON.parse(JSON.stringify(P.buildFile(state, data, NOW)));

test('a plan saved to a file reads back as the same plan, with and without dates', () => {
  for (const dated of [true, false]) {
    const original = everything(dated);
    const read = P.readFile(inFile(original), data);
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.plans.length, 1);
    const back = read.plans[0].state;
    assert.deepStrictEqual(P.buildFile(back, data, NOW), P.buildFile(original, data, NOW), 'the same file again');
    assert.deepStrictEqual(back.days.map(d => d.t), original.days.map(d => d.t));
    assert.strictEqual(back.name, 'Spring walk');
    assert.strictEqual(back.pace, 3.6);
    assert.strictEqual(back.startDate, dated ? '2027-04-10' : '');
    assert.deepStrictEqual(back.days[0].stay, original.days[0].stay);          // reference, notes and contact come back
    assert.deepStrictEqual(read.plans[0].notes, []);
  }
});

test('a journey on the same day comes back as one only when the plan has dates', () => {
  assert.strictEqual(P.readFile(inFile(everything(true)), data).plans[0].state.days[4].same, true);
  assert.strictEqual(P.readFile(inFile(everything(false)), data).plans[0].state.days[4].same, false);
});

test('a stage day comes back as a stage, an own route as an own route, a first rest day keeps its place', () => {
  let s = P.addStage(P.addRest(P.newState(data)), 1);
  s = P.setRestPlace(s, 0, 'St Jean Pied de Port');
  s = P.addRoute(s, [14], data);
  const days = P.readFile(inFile(s), data).plans[0].state.days;
  assert.deepStrictEqual([days[0].t, days[0].at, days[1].t, days[1].stage, days[2].t, days[2].stage], ['r', 'St Jean Pied de Port', 's', 1, 's', 3]);
  const own = P.readFile(inFile(P.addRoute(P.newState(data), [11], data)), data).plans[0].state.days[0];
  assert.deepStrictEqual([own.t, own.paths], ['c', [11]]);
});

test('a file that is not an itinerary, or is for another edition of the guide, is refused plainly', () => {
  assert.match(P.readFile({}, data).message, /not a Camino/);
  assert.match(P.readFile(null, data).message, /not a Camino/);
  assert.match(P.readFile([1, 2], data).message, /not a Camino/);
  const other = inFile(plan()); other.source.guideFingerprint = 'ffffffffffffffff';
  assert.match(P.readFile(other, data).message, /different edition/);
  const broken = inFile(plan()); broken.plans[0].days[0].route = 'not json';
  assert.match(P.readFile(broken, data).message, /cannot be opened: day 1/);
  const empty = inFile(plan()); empty.plans[0].days = [];
  assert.match(P.readFile(empty, data).message, /no days/);
});

test('a backup from the app, with no source note and other plans, opens each plan with the extras ignored', () => {
  const doc = inFile(plan());
  delete doc.source;
  doc.entries = [{ junk: true }]; doc.locationFavourites = [{ junk: true }];
  doc.plans.push(inFile(everything(true)).plans[0]);
  doc.plans.push({ name: 'Nothing yet', days: [] });
  const read = P.readFile(doc, data);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(read.plans.map(p => [p.name, p.days]), [['My Camino', 2], ['Spring walk', 6]]);
});

test('days whose routes are not in this guide are left out and said so; unknown places to stay keep their names', () => {
  const doc = inFile(plan());
  const route = JSON.parse(doc.plans[0].days[1].route);
  route.paths = [999];
  doc.plans[0].days[1].route = JSON.stringify(route);
  doc.plans[0].days[0].stay = JSON.stringify({ id: 424242, kind: 'albergue', name: 'Albergue that went', status: 'Booked', reference: 'X1', notes: '', contact: '' });
  const read = P.readFile(doc, data);
  const one = read.plans[0];
  assert.strictEqual(one.days, 1);
  assert.deepStrictEqual(one.skipped, [2]);
  assert.match(one.notes[0], /Day 2 was left out/);
  assert.deepStrictEqual(one.state.days[0].stay, { k: 'c', id: 0, name: 'Albergue that went', status: 'Booked', ref: 'X1' });
  assert.strictEqual(P.readFile(Object.assign(doc, { plans: [doc.plans[0]] }), data).ok, true);
});

test('dates that do not follow on one day after another are straightened, and the pace is kept in range', () => {
  const doc = inFile(P.setMeta(plan(), { startDate: '2027-04-10' }, data));
  const route = JSON.parse(doc.plans[0].days[1].route);
  route.date = '2027-04-20';
  doc.plans[0].days[1].route = JSON.stringify(route);
  let one = P.readFile(doc, data).plans[0];
  assert.strictEqual(one.state.startDate, '2027-04-10');
  assert.ok(one.notes.some(n => /dates were changed/.test(n)));
  const fast = inFile(plan());
  fast.plans[0].days.forEach((d) => { const r = JSON.parse(d.route); r.pace = 8; d.route = JSON.stringify(r); });
  one = P.readFile(fast, data).plans[0];
  assert.strictEqual(one.state.pace, data.pace.default);
  assert.ok(one.notes.some(n => /pace/.test(n)));
});

// ---------------------------------------------------------------- "my plan is complete"

test('a plan can be marked complete only when it has days, and the mark can be taken off', () => {
  const empty = P.newState(data);
  assert.strictEqual('done' in P.setDone(empty, true), false);
  const s = P.addStage(P.newState(data), 1);
  const done = P.setDone(s, true);
  assert.strictEqual(done.done, true);
  assert.strictEqual('done' in s, false, 'the plan it was made from is not changed');
  assert.strictEqual('done' in P.setDone(done, false), false);
});

test('the complete mark survives being saved and read back, but only for a plan with days', () => {
  const done = P.setDone(P.addStage(P.newState(data), 1), true);
  const back = P.clean(JSON.parse(JSON.stringify(done)), data);
  assert.strictEqual(back.done, true);
  assert.strictEqual('done' in P.clean({ v: 1, name: 'x', days: [], done: true }, data), false);
  assert.strictEqual('done' in P.clean({ v: 1, name: 'x', days: [{ t: 'r' }], done: 'yes' }, data), false, 'only true counts');
  assert.strictEqual('done' in P.clean(JSON.parse(JSON.stringify(P.addStage(P.newState(data), 1))), data), false);
});

test('a day added at the end reopens a complete plan; a day put in the middle does not', () => {
  let s = P.addStage(P.addStage(P.newState(data), 1), 3);
  const done = P.setDone(s, true);
  for (const next of [P.addRest(done), P.addRest(done, 2), P.addStage(done, 3, null), P.addTravel(done, data, null, false), P.addTravel(done, data, 2, true)]) {
    assert.strictEqual('done' in next, false, 'added at the end');
  }
  for (const next of [P.addRest(done, 1), P.addRest(done, 0), P.addStage(done, 2, 1)]) {
    assert.strictEqual(next.done, true, 'added in the middle');
    assert.strictEqual(next.days.length, 3);
  }
});

test('changing a complete plan keeps it complete, and removing its last day clears the mark', () => {
  const done = P.setDone(P.addRest(P.addStage(P.newState(data), 1)), true);
  assert.strictEqual(P.moveDay(done, 0, 1).done, true);
  assert.strictEqual(P.removeDay(done, 1).done, true);
  assert.strictEqual(P.setMeta(done, { name: 'Renamed' }, data).done, true);
  const one = P.setDone(P.addStage(P.newState(data), 1), true);
  assert.strictEqual('done' in P.removeDay(one, 0), false);
  assert.strictEqual(P.removeDay(one, 0).days.length, 0);
});

test('the mark is not part of the plan: the file and the plan code are the same with it or without', () => {
  const S = require('../static/camino/js/plan-share.js');
  const s = P.addStage(P.addStage(P.newState(data), 1), 3);
  const done = P.setDone(s, true);
  assert.deepStrictEqual(P.buildFile(done, data, NOW), P.buildFile(s, data, NOW));
  assert.strictEqual(S.encode(done, data).text, S.encode(s, data).text);
  assert.deepStrictEqual(P.layout(done, data), P.layout(s, data));
});
