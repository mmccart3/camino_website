/* stage-pace.js: the walking-pace control on a stage page (/stage/<id>/).
 *
 * The times the page is built with are for the guide's pace (4.2 km/h on the flat). Time on foot is the
 * weighted distance divided by the pace, so a different pace scales every time by guidePace / pace, exactly
 * what the planner does (plan-core.js, walkingSeconds). The stage's "Est. Time" is worked out the way the app does
 * it, from the stage's weighted distance (stageMinutes), so the page and the app agree to the minute. This file rescales the "Est. Time" figure and the
 * time at each place along the stage when the visitor moves the slider, and remembers the choice in this
 * browser. Without the script (or with storage blocked) the page shows the guide's figures and the slider
 * stays hidden.
 *
 * No page code in the pure functions, so the same file runs in the browser (window.CaminoStagePace) and in
 * Node tests (camino/jstests/stage-pace.test.js).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CaminoStagePace = api;
    if (root.document) api.start(root.document, root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'camino-pace-v1';   // the pace chosen on a stage page (a plain number)
  var PLAN_KEY = 'camino-plan-v1';      // the planner's saved plan; only read, to start from the pace chosen there

  function fill(text, values) {
    return String(text).replace(/\{(\w+)\}/g, function (all, key) { return key in values ? values[key] : all; });
  }

  // A pace the page offers (one decimal, within the limits), or null.
  function tidyPace(value, limits) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    n = Math.round(n * 10) / 10;
    return n >= limits.min && n <= limits.max ? n : null;
  }

  // Seconds on foot at `pace`, given seconds at the guide's pace `base`. The guide's own pace gives back the
  // figure unchanged (so a minute boundary is never lost to rounding); others are rounded to the millisecond.
  function scaleSeconds(seconds, pace, base) {
    if (pace === base) return seconds;
    return Math.round(seconds * base / pace * 1000) / 1000;
  }

  // The stage's whole minutes at `pace`, from the stage's weighted distance: the app's own rule. It makes a Duration of
  // round(weighted * flat / pace * 1e6) microseconds and shows it rounded UP to a minute (WalkingTime in the app). At the
  // guide's pace this is the stored stage time, for every stage.
  function stageMinutes(weighted, pace, flat) {
    return Math.ceil(Math.floor(weighted * flat / pace * 1e6 + 0.5) / 6e7);
  }

  // The fallback when a page has no weighted distance: the stored minutes, scaled (can differ from the app by a minute or more).
  function scaleMinutes(minutes, pace, base) {
    if (pace === base) return minutes;
    return Math.round(minutes * base / pace);
  }

  // Time at a place along the stage, written as the page writes it ("1 hr 5 min", "40 min", "0 min").
  function placeTime(seconds, txt) {
    var whole = Math.floor(seconds);
    var hours = Math.floor(whole / 3600);
    var minutes = Math.floor((whole % 3600) / 60);
    if (hours > 0) return minutes > 0 ? fill(txt.hrMin, { hours: hours, minutes: minutes }) : fill(txt.hr, { hours: hours });
    return minutes > 0 ? fill(txt.min, { minutes: minutes }) : txt.zeroMin;
  }

  // The stage's "Est. Time", written as the page writes it ("6 hrs 46 mins", "1 hr", "--").
  function totalTime(minutes, txt) {
    var total = parseInt(minutes, 10);
    if (!(total > 0)) return '--';
    var hours = Math.floor(total / 60);
    var rest = total % 60;
    var parts = [];
    if (hours > 0) parts.push(fill(hours === 1 ? txt.totalHr : txt.totalHrs, { n: hours }));
    if (rest > 0) parts.push(fill(rest === 1 ? txt.totalMin : txt.totalMins, { n: rest }));
    return parts.length ? parts.join(' ') : txt.totalZero;
  }

  // "4.2" for English, "4,2" for Spanish.
  function paceNumber(pace, lang) {
    var text = (Math.round(pace * 10) / 10).toFixed(1);
    return lang === 'es' ? text.replace('.', ',') : text;
  }

  // The visitor's saved pace: the one chosen on a stage page, else the planner's, else null.
  function readSaved(storage, limits) {
    var pace = null;
    try { pace = tidyPace(storage.getItem(STORAGE_KEY), limits); } catch (error) { pace = null; }
    if (pace !== null) return pace;
    try {
      var plan = JSON.parse(storage.getItem(PLAN_KEY) || 'null');
      if (plan && plan.state) return tidyPace(plan.state.pace, limits);
    } catch (error) { /* no plan, or not readable */ }
    return null;
  }

  function savePace(storage, pace) {
    try { storage.setItem(STORAGE_KEY, String(pace)); } catch (error) { /* it is only a convenience */ }
  }

  function start(doc, win) {
    var box = doc.getElementById('stage-pace-box');
    var txt = win.STAGE_PACE_TXT;
    var input = doc.getElementById('stage-pace');
    if (!box || !txt || !input) return;
    var out = doc.getElementById('stage-pace-out');
    var hint = doc.getElementById('stage-pace-hint');
    var reset = doc.getElementById('stage-pace-reset');
    var note = doc.getElementById('stage-time-note');
    var total = doc.getElementById('stage-time');
    var places = Array.prototype.slice.call(doc.querySelectorAll('.waypoint-time[data-seconds]'));
    var limits = {
      def: Number(box.getAttribute('data-default')), min: Number(box.getAttribute('data-min')),
      max: Number(box.getAttribute('data-max'))
    };
    if (!isFinite(limits.def) || !isFinite(limits.min) || !isFinite(limits.max)) return;
    var flat = Number(box.getAttribute('data-flat'));
    var weighted = total ? Number(total.getAttribute('data-weighted')) : NaN;
    var exact = total && total.getAttribute('data-weighted') !== null && isFinite(weighted) && weighted > 0 && isFinite(flat) && flat > 0;
    var lang = doc.documentElement.lang === 'es' ? 'es' : 'en';
    var storage = null;
    try { storage = win.localStorage; } catch (error) { storage = null; }

    // What the server wrote, for the guide's pace.
    var originals = places.map(function (el) { return el.textContent; });
    var originalTotal = total ? total.textContent : '';

    function apply(pace, persist) {
      var base = limits.def;
      var isGuide = pace === base;
      input.value = String(pace);
      var label = paceNumber(pace, lang) + ' km/h';
      if (out) out.textContent = label;
      input.setAttribute('aria-valuetext', label);
      if (hint) hint.textContent = fill(txt.hint, { pace: paceNumber(base, lang) });
      if (total && total.getAttribute('data-minutes')) {
        total.textContent = isGuide ? originalTotal
          : totalTime(exact ? stageMinutes(weighted, pace, flat)
            : scaleMinutes(Number(total.getAttribute('data-minutes')), pace, base), txt);
      }
      places.forEach(function (el, i) {
        el.textContent = isGuide ? originals[i]
          : placeTime(scaleSeconds(Number(el.getAttribute('data-seconds')), pace, base), txt);
      });
      if (note) note.textContent = isGuide ? '' : ' (' + fill(txt.at, { pace: paceNumber(pace, lang) }) + ')';
      if (reset) {
        reset.hidden = isGuide;
        reset.textContent = fill(txt.reset, { pace: paceNumber(base, lang) });
      }
      if (persist && storage) savePace(storage, pace);
    }

    var saved = storage ? readSaved(storage, limits) : null;
    box.hidden = false;
    apply(saved === null ? limits.def : saved, false);
    input.addEventListener('input', function () {
      var pace = tidyPace(input.value, limits);
      if (pace !== null) apply(pace, true);
    });
    if (reset) reset.addEventListener('click', function () { apply(limits.def, true); input.focus(); });
  }

  return {
    STORAGE_KEY: STORAGE_KEY, PLAN_KEY: PLAN_KEY, fill: fill, tidyPace: tidyPace, scaleSeconds: scaleSeconds,
    scaleMinutes: scaleMinutes, stageMinutes: stageMinutes, placeTime: placeTime, totalTime: totalTime, paceNumber: paceNumber,
    readSaved: readSaved, savePace: savePace, start: start
  };
});
