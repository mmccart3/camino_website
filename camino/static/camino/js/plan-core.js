/* plan-core.js: the itinerary model behind /plan/.
 *
 * No page code here, so the same file runs in the browser (window.CaminoPlan) and in Node tests.
 * Everything is a pure function of (state, data). `data` is /plan/data.json, `state` is the
 * itinerary the visitor is building:
 *   { v: 1, name, startDate: 'YYYY-MM-DD' | '', pace, days: [day, ...] }
 *   day = { t: 's', stage, stay }                 a guidebook stage
 *       | { t: 'r', stay }                        a rest day where the day before ended
 *       | { t: 't', from, to, stay }              travel by other means (flight, bus, taxi)
 *   stay = null | { k: 'a' | 'p' | 'c', id, name, status }   albergue, private, or the visitor's own
 *
 * buildFile() produces a camino-personal-backup file (version 1, plans only) that the app's
 * "Restore backup" already accepts. docs/itinerary_exchange_format.md in the app project
 * describes it; tool/itinerary_file.py there is the reference implementation.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaminoPlan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'camino-personal-backup';
  var CUSTOM_STAY_BASE = 1700000000000000; // below 2^53, so a browser holds it exactly
  var STATUSES = ['Considering', 'Requested', 'Booked', 'Confirmed'];
  var KIND_NAMES = { a: 'albergue', p: 'private', c: 'custom' };
  var MAX_DAYS = 120;
  var MAX_TEXT = 20000;

  // ---------------------------------------------------------------- small helpers

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function text(value, limit) { return String(value == null ? '' : value).slice(0, limit); }

  function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var d = new Date(value + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // WalkingTime.estimate(...).inSeconds: weighted * flat / pace, rounded to the microsecond,
  // then cut down to whole seconds.
  function walkingSeconds(weighted, pace, flat) {
    return Math.floor(Math.round(weighted * flat / pace * 1e6) / 1e6);
  }

  function formatKm(metres) { return (metres / 1000).toFixed(1) + ' km'; }

  function formatDuration(seconds) {
    var minutes = Math.round(seconds / 60);
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return h + ' h ' + (m < 10 ? '0' : '') + m + ' min';
  }

  function stageIds(data) {
    return Object.keys(data.stages).map(Number).sort(function (a, b) {
      var x = data.stages[a], y = data.stages[b];
      return (x.section - y.section) || (a - b);
    });
  }

  // ---------------------------------------------------------------- state

  function newState(data) {
    return { v: 1, name: 'My Camino', startDate: '', pace: data.pace.default, days: [] };
  }

  function cleanStay(raw, data) {
    if (!raw || typeof raw !== 'object') return null;
    var k = raw.k;
    if (k !== 'a' && k !== 'p' && k !== 'c') return null;
    var id = Number(raw.id);
    var name = text(raw.name, 200).trim();
    if (!Number.isInteger(id) || !name) return null;
    var status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'Considering';
    return { k: k, id: id, name: name, status: status };
  }

  // Makes anything read back from storage safe to use. Unknown stages are dropped.
  function clean(raw, data) {
    var state = newState(data);
    if (!raw || typeof raw !== 'object') return state;
    state.name = text(raw.name, 80) || state.name;
    if (isIsoDate(raw.startDate)) state.startDate = raw.startDate;
    var pace = Number(raw.pace);
    if (isFinite(pace) && pace >= data.pace.min && pace <= data.pace.max) state.pace = Math.round(pace * 10) / 10;
    var days = Array.isArray(raw.days) ? raw.days.slice(0, MAX_DAYS) : [];
    days.forEach(function (d) {
      if (!d || typeof d !== 'object') return;
      var stay = cleanStay(d.stay, data);
      if (d.t === 's' && data.stages[String(d.stage)]) state.days.push({ t: 's', stage: Number(d.stage), stay: stay });
      else if (d.t === 'r') state.days.push({ t: 'r', stay: stay });
      else if (d.t === 't') state.days.push({ t: 't', from: text(d.from, 100), to: text(d.to, 100), stay: stay });
    });
    return state;
  }

  // "Saint-Jean-Pied-de-Port", "st jean pied de port" and "St Jean Pied de Port" are one place.
  function placeKey(name) {
    return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(function (w) { return w === 'saint' ? 'st' : w; }).join(' ');
  }

  var placeIndexes = typeof WeakMap === 'function' ? new WeakMap() : null;

  function placeIndex(data) {
    var index = placeIndexes && placeIndexes.get(data);
    if (index) return index;
    index = {};
    Object.keys(data.places).forEach(function (id) {
      var key = placeKey(data.places[id]);
      index[key] = key in index ? null : Number(id); // two places with one key: ambiguous
    });
    if (placeIndexes) placeIndexes.set(data, index);
    return index;
  }

  function placeIdByName(name, data) {
    var key = placeKey(name);
    if (!key) return null;
    var id = placeIndex(data)[key];
    return id == null ? null : id;
  }

  // ---------------------------------------------------------------- working out each day

  // One entry per day: dates, places, distance, time, and anything that looks wrong.
  function layout(state, data) {
    var infos = [], here = null, negative = {}, negativeCount = 0;
    function typedPlace(value) {
      var name = String(value || '').trim();
      var id = placeIdByName(name, data);
      if (id) return { id: id, name: data.places[id] };
      var key = name.toLowerCase();
      if (!(key in negative)) negative[key] = -(++negativeCount);
      return { id: negative[key], name: name };
    }
    state.days.forEach(function (day, i) {
      var info = {
        index: i, type: day.t, date: state.startDate ? addDays(state.startDate, i) : null,
        start: null, end: null, metres: null, seconds: null, stage: null, warning: '', invalid: ''
      };
      if (day.t === 's') {
        var st = data.stages[String(day.stage)];
        info.stage = st;
        info.start = { id: st.start, name: data.places[st.start] };
        info.end = { id: st.finish, name: data.places[st.finish] };
        info.metres = st.m;
        info.seconds = walkingSeconds(st.w, state.pace, data.flat);
        if (here && here.id !== st.start) {
          info.warning = 'This day starts at ' + info.start.name + ', but the day before ended at ' + here.name + '.';
        }
      } else if (day.t === 'r') {
        if (!here) info.invalid = 'A rest day needs a place. Add a stage first.';
        else { info.start = here; info.end = here; info.metres = 0; info.seconds = 0; }
      } else {
        var from = String(day.from || '').trim() || (here ? here.name : '');
        var to = String(day.to || '').trim();
        if (!from || !to) info.invalid = !from && !to ? 'Say where this journey starts and ends.' : (!from ? 'Say where this journey starts.' : 'Say where this journey ends.');
        else {
          info.start = typedPlace(from);
          info.end = typedPlace(to);
          if (here && here.id !== info.start.id) {
            info.warning = 'This day starts at ' + info.start.name + ', but the day before ended at ' + here.name + '.';
          }
        }
      }
      if (info.end) here = info.end;
      infos.push(info);
    });
    return { days: infos, end: here };
  }

  function totals(state, data) {
    var l = layout(state, data), t = { days: state.days.length, walking: 0, rest: 0, travel: 0, stays: 0, metres: 0, seconds: 0 };
    l.days.forEach(function (info, i) {
      if (info.type === 's') { t.walking++; t.metres += info.metres; t.seconds += info.seconds; }
      else if (info.type === 'r') t.rest++;
      else t.travel++;
      if (state.days[i].stay) t.stays++;
    });
    return t;
  }

  // ---------------------------------------------------------------- choices offered to the visitor

  function stagesStartingAt(placeId, data) {
    return stageIds(data).filter(function (id) { return data.stages[id].start === placeId; });
  }

  // Stages that begin at the very start of the guide: places no stage finishes at.
  function startOptions(data) {
    var finishes = {};
    Object.keys(data.stages).forEach(function (id) { finishes[data.stages[id].finish] = true; });
    return stageIds(data).filter(function (id) { return !finishes[data.stages[id].start]; });
  }

  // Every place a walking day can begin, in the order the route reaches them.
  function startPlaces(data) {
    var first = {};
    Object.keys(data.stages).forEach(function (id) {
      var st = data.stages[id];
      if (!(st.start in first) || st.section < first[st.start]) first[st.start] = st.section;
    });
    return Object.keys(first).map(Number).sort(function (a, b) {
      return (first[a] - first[b]) || (a - b);
    }).map(function (id) { return { id: id, name: data.places[id] }; });
  }

  // The state as it stands just before day number `at` (0 = the start); used when a day is inserted.
  function before(state, at) {
    if (at === undefined || at === null || at >= state.days.length) return state;
    return { days: state.days.slice(0, Math.max(0, at)), pace: state.pace, startDate: state.startDate };
  }

  // What can be added next: the stages that begin where the day before the new one ended.
  // `at` is where the new day will go; leave it out to add to the end.
  function nextOptions(state, data, at) {
    state = before(state, at);
    if (!state.days.length) return { mode: 'start', stages: startOptions(data) };
    var end = layout(state, data).end;
    if (!end) return { mode: 'start', stages: startOptions(data) };
    if (end.id < 0) return { mode: 'elsewhere', stages: startOptions(data), place: end };
    var options = stagesStartingAt(end.id, data);
    return { mode: options.length ? 'next' : 'finished', stages: options, place: end };
  }

  // Other routes for the same stage (same start and finish).
  function siblings(stageId, data) {
    var st = data.stages[String(stageId)];
    return stageIds(data).filter(function (id) {
      var o = data.stages[id];
      return o.start === st.start && o.finish === st.finish;
    });
  }

  function staysAt(placeId, data) {
    var out = { albergues: [], privates: [] };
    data.stays.forEach(function (s) {
      if (s[2] !== placeId) return;
      (s[0] === 0 ? out.albergues : out.privates).push({ k: s[0] === 0 ? 'a' : 'p', id: s[1], name: s[3] });
    });
    return out;
  }

  // ---------------------------------------------------------------- changing the itinerary (each returns a new state)

  function withDays(state, fn) { var s = clone(state); fn(s.days); return s; }

  function insertDay(state, at, day) {
    if (state.days.length >= MAX_DAYS) return state;
    return withDays(state, function (d) {
      var i = (at === undefined || at === null || at > d.length) ? d.length : Math.max(0, at);
      d.splice(i, 0, day);
    });
  }
  // The three adders take an optional `at`: the position the new day should take (default: the end).
  function addStage(state, stageId, at) { return insertDay(state, at, { t: 's', stage: stageId, stay: null }); }
  function addRest(state, at) { return insertDay(state, at, { t: 'r', stay: null }); }
  function addTravel(state, data, at) {
    var end = layout(before(state, at), data).end;
    return insertDay(state, at, { t: 't', from: end ? end.name : '', to: '', stay: null });
  }
  function removeDay(state, i) { return withDays(state, function (d) { d.splice(i, 1); }); }
  function moveDay(state, i, by) {
    var j = i + by;
    if (j < 0 || j >= state.days.length) return state;
    return withDays(state, function (d) { var t = d[i]; d[i] = d[j]; d[j] = t; });
  }
  function setStage(state, i, stageId) {
    return withDays(state, function (d) { if (d[i] && d[i].t === 's') d[i].stage = stageId; });
  }
  function setTravel(state, i, patch) {
    return withDays(state, function (d) {
      if (!d[i] || d[i].t !== 't') return;
      if ('from' in patch) d[i].from = text(patch.from, 100);
      if ('to' in patch) d[i].to = text(patch.to, 100);
    });
  }
  function setStay(state, i, stay, data) {
    return withDays(state, function (d) { if (d[i]) d[i].stay = stay ? cleanStay(stay, data) : null; });
  }
  function setStayStatus(state, i, status) {
    return withDays(state, function (d) {
      if (d[i] && d[i].stay && STATUSES.indexOf(status) >= 0) d[i].stay.status = status;
    });
  }
  function setMeta(state, patch, data) {
    var s = clone(state);
    if ('name' in patch) s.name = text(patch.name, 80).trim() || 'My Camino';
    if ('startDate' in patch) s.startDate = isIsoDate(patch.startDate) ? patch.startDate : '';
    if ('pace' in patch) {
      var p = Number(patch.pace);
      if (isFinite(p)) s.pace = Math.min(data.pace.max, Math.max(data.pace.min, Math.round(p * 10) / 10));
    }
    return s;
  }

  // ---------------------------------------------------------------- the file for the app

  function buildFile(state, data, createdIso) {
    var l = layout(state, data);
    var bad = l.days.filter(function (i) { return i.invalid; })[0];
    if (bad) throw new Error('Day ' + (bad.index + 1) + ': ' + bad.invalid);
    if (!state.days.length) throw new Error('Add at least one day first.');
    var guide = data.guide.slice(0, 8);
    var stayCount = 0;
    var days = state.days.map(function (day, n) {
      var info = l.days[n];
      var route = {
        isRestDay: day.t === 'r', id: 'web-' + guide + '-' + (n + 1),
        paths: day.t === 's' ? info.stage.paths : [], pace: state.pace, date: info.date,
        departureMinutes: 480, breaks: {}
      };
      var row = {
        ordinal: n, start_id: info.start.id, end_id: info.end.id,
        start_name: info.start.name, end_name: info.end.name,
        metres: day.t === 't' ? null : info.metres, seconds: day.t === 't' ? null : info.seconds
      };
      var stay = null;
      if (day.stay) {
        stayCount++;
        var custom = day.stay.k === 'c';
        stay = {
          id: custom ? CUSTOM_STAY_BASE + stayCount : day.stay.id, kind: KIND_NAMES[day.stay.k],
          name: day.stay.name, status: day.stay.status, reference: '', notes: '', contact: ''
        };
      }
      row.route = JSON.stringify(route);
      row.stay = stay ? JSON.stringify(stay) : null;
      return row;
    });
    var doc = {
      format: FORMAT, version: 1, created: createdIso || new Date().toISOString().replace('Z', '000Z'),
      includesPhotos: false, plans: [{ name: String(state.name || '').trim() || 'My Camino', days: days }], entries: [], locationFavourites: [],
      source: { tool: 'website-planner', itineraryFormat: 1, guideFingerprint: data.guide }
    };
    var errors = checkFile(doc);
    if (errors.length) throw new Error('The file would not pass the app\'s checks: ' + errors[0]);
    return doc;
  }

  // A compact copy of the app's import rules (see check_document in tool/itinerary_file.py).
  function checkFile(doc) {
    var errors = [];
    function int(v) { return typeof v === 'number' && Number.isInteger(v); }
    if (!doc || doc.format !== FORMAT || doc.version !== 1 || typeof doc.includesPhotos !== 'boolean' ||
        typeof doc.created !== 'string' || isNaN(Date.parse(doc.created))) return ['Not a Camino backup file.'];
    if (!Array.isArray(doc.plans) || !Array.isArray(doc.entries) || !Array.isArray(doc.locationFavourites)) return ['Missing lists.'];
    doc.plans.forEach(function (plan, p) {
      if (typeof plan.name !== 'string' || plan.name.length > MAX_TEXT || !Array.isArray(plan.days) || plan.days.length > 1000) {
        errors.push('plan ' + (p + 1) + ' is invalid'); return;
      }
      plan.days.forEach(function (d, i) {
        var where = 'day ' + (i + 1) + ': ';
        if (![d.ordinal, d.start_id, d.end_id].every(int) || typeof d.start_name !== 'string' ||
            typeof d.end_name !== 'string' || typeof d.route !== 'string') { errors.push(where + 'missing fields'); return; }
        if (d.metres != null && (typeof d.metres !== 'number' || !isFinite(d.metres) || d.metres < 0)) errors.push(where + 'bad metres');
        if (d.seconds != null && (!int(d.seconds) || d.seconds < 0)) errors.push(where + 'bad seconds');
        var route;
        try { route = JSON.parse(d.route); } catch (e) { errors.push(where + 'route is not JSON text'); return; }
        if (typeof route.id !== 'string' || !Array.isArray(route.paths) || !route.paths.every(int) ||
            new Set(route.paths).size !== route.paths.length || route.paths.some(function (x) { return x <= 0; })) errors.push(where + 'bad paths');
        if (!(route.pace >= 1 && route.pace <= 8.5)) errors.push(where + 'bad pace');
        if (route.date != null && !isIsoDate(route.date)) errors.push(where + 'bad date');
        if (!int(route.departureMinutes) || route.departureMinutes < 0 || route.departureMinutes > 1439) errors.push(where + 'bad departure');
        if ((d.start_id < 0 || d.end_id < 0) && (route.paths.length || (d.metres != null && d.metres !== 0) || (d.seconds != null && d.seconds !== 0))) {
          errors.push(where + 'an unknown place cannot have a route or distance');
        }
        if (route.isRestDay && (route.paths.length || (d.metres != null && d.metres !== 0))) errors.push(where + 'rest day has a route');
        if (d.stay != null) {
          var stay;
          try { stay = JSON.parse(d.stay); } catch (e) { errors.push(where + 'stay is not JSON text'); return; }
          if (!int(stay.id) || ['albergue', 'private', 'custom'].indexOf(stay.kind) < 0 || STATUSES.indexOf(stay.status) < 0 ||
              typeof stay.name !== 'string' || typeof stay.reference !== 'string' || typeof stay.notes !== 'string') errors.push(where + 'bad stay');
        }
        [d.start_name, d.end_name, route.id].forEach(function (t) { if (t.length > MAX_TEXT) errors.push(where + 'text too long'); });
      });
    });
    return errors;
  }

  function fileName(state) {
    var slug = String(state.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'itinerary';
    return 'camino-itinerary-' + slug + '.json';
  }

  return {
    STATUSES: STATUSES, MAX_DAYS: MAX_DAYS,
    newState: newState, clean: clean, layout: layout, totals: totals,
    stageIds: stageIds, nextOptions: nextOptions, startOptions: startOptions, startPlaces: startPlaces,
    stagesStartingAt: stagesStartingAt, siblings: siblings, staysAt: staysAt, placeIdByName: placeIdByName,
    addStage: addStage, addRest: addRest, addTravel: addTravel, removeDay: removeDay, moveDay: moveDay,
    setStage: setStage, setTravel: setTravel, setStay: setStay, setStayStatus: setStayStatus, setMeta: setMeta,
    buildFile: buildFile, checkFile: checkFile, fileName: fileName,
    formatKm: formatKm, formatDuration: formatDuration, walkingSeconds: walkingSeconds, addDays: addDays, isIsoDate: isIsoDate
  };
});
