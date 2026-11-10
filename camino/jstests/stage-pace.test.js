// camino/jstests/stage-pace.test.js
// Tests for the walking-pace control on a stage page (camino/static/camino/js/stage-pace.js). No browser or Django needed.
// The wording of the times is the page's own (format_duration in camino/templatetags/camino_tags.py and
// make_location_entry in camino/views.py), so at the guide's pace this file must give back exactly what the server wrote.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../static/camino/js/stage-pace.js');

const EN = {
  hint: "Your pace on the flat. The guide's times are for {pace} km/h; slow down for hot weather, a heavy pack or sore feet.",
  at: 'at {pace} km/h', reset: 'Back to {pace} km/h',
  hrMin: '{hours} hr {minutes} min', hr: '{hours} hr', min: '{minutes} min', zeroMin: '0 min',
  totalHr: '{n} hr', totalHrs: '{n} hrs', totalMin: '{n} min', totalMins: '{n} mins', totalZero: '0 mins',
};
const ES = Object.assign({}, EN, {
  at: 'a {pace} km/h', reset: 'Volver a {pace} km/h',
  hrMin: '{hours} h {minutes} min', hr: '{hours} h', min: '{minutes} min',
  totalHr: '{n} h', totalHrs: '{n} h', totalMin: '{n} min', totalMins: '{n} min', totalZero: '0 min',
});
const LIMITS = { def: 4.2, min: 2, max: 6 };

test('a pace is one decimal inside the limits, or nothing', () => {
  assert.strictEqual(P.tidyPace('3.6', LIMITS), 3.6);
  assert.strictEqual(P.tidyPace(3.64, LIMITS), 3.6);
  assert.strictEqual(P.tidyPace('2', LIMITS), 2);
  assert.strictEqual(P.tidyPace('6', LIMITS), 6);
  for (const bad of [null, undefined, '', ' ', 'fast', NaN, 1.9, 6.1, '9', -3]) assert.strictEqual(P.tidyPace(bad, LIMITS), null, String(bad));
});

test('the guide pace gives back the seconds and minutes unchanged, so no minute boundary is lost', () => {
  for (const s of [0, 59, 60, 3599, 3600, 7200, 24352, 86400]) assert.strictEqual(P.scaleSeconds(s, 4.2, 4.2), s);
  for (const m of [0, 1, 60, 406]) assert.strictEqual(P.scaleMinutes(m, 4.2, 4.2), m);
});

test('time on foot is in proportion to the pace', () => {
  assert.strictEqual(P.scaleSeconds(3600, 2.1, 4.2), 7200);         // half the pace, twice the time
  assert.strictEqual(P.scaleSeconds(7200, 8.4, 4.2), 3600);
  assert.strictEqual(P.scaleSeconds(24352, 3.0, 4.2), 34092.8);
  assert.strictEqual(P.scaleMinutes(406, 3.0, 4.2), 568);           // 568.4
  assert.strictEqual(P.scaleMinutes(406, 6.0, 4.2), 284);           // 284.2
  assert.ok(P.scaleSeconds(1000, 5.0, 4.2) < 1000 && P.scaleSeconds(1000, 3.0, 4.2) > 1000);
});

test('a time at a place is written the way the server writes it', () => {
  assert.strictEqual(P.placeTime(24352, EN), '6 hr 45 min');
  assert.strictEqual(P.placeTime(3600, EN), '1 hr');
  assert.strictEqual(P.placeTime(7260, EN), '2 hr 1 min');
  assert.strictEqual(P.placeTime(2400, EN), '40 min');
  assert.strictEqual(P.placeTime(59, EN), '0 min');
  assert.strictEqual(P.placeTime(0, EN), '0 min');
  assert.strictEqual(P.placeTime(24352, ES), '6 h 45 min');
  assert.strictEqual(P.placeTime(3600, ES), '1 h');
  assert.strictEqual(P.placeTime(34092.8, EN), '9 hr 28 min');
});

test('the stage time is written the way format_duration writes it', () => {
  assert.strictEqual(P.totalTime(406, EN), '6 hrs 46 mins');
  assert.strictEqual(P.totalTime(60, EN), '1 hr');
  assert.strictEqual(P.totalTime(61, EN), '1 hr 1 min');
  assert.strictEqual(P.totalTime(45, EN), '45 mins');
  assert.strictEqual(P.totalTime(120, EN), '2 hrs');
  assert.strictEqual(P.totalTime(0, EN), '--');
  assert.strictEqual(P.totalTime('', EN), '--');
  assert.strictEqual(P.totalTime(null, EN), '--');
  assert.strictEqual(P.totalTime(406, ES), '6 h 46 min');
  assert.strictEqual(P.totalTime(P.scaleMinutes(406, 3.0, 4.2), EN), '9 hrs 28 mins');
});

test('the pace is written with a decimal comma in Spanish', () => {
  assert.strictEqual(P.paceNumber(4.2, 'en'), '4.2');
  assert.strictEqual(P.paceNumber(4.2, 'es'), '4,2');
  assert.strictEqual(P.paceNumber(3, 'en'), '3.0');
  assert.strictEqual(P.paceNumber(3.6000000000000005, 'es'), '3,6');
});

function memoryStorage(values, failing) {
  return {
    getItem(key) { if (failing) throw new Error('blocked'); return key in values ? values[key] : null; },
    setItem(key, value) { if (failing) throw new Error('blocked'); values[key] = String(value); },
  };
}

test('the saved pace is the one chosen on a stage page, else the planner\'s, else nothing', () => {
  const plan = JSON.stringify({ guide: 'x', state: { v: 1, pace: 3.4, days: [] }, at: '2026-11-10T10:00:00Z' });
  assert.strictEqual(P.readSaved(memoryStorage({}), LIMITS), null);
  assert.strictEqual(P.readSaved(memoryStorage({ [P.PLAN_KEY]: plan }), LIMITS), 3.4);
  assert.strictEqual(P.readSaved(memoryStorage({ [P.PLAN_KEY]: plan, [P.STORAGE_KEY]: '3.8' }), LIMITS), 3.8);
  assert.strictEqual(P.readSaved(memoryStorage({ [P.STORAGE_KEY]: '4.2', [P.PLAN_KEY]: plan }), LIMITS), 4.2);   // an explicit reset stays
  assert.strictEqual(P.readSaved(memoryStorage({ [P.STORAGE_KEY]: '12', [P.PLAN_KEY]: plan }), LIMITS), 3.4);   // out of range: ignored
  assert.strictEqual(P.readSaved(memoryStorage({ [P.PLAN_KEY]: '{not json' }), LIMITS), null);
  assert.strictEqual(P.readSaved(memoryStorage({ [P.PLAN_KEY]: JSON.stringify({ state: { pace: 99 } }) }), LIMITS), null);
  assert.strictEqual(P.readSaved(memoryStorage({}, true), LIMITS), null);   // storage blocked
});

test('saving survives blocked storage', () => {
  const kept = {};
  P.savePace(memoryStorage(kept), 3.6);
  assert.strictEqual(kept[P.STORAGE_KEY], '3.6');
  assert.doesNotThrow(() => P.savePace(memoryStorage({}, true), 3.6));
});

// A page in miniature: just what start() reads and writes.
function element(attributes, text) {
  const handlers = {};
  return {
    hidden: false, value: '', textContent: text || '', attributes: Object.assign({}, attributes), handlers,
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, fn) { handlers[type] = fn; },
    focus() { this.focused = true; },
  };
}

function miniPage(lang, stored) {
  const els = {
    'stage-pace-box': element({ 'data-default': '4.2', 'data-min': '2', 'data-max': '6' }),
    'stage-pace': element({}), 'stage-pace-out': element({}), 'stage-pace-hint': element({}),
    'stage-pace-reset': element({}), 'stage-time-note': element({}),
    'stage-time': element({ 'data-minutes': '406' }, '6 hrs 46 mins'),
  };
  els['stage-pace-box'].hidden = true;
  els['stage-pace-reset'].hidden = true;
  const places = [[0, '0 min'], [9000, '2 hr 30 min'], [24352, '6 hr 45 min']]
    .map(([s, t]) => element({ 'data-seconds': String(s) }, t));
  const kept = Object.assign({}, stored || {});
  const doc = {
    documentElement: { lang },
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => places,
  };
  const win = { STAGE_PACE_TXT: lang === 'es' ? ES : EN, localStorage: memoryStorage(kept) };
  return { els, places, kept, doc, win };
}

test('the control stays hidden when the page has no words for it', () => {
  const page = miniPage('en');
  delete page.win.STAGE_PACE_TXT;
  P.start(page.doc, page.win);
  assert.strictEqual(page.els['stage-pace-box'].hidden, true);
});

test('with nothing saved the page keeps the server\'s figures and shows the slider', () => {
  const page = miniPage('en');
  P.start(page.doc, page.win);
  assert.strictEqual(page.els['stage-pace-box'].hidden, false);
  assert.strictEqual(page.els['stage-pace'].value, '4.2');
  assert.strictEqual(page.els['stage-pace-out'].textContent, '4.2 km/h');
  assert.strictEqual(page.els['stage-time'].textContent, '6 hrs 46 mins');
  assert.deepStrictEqual(page.places.map((el) => el.textContent), ['0 min', '2 hr 30 min', '6 hr 45 min']);
  assert.strictEqual(page.els['stage-time-note'].textContent, '');
  assert.strictEqual(page.els['stage-pace-reset'].hidden, true);
  assert.deepStrictEqual(page.kept, {});   // looking at a page saves nothing
});

test('moving the slider rescales every time, says so, and remembers the pace', () => {
  const page = miniPage('en');
  P.start(page.doc, page.win);
  page.els['stage-pace'].value = '3.0';
  page.els['stage-pace'].handlers.input();
  assert.strictEqual(page.els['stage-time'].textContent, '9 hrs 28 mins');
  assert.deepStrictEqual(page.places.map((el) => el.textContent), ['0 min', '3 hr 30 min', '9 hr 28 min']);
  assert.strictEqual(page.els['stage-time-note'].textContent, ' (at 3.0 km/h)');
  assert.strictEqual(page.els['stage-pace-out'].textContent, '3.0 km/h');
  assert.strictEqual(page.els['stage-pace-reset'].hidden, false);
  assert.strictEqual(page.els['stage-pace-reset'].textContent, 'Back to 4.2 km/h');
  assert.strictEqual(page.kept[P.STORAGE_KEY], '3');
});

test('reset puts the server\'s own figures back, exactly', () => {
  const page = miniPage('en');
  P.start(page.doc, page.win);
  page.els['stage-pace'].value = '5.5';
  page.els['stage-pace'].handlers.input();
  assert.notStrictEqual(page.els['stage-time'].textContent, '6 hrs 46 mins');
  page.els['stage-pace-reset'].handlers.click();
  assert.strictEqual(page.els['stage-time'].textContent, '6 hrs 46 mins');
  assert.deepStrictEqual(page.places.map((el) => el.textContent), ['0 min', '2 hr 30 min', '6 hr 45 min']);
  assert.strictEqual(page.els['stage-time-note'].textContent, '');
  assert.strictEqual(page.els['stage-pace-reset'].hidden, true);
  assert.strictEqual(page.kept[P.STORAGE_KEY], '4.2');
});

test('a saved pace is applied when the page opens, in Spanish with a decimal comma', () => {
  const page = miniPage('es', { [P.STORAGE_KEY]: '3.6' });
  P.start(page.doc, page.win);
  assert.strictEqual(page.els['stage-pace-out'].textContent, '3,6 km/h');
  assert.strictEqual(page.els['stage-time'].textContent, '7 h 54 min');            // 406 * 4.2 / 3.6 = 473.67, rounded to 474 min
  assert.strictEqual(page.els['stage-time-note'].textContent, ' (a 3,6 km/h)');
  assert.strictEqual(page.els['stage-pace'].attributes['aria-valuetext'], '3,6 km/h');
  assert.strictEqual(page.els['stage-pace-hint'].textContent.includes('4,2 km/h'), true);
  assert.strictEqual(page.places[2].textContent, '7 h 53 min');                      // 24352 s * 4.2 / 3.6 = 28410 s = 7 h 53 min 30 s
});

test('the planner\'s pace is the starting point when none was chosen here', () => {
  const plan = JSON.stringify({ guide: 'x', state: { pace: 3.4 } });
  const page = miniPage('en', { [P.PLAN_KEY]: plan });
  P.start(page.doc, page.win);
  assert.strictEqual(page.els['stage-pace'].value, '3.4');
  assert.deepStrictEqual(page.kept, { [P.PLAN_KEY]: plan });   // read only: the plan is left as it was
});
