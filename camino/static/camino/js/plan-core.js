/* plan-core.js: the itinerary model behind /plan/.
 *
 * No page code here, so the same file runs in the browser (window.CaminoPlan) and in Node tests.
 * Everything is a pure function of (state, data). `data` is /plan/data.json, `state` is the
 * itinerary the visitor is building:
 *   { v: 1, name, startDate: 'YYYY-MM-DD' | '', pace, days: [day, ...] }
 *   day = { t: 's', stage, stay }                 a guidebook stage
 *       | { t: 'c', paths: [path ids], stay }     a walking day of the visitor's own, over these paths
 *       | { t: 'r', stay, at? }                   a rest day where the day before ended; the first day of a plan
 *                                                 has no day before, so it names its own place in `at`
 *       | { t: 't', from, to, stay, same, mode?, dep?, arr?, ref?, notes? }
 *                                                 travel by other means (flight, bus, taxi); `same` puts it on
 *                                                 the same date as the day before (walk, then bus); `mode` is one
 *                                                 of MODES, `dep` and `arr` are minutes after midnight, `ref` is a
 *                                                 ticket or booking reference
 *   stay = null | { k: 'a' | 'p' | 'c', id, name, status, ref?, notes?, contact? }
 *                                                 albergue, private, or the visitor's own; `ref` is the booking
 *                                                 reference (it travels in a plan code), `notes` and `contact` go
 *                                                 in the file only
 *   Optional fields are left out when empty.
 *
 * buildFile() produces a camino-personal-backup file (version 1, plans only) that the app's
 * "Restore backup" already accepts. docs/itinerary_exchange_format.md in the app project
 * describes it; tool/itinerary_file.py there is the reference implementation.
 */
(function (root, factory) {
  var api = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaminoPlan = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // The words shown to the visitor go through t(), so the Spanish page can translate them (see i18n.js). Without
  // i18n.js (the Node tests) the English text is used as written.
  function t(message) {
    var args = Array.prototype.slice.call(arguments, 1);
    var translate = root.camT;
    if (typeof translate === 'function') return translate.apply(null, [message].concat(args));
    return message.replace(/\{(\w+)\}/g, function (all, key) { return args[Number(key)] === undefined ? all : String(args[Number(key)]); });
  }
  function number(value) { return root.CaminoI18n ? root.CaminoI18n.num(value) : String(value); }

  var FORMAT = 'camino-personal-backup';
  var CUSTOM_STAY_BASE = 1700000000000000; // below 2^53, so a browser holds it exactly
  var STATUSES = ['Considering', 'Requested', 'Booked', 'Confirmed'];
  var KIND_NAMES = { a: 'albergue', p: 'private', c: 'custom' };
  var MAX_DAYS = 120;
  var MAX_TEXT = 20000;
  // How a travel day is made. Order matters: a plan code stores the position (see plan-share.js).
  var MODES = ['flight', 'train', 'bus', 'taxi', 'ferry', 'other'];
  var MAX_REF = 40;            // a booking or ticket reference
  var MAX_TRAVEL_NOTES = 200;  // notes on a travel day (they travel in a plan code)
  var MAX_STAY_NOTES = 500;    // notes on a stay (file only)
  var MAX_CONTACT = 100;       // contact for a stay (file only)

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

  function formatKm(metres) { return number((metres / 1000).toFixed(1)) + ' km'; }
  // Whole metres with a comma between thousands: "1,534 m".
  function formatMetres(n) {
    var separator = root.CaminoI18n && root.CaminoI18n.language() === 'es' ? '.' : ',';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, separator) + ' m';
  }

  // Minutes after midnight (0 to 1439) as "07:30", and back. parseClock accepts "7:30" and "0730";
  // anything else gives null.
  function formatClock(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return '';
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function parseClock(value) {
    var m = /^\s*(\d{1,2}):?(\d{2})\s*$/.exec(String(value == null ? '' : value));
    if (!m) return null;
    var h = Number(m[1]), min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : null;
  }
  function cleanMinutes(value) {
    return Number.isInteger(value) && value >= 0 && value <= 1439 ? value : null;
  }
  // A journey whose arrival time is earlier than its departure time ends the next day (a night flight or train).
  // The times are times of day only, so this is the one thing they can say about the date.
  function arrivesNextDay(day) {
    return !!day && cleanMinutes(day.dep) !== null && cleanMinutes(day.arr) !== null && day.arr < day.dep;
  }

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
    return { v: 1, name: t('My Camino'), startDate: '', pace: data.pace.default, days: [] };
  }

  function cleanStay(raw, data) {
    if (!raw || typeof raw !== 'object') return null;
    var k = raw.k;
    if (k !== 'a' && k !== 'p' && k !== 'c') return null;
    var id = Number(raw.id);
    var name = text(raw.name, 200).trim();
    if (!Number.isInteger(id) || !name) return null;
    var status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'Considering';
    var stay = { k: k, id: id, name: name, status: status };
    var ref = text(raw.ref, MAX_REF).trim(), notes = text(raw.notes, MAX_STAY_NOTES).trim(), contact = text(raw.contact, MAX_CONTACT).trim();
    if (ref) stay.ref = ref;
    if (notes) stay.notes = notes;
    if (contact) stay.contact = contact;
    return stay;
  }

  // The optional parts of a travel day, kept only when they have a value.
  function travelDetails(raw) {
    var out = {}, ref = text(raw.ref, MAX_REF).trim(), notes = text(raw.notes, MAX_TRAVEL_NOTES).trim();
    var dep = cleanMinutes(raw.dep), arr = cleanMinutes(raw.arr);
    if (MODES.indexOf(raw.mode) >= 0) out.mode = raw.mode;
    if (dep !== null) out.dep = dep;
    if (arr !== null) out.arr = arr;
    if (ref) out.ref = ref;
    if (notes) out.notes = notes;
    return out;
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
      else if (d.t === 'c' && Array.isArray(d.paths) && chainTotals(d.paths.map(Number), data)) {
        state.days.push({ t: 'c', paths: d.paths.map(Number), stay: stay });
      } else if (d.t === 'r') {
        var rest = { t: 'r', stay: stay };
        var at = text(d.at, 100).trim();
        if (at && state.days.length === 0) rest.at = at;   // only the first day names its own place
        state.days.push(rest);
      } else if (d.t === 't') {
        var travel = { t: 't', from: text(d.from, 100), to: text(d.to, 100), stay: stay, same: d.same === true && state.days.length > 0 };
        state.days.push(Object.assign(travel, travelDetails(d)));
      }
    });
    if (raw.done === true && state.days.length) state.done = true;   // "my plan is complete": only a plan with days can be
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

  // ---------------------------------------------------------------- walking between any two places
  // The same rules as the app's WalkingDayPlanner: paths join where one ends and the next begins,
  // and a day adds every track point's distance except the first point of the day and the first
  // point of a path that starts another stage's track. The server works out each path's totals
  // and which joins are allowed (see camino/planner.py); this only adds them up.

  var graphs = typeof WeakMap === 'function' ? new WeakMap() : null;
  var MAX_STOP_METRES = 60000;
  var LONG_DAY_METRES = 30000;   // a day longer than this is called a long day

  function graph(data) {
    var g = graphs && graphs.get(data);
    if (g) return g;
    g = { byId: {}, out: {}, next: {}, order: {}, cache: {}, end: null };
    var routes = data.routes || { paths: [], next: {} };
    routes.paths.forEach(function (r) {
      // r[9..12] (climb, descent, first and last height) are left off a path the guide has no heights for
      var p = { id: r[0], o: r[1], d: r[2], stage: r[3], sd: r[4], sw: r[5], fd: r[6], fw: r[7], shape: r[8],
        up: r[12] === undefined ? null : r[9], dn: r[12] === undefined ? null : r[10],
        e0: r[12] === undefined ? null : r[11], e1: r[12] === undefined ? null : r[12] };
      g.byId[p.id] = p;
      (g.out[p.o] = g.out[p.o] || []).push(p.id);
    });
    Object.keys(routes.next).forEach(function (id) {
      g.next[id] = {};
      routes.next[id].forEach(function (j) { g.next[id][j[0]] = j[1]; });
    });
    // Towns: places with somewhere to stay, or where a guidebook stage starts or ends. Other places on
    // the route (a fountain, a junction) are never offered as a stop.
    g.towns = {};
    data.stays.forEach(function (s) { g.towns[s[2]] = true; });
    Object.keys(data.stages).forEach(function (id) { g.towns[data.stages[id].finish] = true; g.towns[data.stages[id].start] = true; });
    // Places in the order the route reaches them, for the lists the visitor picks from.
    var rank = 0;
    stageIds(data).forEach(function (sid) {
      data.stages[sid].paths.forEach(function (pid) {
        var p = g.byId[pid];
        if (p && !(p.o in g.order)) g.order[p.o] = rank++;
      });
      var tail = g.byId[data.stages[sid].paths[data.stages[sid].paths.length - 1]];
      if (tail && !(tail.d in g.order)) g.order[tail.d] = rank++;
    });
    // The end of the guide is the one place no path leaves (Santiago). Not set if there are several.
    var sinks = {}, sinkCount = 0, sinkId = null;
    Object.keys(g.byId).forEach(function (id) {
      var d = g.byId[id].d;
      if (!(d in g.out) && !(d in sinks)) { sinks[d] = true; sinkCount += 1; sinkId = d; }
    });
    g.end = sinkCount === 1 ? sinkId : null;
    if (graphs) graphs.set(data, g);
    return g;
  }

  // Metres, weighted distance, climb and descent and end places of a chain of path ids, or null if it is
  // not a walkable chain (unknown path, paths that do not join, a path used twice). The climb and descent
  // are counted the way the stage pages count them: each path's own, plus the step from one path's last
  // height to the next one's first. They are null when the guide has no heights for some path.
  function chainTotals(chain, data) {
    var g = graph(data), m = 0, w = 0, up = 0, down = 0, heights = true, seen = {};
    if (!Array.isArray(chain) || !chain.length) return null;
    for (var i = 0; i < chain.length; i += 1) {
      var p = g.byId[chain[i]];
      if (!p || seen[p.id]) return null;
      seen[p.id] = true;
      var whole = false;
      if (i > 0) {
        var link = g.next[chain[i - 1]];
        if (!link || !(chain[i] in link)) return null;
        whole = link[chain[i]] === 1;
      }
      m += whole ? p.sd : p.sd - p.fd;
      w += whole ? p.sw : p.sw - p.fw;
      if (p.up === null) {
        heights = false;
      } else {
        up += p.up;
        down += p.dn;
        var before = i > 0 ? g.byId[chain[i - 1]] : null;
        if (before && before.e1 !== null) {
          var step = p.e0 - before.e1;
          if (step > 0) up += step; else down -= step;
        }
      }
    }
    return { metres: m, weighted: w, up: heights ? up : null, down: heights ? down : null,
      from: g.byId[chain[0]].o, to: g.byId[chain[chain.length - 1]].d };
  }

  // Places a day can begin, in route order.
  function routePlaces(data) {
    var g = graph(data);
    return Object.keys(g.out).map(Number).filter(function (id) { return id in data.places && g.towns[id]; })
      .sort(function (a, b) { return (g.order[a] - g.order[b]) || (a - b); })
      .map(function (id) { return { id: id, name: data.places[id] }; });
  }

  // Every way of walking from one place to another, as the app lists them (WalkingDayPlanner.routes)
  // but keeping to whole guidebook stages: a route only changes from one stage to another where a
  // stage finishes and the next begins. Mixing the variants part-way through a stage gives dozens of
  // near-identical routes (the app itself refuses to list them), so those are only offered when there
  // is no route that follows the stages.
  function routesBetween(from, to, data) {
    var g = graph(data), key = from + '>' + to;
    if (from === to || !(from in g.out)) return { routes: [], tooMany: false };
    if (g.cache[key]) return g.cache[key];            // the same pair is asked for on every redraw
    var found = search(from, to, data, true);
    if (!found.routes.length) found = search(from, to, data, false);
    g.cache[key] = found;
    return found;
  }

  function search(from, to, data, strict) {
    var g = graph(data), results = [], seenShapes = {}, explored = 0, tooMany = false;
    var incoming = {};
    Object.keys(g.byId).forEach(function (id) {
      var p = g.byId[id];
      (incoming[p.d] = incoming[p.d] || []).push(p.o);
    });
    var reach = {}, pending = [to];
    reach[to] = true;
    while (pending.length) {
      (incoming[pending.pop()] || []).forEach(function (o) {
        if (!reach[o]) { reach[o] = true; pending.push(o); }
      });
    }
    // Changing stage is only allowed where the stage left is finished and the new one is at its start.
    function stageChangeOk(before, after) {
      if (before.stage === after.stage) return true;
      var left = data.stages[before.stage], entered = data.stages[after.stage];
      return !!left && !!entered && left.paths[left.paths.length - 1] === before.id && entered.paths[0] === after.id;
    }
    function visit(current, chain, visited) {
      if (tooMany) return;
      explored += 1;
      if (explored > 10000) { tooMany = true; return; }
      if (current === to) {
        var shape = chain.map(function (pid) { return g.byId[pid].shape; }).join('>');
        if (seenShapes[shape]) return; // the same walk under another path number
        seenShapes[shape] = true;
        results.push(chain.slice());
        if (results.length > 64) tooMany = true;
        return;
      }
      (g.out[current] || []).forEach(function (pid) {
        var p = g.byId[pid];
        if (visited[p.d] || !reach[p.d]) return;
        if (chain.length) {
          var last = chain[chain.length - 1], link = g.next[last];
          if (!link || !(pid in link)) return;
          if (strict && !stageChangeOk(g.byId[last], p)) return;
        }
        visited[p.d] = true;
        chain.push(pid);
        visit(p.d, chain, visited);
        chain.pop();
        delete visited[p.d];
      });
    }
    var visited = {};
    visited[from] = true;
    visit(from, [], visited);
    // Too many hybrid routes and none that follow the stages: offer nothing rather than a pile.
    return { routes: tooMany && !strict ? [] : results, tooMany: tooMany };
  }

  // The place the guide ends at (Santiago), or null if the data does not say.
  function guideEnd(data) { return graph(data).end; }

  // About how far it is on foot from a place to the end of the guide, by the shortest way; null if it
  // cannot be reached. (Whole path lengths, so it can differ from a real day by a few metres.)
  function metresToEnd(from, data) {
    var g = graph(data), end = g.end;
    if (end === null || !(from in data.places)) return null;
    if (from === end) return 0;
    var best = {}, done = {};
    best[from] = 0;
    for (;;) {
      var here = null;
      Object.keys(best).forEach(function (id) {
        if (!done[id] && (here === null || best[id] < best[here])) here = id;
      });
      if (here === null) return null;
      if (Number(here) === end) return best[here];
      done[here] = true;
      (g.out[here] || []).forEach(function (pid) {
        var p = g.byId[pid], m = best[here] + p.sd;
        if (!(p.d in best) || m < best[p.d]) best[p.d] = m;
      });
    }
  }

  // A key for the walk a chain describes, the same for chains that follow the same line on the map.
  function chainKey(chain, data) {
    var g = graph(data);
    return chain.map(function (pid) { return g.byId[pid] ? g.byId[pid].shape : '?'; }).join('>');
  }

  // Towns reachable on foot from here within maxMetres, nearest first. Each has the routes the visitor
  // can be offered (shortest first) and the totals of the shortest.
  function stopsFrom(from, data, maxMetres) {
    var g = graph(data), seen = {}, explored = 0, limit = maxMetres || MAX_STOP_METRES;
    function visit(chain, metres, visited) {
      explored += 1;
      if (explored > 20000) return;
      var current = chain.length ? g.byId[chain[chain.length - 1]].d : from;
      (g.out[current] || []).forEach(function (pid) {
        var p = g.byId[pid], whole = false;
        if (visited[p.d]) return;
        if (chain.length) {
          var link = g.next[chain[chain.length - 1]];
          if (!link || !(pid in link)) return;
          whole = link[pid] === 1;
        }
        var m = metres + (whole ? p.sd : p.sd - p.fd);
        if (m > limit) return;
        if (g.towns[p.d]) seen[p.d] = true;
        visited[p.d] = true;
        visit(chain.concat([pid]), m, visited);
        delete visited[p.d];
      });
    }
    var visited = {};
    visited[from] = true;
    visit([], 0, visited);
    var stops = [];
    Object.keys(seen).forEach(function (id) {
      var place = Number(id), found = routesBetween(from, place, data).routes;
      var offered = found.map(function (chain) { var t = chainTotals(chain, data); return { chain: chain, metres: t.metres, weighted: t.weighted, up: t.up, down: t.down }; })
        .sort(function (a, b) { return a.metres - b.metres; });
      if (!offered.length || offered[0].metres > limit) return;
      stops.push({ place: place, name: data.places[place], metres: offered[0].metres, weighted: offered[0].weighted,
        up: offered[0].up, down: offered[0].down, chain: offered[0].chain, routes: offered.map(function (o) { return o.chain; }) });
    });
    return stops.sort(function (a, b) { return a.metres - b.metres; });
  }

  // How the routes between two places differ: the names of the stages each one uses that the others do not.
  function routeLabel(chain, all, data) {
    var g = graph(data);
    function names(c) {
      var seen = [], out = [];
      c.forEach(function (pid) {
        var sid = g.byId[pid].stage;
        if (seen.indexOf(sid) < 0) { seen.push(sid); out.push(sid); }
      });
      return out;
    }
    var mine = names(chain), others = {};
    all.forEach(function (c) { if (c !== chain) names(c).forEach(function (sid) { others[sid] = (others[sid] || 0) + 1; }); });
    var unique = mine.filter(function (sid) { return !others[sid]; });
    return (unique.length ? unique : mine).map(function (sid) { return data.stages[sid] ? data.stages[sid].name : ''; }).filter(Boolean).join(', ');
  }

  // Short names for a set of alternative routes: only what tells them apart. Routes that share the
  // start of their name ("St Jean to Roncesvalles", "St Jean to Roncesvalles via Valcarlos") keep
  // just the difference; a route with nothing left is called by its kind.
  var ROUTE_KIND_NAMES = { main: 'Main route', valley: 'Valley route', mountain: 'Mountain route', alt: 'Alternative route' };  // shown through t()

  function routeLabels(all, data) {
    var g = graph(data);
    var full = all.map(function (chain) { return routeLabel(chain, all, data); });
    if (all.length < 2) return full;
    var words = full.map(function (text) { return text.split(' '); });
    var common = 0;
    while (words.every(function (w) { return w.length > common && w[common] === words[0][common]; })) common += 1;
    if (!common) return full;
    var short = words.map(function (w, i) {
      var rest = w.slice(common).join(' ');
      if (!rest) {
        var stage = data.stages[String(g.byId[all[i][0]].stage)];
        return t((stage && ROUTE_KIND_NAMES[stage.kind]) || 'Standard route');
      }
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    });
    var distinct = short.every(function (text, i) { return short.indexOf(text) === i; });
    return distinct ? short : full;
  }

  // ---------------------------------------------------------------- working out each day

  // One entry per day: dates, places, distance, time, and anything that looks wrong.
  // A walking day's climb and descent in whole metres (null when the guide has no heights), and whether it is a long day.
  function setClimb(info, total) {
    info.up = total && total.up !== null ? Math.round(total.up) : null;
    info.down = total && total.down !== null ? Math.round(total.down) : null;
    info.long = info.metres !== null && info.metres > LONG_DAY_METRES;
  }

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
    var offset = -1;   // days since the first day; a journey on the same day as the one before adds none
    state.days.forEach(function (day, i) {
      var same = day.t === 't' && !!day.same && i > 0;
      if (!same) offset += 1;
      var info = {
        index: i, type: day.t, same: same, no: offset + 1, part: 1, parts: 1,
        date: state.startDate ? addDays(state.startDate, offset) : null,
        start: null, end: null, metres: null, seconds: null, up: null, down: null, long: false, stage: null, warning: '', invalid: ''
      };
      if (day.t === 's') {
        var st = data.stages[String(day.stage)];
        info.stage = st;
        info.start = { id: st.start, name: data.places[st.start] };
        info.end = { id: st.finish, name: data.places[st.finish] };
        info.metres = st.m;
        info.seconds = walkingSeconds(st.w, state.pace, data.flat);
        setClimb(info, chainTotals(st.paths, data));
        if (here && here.id !== st.start) {
          info.warning = t('This day starts at {0}, but the day before ended at {1}.', info.start.name, here.name);
        }
      } else if (day.t === 'r') {
        var restAt = here ? here : (String(day.at || '').trim() ? typedPlace(day.at) : null);
        if (!restAt) info.invalid = t('Say where this rest day is.');
        else { info.start = restAt; info.end = restAt; info.metres = 0; info.seconds = 0; }
      } else if (day.t === 'c') {
        var total = chainTotals(day.paths, data);
        if (!total) info.invalid = t('This part of the route is no longer in the guide. Remove the day and make it again.');
        else {
          info.start = { id: total.from, name: data.places[total.from] };
          info.end = { id: total.to, name: data.places[total.to] };
          info.metres = total.metres;
          info.seconds = walkingSeconds(total.weighted, state.pace, data.flat);
          setClimb(info, total);
          if (here && here.id !== total.from) {
            info.warning = t('This day starts at {0}, but the day before ended at {1}.', info.start.name, here.name);
          }
        }
      } else {
        var from = String(day.from || '').trim() || (here ? here.name : '');
        var to = String(day.to || '').trim();
        if (!from || !to) info.invalid = !from && !to ? t('Say where this journey starts and ends.') : (!from ? t('Say where this journey starts.') : t('Say where this journey ends.'));
        else {
          info.start = typedPlace(from);
          info.end = typedPlace(to);
          if (here && here.id !== info.start.id) {
            info.warning = t('This day starts at {0}, but the day before ended at {1}.', info.start.name, here.name);
          }
        }
      }
      if (info.end) here = info.end;
      infos.push(info);
    });
    // A day split in two (a walk, then a bus the same day) is one numbered day in several parts.
    var count = {}, seen = {};
    infos.forEach(function (info) { count[info.no] = (count[info.no] || 0) + 1; });
    infos.forEach(function (info) {
      seen[info.no] = (seen[info.no] || 0) + 1;
      info.part = seen[info.no];
      info.parts = count[info.no];
    });
    return { days: infos, end: here };
  }

  // How a day is named: "Day 3", or "Day 3 – part 2" when the day has more than one part.
  function dayLabel(info) { return info.parts > 1 ? t('Day {0} \u2013 part {1}', info.no, info.part) : t('Day {0}', info.no); }
  // The same for use in a sentence: "day 3" or "day 3, part 2".
  function dayRef(info) { return info.parts > 1 ? t('day {0}, part {1}', info.no, info.part) : t('day {0}', info.no); }

  // `days` are calendar days (a journey on the same day as the day before does not add one); `entries`
  // counts every row of the plan. A night counts as chosen when any row of that day has a stay.
  function totals(state, data) {
    var l = layout(state, data), t = { days: 0, entries: state.days.length, walking: 0, rest: 0, travel: 0, stays: 0, metres: 0, seconds: 0, up: 0, down: 0, climb: true, long: 0 };
    var group = -1, nights = {};
    l.days.forEach(function (info, i) {
      if (!info.same) group += 1;
      if (state.days[i].stay) nights[group] = true;
      if (info.type === 's' || info.type === 'c') {
        t.walking++;
        if (info.metres !== null) { t.metres += info.metres; t.seconds += info.seconds; }
        if (info.up === null || info.down === null) { if (info.metres !== null) t.climb = false; }   // a sum of the days as shown
        else { t.up += info.up; t.down += info.down; }
        if (info.long) t.long++;
      }
      else if (info.type === 'r') t.rest++;
      else t.travel++;
    });
    t.days = group + 1;
    t.stays = Object.keys(nights).length;
    return t;
  }

  // ---------------------------------------------------------------- choices offered to the visitor

  // The state as it stands just before day number `at` (0 = the start); used when a day is inserted.
  function before(state, at) {
    if (at === undefined || at === null || at >= state.days.length) return state;
    return { days: state.days.slice(0, Math.max(0, at)), pace: state.pace, startDate: state.startDate };
  }

  // The place the day before position `at` ends at (null if there is none).
  function endBefore(state, data, at) { return layout(before(state, at), data).end; }

  // Where the next walking day starts. It continues from the day before when that ended on the route;
  // otherwise the visitor picks (`chosen`), beginning with the first place of the route.
  function startFor(state, data, at, chosen) {
    var g = graph(data), previous = endBefore(state, data, at);
    if (previous && previous.id > 0 && previous.id in g.out) return { id: previous.id, name: previous.name, fixed: true, previous: previous };
    var places = routePlaces(data);
    var pick = places.filter(function (p) { return p.id === chosen; })[0] || places[0];
    return { id: pick.id, name: pick.name, fixed: false, previous: previous };
  }

  // Places where a guidebook stage finishes.
  function stageEnds(data) {
    var ends = {};
    Object.keys(data.stages).forEach(function (id) { ends[data.stages[id].finish] = true; });
    return ends;
  }

  function stayCount(placeId, data) {
    return data.stays.filter(function (s) { return s[2] === placeId; }).length;
  }

  // The guidebook stage that is exactly this chain of paths, if there is one.
  function stageForChain(chain, data) {
    var key = chain.join(',');
    var found = Object.keys(data.stages).filter(function (id) { return data.stages[id].paths.join(',') === key; })[0];
    return found === undefined ? null : Number(found);
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

  // ---------------------------------------------------------------- what the guide says about a place to stay
  // The details come from /plan/stays.json (see camino/planner.py): p price, px top price, p2 double, n beds,
  // f facility letters, ad address, op opening, ci check-in, rn price note, t phone, wa WhatsApp, em, web, bk.

  var FACILITIES = { k: 'Kitchen', m: 'Communal meal', w: 'Washing machine', d: 'Dryer', r: 'Private rooms' };
  var FACILITIES_SHORT = { k: 'Kitchen', m: 'Meal', w: 'Washer', d: 'Dryer', r: 'Private rooms' };

  function money(n) { return '\u20ac' + (n % 1 ? number(n.toFixed(2)) : String(n)); }

  function facilityNames(letters, short) {
    var words = short ? FACILITIES_SHORT : FACILITIES;
    return String(letters || '').split('').filter(function (c) { return words[c]; }).map(function (c) { return t(words[c]); });
  }

  // The price, beds and facilities on one line, for the list of places: "from \u20ac16 \u00b7 32 beds \u00b7 Kitchen".
  function stayLine(kind, d) {
    if (!d) return '';
    var parts = [];
    if (kind === 'a') {
      if (d.p) parts.push(d.px && d.px > d.p ? t('{0} to {1}', money(d.p), money(d.px)) : t('from {0}', money(d.p)));
      if (d.n) parts.push(d.n === 1 ? t('{0} bed', d.n) : t('{0} beds', d.n));
      parts = parts.concat(facilityNames(d.f, true));
    } else {
      if (d.p) parts.push(t('single from {0}', money(d.p)));
      if (d.p2) parts.push(t('double from {0}', money(d.p2)));
    }
    return parts.join(' \u00b7 ');
  }

  // "+34987123456" as people write it: "+34 987 123 456".
  function formatPhone(t) {
    var m = /^\+(\d+)$/.exec(String(t || ''));
    if (!m) return String(t || '');
    var d = m[1];
    if (d.indexOf('34') === 0 && d.length === 11) return '+34 ' + d.slice(2, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8);
    if (d.indexOf('33') === 0 && d.length === 11) return '+33 ' + d.slice(2, 3) + ' ' + d.slice(3, 5) + ' ' + d.slice(5, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9);
    if (d.indexOf('351') === 0 && d.length === 12) return '+351 ' + d.slice(3, 6) + ' ' + d.slice(6, 9) + ' ' + d.slice(9);
    return '+' + d;
  }

  // A Booking.com link with the site's affiliate details added, the way the town pages make it (camino/models.py).
  function bookingLink(base, affiliate) {
    var url;
    try { url = new URL(String(base || '')); } catch (error) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    Object.keys(affiliate || {}).forEach(function (key) { url.searchParams.set(key, affiliate[key]); });
    return url.toString();
  }

  // The ways to reach a place: [{key, label, href, text}] in the order a walker is likely to use them.
  function stayLinks(d, affiliate) {
    var out = [];
    if (!d) return out;
    // The order the place's own page in the guide uses: Booking.com, WhatsApp, phone, email, website.
    var booking = d.bk ? bookingLink(d.bk, affiliate) : null;
    if (booking) out.push({ key: 'booking', label: 'Booking.com', href: booking, text: 'Booking.com' });
    if (d.wa) out.push({ key: 'whatsapp', label: 'WhatsApp', href: 'https://wa.me/' + d.wa, text: 'WhatsApp' });
    if (d.t) out.push({ key: 'call', label: t('Call'), href: 'tel:' + d.t, text: formatPhone(d.t) });
    if (d.em) out.push({ key: 'email', label: t('Email'), href: 'mailto:' + d.em, text: t('Email') });
    if (d.web) out.push({ key: 'website', label: t('Website'), href: d.web, text: t('Website') });
    return out;
  }

  // ---------------------------------------------------------------- changing the itinerary (each returns a new state)

  // Only the first day names its own place for a rest day; anywhere else the rest is where the day before ended.
  function withDays(state, fn) {
    var s = clone(state);
    fn(s.days);
    s.days.forEach(function (d, i) { if (d.t === 'r' && i > 0) delete d.at; });
    return s;
  }

  function insertDay(state, at, day) {
    if (state.days.length >= MAX_DAYS) return state;
    var atEnd = at === undefined || at === null || at >= state.days.length;
    var next = withDays(state, function (d) {
      var i = (at === undefined || at === null || at > d.length) ? d.length : Math.max(0, at);
      d.splice(i, 0, day);
    });
    if (atEnd) delete next.done;   // a day added at the end means the plan was not complete after all; one put in the middle leaves it so
    return next;
  }
  // The three adders take an optional `at`: the position the new day should take (default: the end).
  function addStage(state, stageId, at) { return insertDay(state, at, { t: 's', stage: stageId, stay: null }); }
  function addRest(state, at) { return insertDay(state, at, { t: 'r', stay: null }); }
  // `same`: on the same date as the day before (walk, then bus). Not possible for the first day.
  function addTravel(state, data, at, same) {
    var end = layout(before(state, at), data).end;
    var position = (at === undefined || at === null || at > state.days.length) ? state.days.length : Math.max(0, at);
    return insertDay(state, at, { t: 't', from: end ? end.name : '', to: '', stay: null, same: !!same && position > 0 });
  }
  function addCustom(state, chain, at) { return insertDay(state, at, { t: 'c', paths: chain.slice(), stay: null }); }
  // A day along this chain of paths: a guidebook stage when it is exactly one, otherwise the visitor's own.
  function addRoute(state, chain, data, at) {
    var sid = stageForChain(chain, data);
    return sid === null ? addCustom(state, chain, at) : addStage(state, sid, at);
  }
  function setCustomRoute(state, i, chain) {
    return withDays(state, function (d) { if (d[i] && d[i].t === 'c') d[i].paths = chain.slice(); });
  }
  // Replaces walking day i with this chain of paths (a guidebook stage if it is exactly one). The place
  // to stay is kept only when the day still ends in the same place.
  function setDayRoute(state, i, chain, data) {
    var day = state.days[i], total = chainTotals(chain, data);
    if (!day || (day.t !== 's' && day.t !== 'c') || !total) return state;
    var end = layout(state, data).days[i].end, sid = stageForChain(chain, data);
    var stay = end && end.id === total.to ? day.stay : null;
    return withDays(state, function (d) {
      d[i] = sid === null ? { t: 'c', paths: chain.slice(), stay: stay } : { t: 's', stage: sid, stay: stay };
    });
  }

  // When a walking day no longer starts where the day before ended: the same day, still ending where
  // it does, but starting from there. Null when that is not possible (no route, or nothing to fix).
  function refitStart(state, i, data) {
    var day = state.days[i];
    if (!day || (day.t !== 's' && day.t !== 'c')) return null;
    var info = layout(state, data).days[i], previous = endBefore(state, data, i);
    if (!info.warning || !previous || previous.id <= 0 || !info.end) return null;
    var found = routesBetween(previous.id, info.end.id, data).routes;
    if (!found.length) return null;
    var mine = day.t === 's' ? data.stages[String(day.stage)].paths : day.paths;
    // Prefer the route that keeps the end of the day as it is, then the shorter one.
    function shared(chain) {
      var n = 0;
      while (n < chain.length && n < mine.length && chain[chain.length - 1 - n] === mine[mine.length - 1 - n]) n += 1;
      return n;
    }
    var best = found.slice().sort(function (a, b) {
      return (shared(b) - shared(a)) || (chainTotals(a, data).metres - chainTotals(b, data).metres);
    })[0];
    return { state: setDayRoute(state, i, best, data), chain: best, from: previous };
  }

  // Where the plan goes, for the summary above the download button.
  function progress(state, data) {
    var l = layout(state, data), t = totals(state, data), first = null;
    l.days.forEach(function (info) { if (!first && info.start) first = info.start; });
    var end = l.end, g = graph(data);
    return {
      days: t.days, metres: t.metres, start: first, end: end,
      reachesEnd: !!end && g.end !== null && end.id === g.end,
      remaining: end && end.id > 0 ? metresToEnd(end.id, data) : null,
      warnings: l.days.filter(function (info) { return info.warning; }).map(function (info) { return info.index; })
    };
  }

  // Rest somewhere else. A rest day is wherever the day before ended, so a different place means a
  // journey first: this puts that journey in front of the rest day. The rest day keeps no place to
  // stay, as the one chosen was for the old place. Returns the same state when nothing changes.
  function moveRest(state, i, name, data) {
    var day = state.days[i], place = text(name, 100).trim();
    if (!day || day.t !== 'r' || !place || state.days.length >= MAX_DAYS) return state;
    var here = endBefore(state, data, i);
    if (!here) return state;
    var id = placeIdByName(place, data);
    if (id !== null ? id === here.id : placeKey(place) === placeKey(here.name)) return state;
    var next = insertDay(state, i, { t: 't', from: here.name, to: id !== null ? data.places[id] : place, stay: null, same: false });
    next.days[i + 1].stay = null;
    return next;
  }

  function removeDay(state, i) {
    var next = withDays(state, function (d) { d.splice(i, 1); });
    if (!next.days.length) delete next.done;
    return next;
  }
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
      if ('same' in patch) d[i].same = !!patch.same && i > 0;
      // How it is made, and the times, reference and notes. An empty value takes the field away.
      var detail = travelDetails(Object.assign({}, d[i], patch));
      ['mode', 'dep', 'arr', 'ref', 'notes'].forEach(function (key) {
        if (key in detail) d[i][key] = detail[key]; else delete d[i][key];
      });
    });
  }
  // The place of a rest day that is the first day of the plan (anywhere else it follows the day before).
  function setRestPlace(state, i, name) {
    return withDays(state, function (d) {
      if (!d[i] || d[i].t !== 'r' || i !== 0) return;
      var place = text(name, 100).trim();
      if (place) d[i].at = place; else delete d[i].at;
    });
  }
  function setStay(state, i, stay, data) {
    return withDays(state, function (d) { if (d[i]) d[i].stay = stay ? cleanStay(stay, data) : null; });
  }
  // The booking reference, notes and contact of the stay on day i. An empty value takes the field away.
  function setStayDetails(state, i, patch) {
    return withDays(state, function (d) {
      if (!d[i] || !d[i].stay) return;
      var merged = Object.assign({}, d[i].stay, patch);
      var stay = cleanStay(merged, null);
      ['ref', 'notes', 'contact'].forEach(function (key) {
        if (stay && key in stay) d[i].stay[key] = stay[key]; else delete d[i].stay[key];
      });
    });
  }
  function setStayStatus(state, i, status) {
    return withDays(state, function (d) {
      if (d[i] && d[i].stay && STATUSES.indexOf(status) >= 0) d[i].stay.status = status;
    });
  }
  // "My plan is complete": the page stops offering a next day. Only a plan with days can be complete, and the
  // mark is the planner's own: it is not in the plan code or the file, which carry the plan and nothing more.
  function setDone(state, done) {
    var s = clone(state);
    if (done && s.days.length) s.done = true; else delete s.done;
    return s;
  }
  function setMeta(state, patch, data) {
    var s = clone(state);
    if ('name' in patch) s.name = text(patch.name, 80).trim() || t('My Camino');
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
    if (bad) throw new Error(t('Day {0}: {1}', bad.index + 1, bad.invalid));
    if (!state.days.length) throw new Error(t('Add at least one day first.'));
    var guide = data.guide.slice(0, 8);
    var stayCount = 0;
    var days = state.days.map(function (day, n) {
      var info = l.days[n];
      var route = {
        isRestDay: day.t === 'r', id: 'web-' + guide + '-' + (n + 1),
        paths: day.t === 's' ? info.stage.paths : (day.t === 'c' ? day.paths : []), pace: state.pace, date: info.date,
        departureMinutes: day.t === 't' && day.dep !== undefined ? day.dep : 480, breaks: {}
      };
      // What a travel day adds. The app keeps only the fields it knows, so until it reads this it is
      // set aside on restore; the plan code and the website keep it.
      if (day.t === 't') {
        var travel = {};
        if (day.mode) travel.mode = day.mode;
        if (day.arr !== undefined) travel.arrivalMinutes = day.arr;
        if (day.ref) travel.reference = day.ref;
        if (day.notes) travel.notes = day.notes;
        if (Object.keys(travel).length) route.travel = travel;
      }
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
          name: day.stay.name, status: day.stay.status,
          reference: day.stay.ref || '', notes: day.stay.notes || '', contact: day.stay.contact || ''
        };
      }
      row.route = JSON.stringify(route);
      row.stay = stay ? JSON.stringify(stay) : null;
      return row;
    });
    var doc = {
      format: FORMAT, version: 1, created: createdIso || new Date().toISOString().replace('Z', '000Z'),
      includesPhotos: false, plans: [{ name: String(state.name || '').trim() || t('My Camino'), days: days }], entries: [], locationFavourites: [],
      source: { tool: 'website-planner', itineraryFormat: 1, guideFingerprint: data.guide }
    };
    var errors = checkFile(doc);
    if (errors.length) throw new Error(t('The file would not pass the app\'s checks: {0}', errors[0]));
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
        if (route.travel !== undefined) {
          var tr = route.travel;
          if (!tr || typeof tr !== 'object' || Array.isArray(tr) || route.isRestDay || route.paths.length) errors.push(where + 'bad travel details');
          else if ((tr.mode !== undefined && MODES.indexOf(tr.mode) < 0) || (tr.arrivalMinutes !== undefined && cleanMinutes(tr.arrivalMinutes) === null) ||
              (tr.reference !== undefined && typeof tr.reference !== 'string') || (tr.notes !== undefined && typeof tr.notes !== 'string')) errors.push(where + 'bad travel details');
        }
        if (d.stay != null) {
          var stay;
          try { stay = JSON.parse(d.stay); } catch (e) { errors.push(where + 'stay is not JSON text'); return; }
          if (!int(stay.id) || ['albergue', 'private', 'custom'].indexOf(stay.kind) < 0 || STATUSES.indexOf(stay.status) < 0 ||
              typeof stay.name !== 'string' || typeof stay.reference !== 'string' || typeof stay.notes !== 'string' ||
              (stay.contact !== undefined && typeof stay.contact !== 'string')) errors.push(where + 'bad stay');
        }
        [d.start_name, d.end_name, route.id].forEach(function (t) { if (t.length > MAX_TEXT) errors.push(where + 'text too long'); });
      });
    });
    return errors;
  }

  // ---------------------------------------------------------------- reading a plan file back in

  var STAY_KINDS = { albergue: 'a', private: 'p', custom: 'c' };

  function knownStay(kind, id, data) {
    return data.stays.some(function (row) { return row[1] === id && row[0] === (kind === 'a' ? 0 : 1); });
  }

  // One plan of an itinerary file as the planner keeps it. What the file cannot say is set to the usual: the
  // dates follow on from the first day, and a journey is "the same day" only when its date is the day before's.
  function planFromFile(plan, data) {
    var rows = plan.days.slice().sort(function (a, b) { return a.ordinal - b.ordinal; });
    var raw = { v: 1, name: plan.name, days: [] }, fileDates = [], skipped = [], pace = null, notes = [];
    rows.forEach(function (row, n) {
      var route = JSON.parse(row.route), date = isIsoDate(route.date) ? route.date : null;
      if (pace === null) pace = route.pace;
      var day;
      if (route.isRestDay) {
        day = { t: 'r' };
        if (!raw.days.length) day.at = row.start_name;
      } else if (!route.paths.length) {
        var travel = route.travel || {};
        day = { t: 't', from: row.start_name, to: row.end_name, mode: travel.mode, arr: travel.arrivalMinutes,
          ref: travel.reference, notes: travel.notes, same: !!(date && raw.days.length && date === fileDates[fileDates.length - 1]) };
        if (route.departureMinutes !== 480) day.dep = route.departureMinutes;   // 8:00 is what a journey with no time is written with
      } else {
        if (!chainTotals(route.paths, data)) { skipped.push(n + 1); return; }
        var stage = stageForChain(route.paths, data);
        day = stage ? { t: 's', stage: stage } : { t: 'c', paths: route.paths };
      }
      if (row.stay) {
        var stay = JSON.parse(row.stay), kind = STAY_KINDS[stay.kind];
        if (kind !== 'c' && !knownStay(kind, stay.id, data)) kind = 'c';   // not a place this guide has: keep its name
        day.stay = { k: kind, id: kind === 'c' ? 0 : stay.id, name: stay.name, status: stay.status,
          ref: stay.reference, notes: stay.notes, contact: stay.contact };
      }
      raw.days.push(day);
      fileDates.push(date);
    });
    raw.startDate = fileDates[0] || '';
    raw.pace = pace;
    var state = clean(raw, data);
    if (skipped.length) {
      notes.push(skipped.length === 1 ? t('Day {0} was left out, because its route is not in this guide.', skipped[0])
        : t('{0} days were left out (days {1}), because their routes are not in this guide.', skipped.length, skipped.join(', ')));
    }
    var l = layout(state, data);
    if (fileDates.some(function (d, i) { return (d || '') !== ((l.days[i] && l.days[i].date) || ''); })) {
      notes.push(t('The dates were changed so that each day follows on from the one before.'));
    }
    if (pace !== null && state.pace !== Math.round(pace * 10) / 10) notes.push(t('The walking pace was set back to the usual, because the file\'s pace is outside what this page offers.'));
    return { state: state, name: state.name, days: state.days.length, skipped: skipped, notes: notes };
  }

  // The plans in an itinerary file: one this page wrote, or a backup from the app (its other contents are ignored).
  // { ok: true, plans: [{ state, name, days, skipped, notes }] } or { ok: false, message }.
  function readFile(doc, data) {
    var errors = checkFile(doc);
    if (errors.length) {
      return { ok: false, message: errors[0] === 'Not a Camino backup file.' ? t('This is not a Camino itinerary or backup file.')
        : t('This file cannot be opened: {0}.', errors[0]) };
    }
    if (doc.source && typeof doc.source.guideFingerprint === 'string' && doc.source.guideFingerprint !== data.guide) {
      return { ok: false, message: t('This file was made for a different edition of the guide, so its days cannot be opened here.') };
    }
    var plans = doc.plans.filter(function (p) { return p.days.length; }).map(function (p) { return planFromFile(p, data); })
      .filter(function (p) { return p.days; });
    if (!plans.length) return { ok: false, message: t('There are no days in this file that this page can open.') };
    return { ok: true, plans: plans };
  }

  function fileName(state) {
    var slug = String(state.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'itinerary';
    return 'camino-itinerary-' + slug + '.json';
  }

  return {
    STATUSES: STATUSES, MAX_DAYS: MAX_DAYS, MODES: MODES, MAX_REF: MAX_REF, MAX_TRAVEL_NOTES: MAX_TRAVEL_NOTES,
    MAX_STAY_NOTES: MAX_STAY_NOTES, MAX_CONTACT: MAX_CONTACT,
    formatClock: formatClock, parseClock: parseClock, cleanMinutes: cleanMinutes, arrivesNextDay: arrivesNextDay,
    setRestPlace: setRestPlace, setStayDetails: setStayDetails,
    newState: newState, clean: clean, layout: layout, dayLabel: dayLabel, dayRef: dayRef, totals: totals,
    stageIds: stageIds, siblings: siblings, staysAt: staysAt, placeIdByName: placeIdByName,
    formatMetres: formatMetres, LONG_DAY_METRES: LONG_DAY_METRES, money: money, facilityNames: facilityNames, stayLine: stayLine, formatPhone: formatPhone, bookingLink: bookingLink, stayLinks: stayLinks,
    startFor: startFor, stageEnds: stageEnds, stayCount: stayCount, stageForChain: stageForChain, addRoute: addRoute,
    chainTotals: chainTotals, chainKey: chainKey, routePlaces: routePlaces, routesBetween: routesBetween, stopsFrom: stopsFrom,
    routeLabel: routeLabel, routeLabels: routeLabels, guideEnd: guideEnd, metresToEnd: metresToEnd,
    setDayRoute: setDayRoute, refitStart: refitStart, moveRest: moveRest, progress: progress, endBefore: endBefore, addCustom: addCustom, setCustomRoute: setCustomRoute,
    addStage: addStage, addRest: addRest, addTravel: addTravel, removeDay: removeDay, moveDay: moveDay,
    setStage: setStage, setTravel: setTravel, setStay: setStay, setStayStatus: setStayStatus, setMeta: setMeta, setDone: setDone,
    buildFile: buildFile, checkFile: checkFile, readFile: readFile, fileName: fileName,
    formatKm: formatKm, formatDuration: formatDuration, walkingSeconds: walkingSeconds, addDays: addDays, isIsoDate: isIsoDate
  };
});
