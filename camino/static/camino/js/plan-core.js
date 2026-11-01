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
      else if (d.t === 'c' && Array.isArray(d.paths) && chainTotals(d.paths.map(Number), data)) {
        state.days.push({ t: 'c', paths: d.paths.map(Number), stay: stay });
      } else if (d.t === 'r') state.days.push({ t: 'r', stay: stay });
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

  // ---------------------------------------------------------------- walking between any two places
  // The same rules as the app's WalkingDayPlanner: paths join where one ends and the next begins,
  // and a day adds every track point's distance except the first point of the day and the first
  // point of a path that starts another stage's track. The server works out each path's totals
  // and which joins are allowed (see camino/planner.py); this only adds them up.

  var graphs = typeof WeakMap === 'function' ? new WeakMap() : null;
  var MAX_STOP_METRES = 60000;

  function graph(data) {
    var g = graphs && graphs.get(data);
    if (g) return g;
    g = { byId: {}, out: {}, next: {}, order: {} };
    var routes = data.routes || { paths: [], next: {} };
    routes.paths.forEach(function (r) {
      var p = { id: r[0], o: r[1], d: r[2], stage: r[3], sd: r[4], sw: r[5], fd: r[6], fw: r[7], shape: r[8] };
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
    if (graphs) graphs.set(data, g);
    return g;
  }

  // Metres, weighted distance and end places of a chain of path ids, or null if it is not a
  // walkable chain (unknown path, paths that do not join, a path used twice).
  function chainTotals(chain, data) {
    var g = graph(data), m = 0, w = 0, seen = {};
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
    }
    return { metres: m, weighted: w, from: g.byId[chain[0]].o, to: g.byId[chain[chain.length - 1]].d };
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
    var g = graph(data);
    if (from === to || !(from in g.out)) return { routes: [], tooMany: false };
    var strict = search(from, to, data, true);
    if (strict.routes.length) return strict;
    return search(from, to, data, false);
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
      var offered = found.map(function (chain) { var t = chainTotals(chain, data); return { chain: chain, metres: t.metres, weighted: t.weighted }; })
        .sort(function (a, b) { return a.metres - b.metres; });
      if (!offered.length || offered[0].metres > limit) return;
      stops.push({ place: place, name: data.places[place], metres: offered[0].metres, weighted: offered[0].weighted,
        chain: offered[0].chain, routes: offered.map(function (o) { return o.chain; }) });
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
  var ROUTE_KIND_NAMES = { main: 'Main route', valley: 'Valley route', mountain: 'Mountain route', alt: 'Alternative route' };

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
        return (stage && ROUTE_KIND_NAMES[stage.kind]) || 'Standard route';
      }
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    });
    var distinct = short.every(function (text, i) { return short.indexOf(text) === i; });
    return distinct ? short : full;
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
      } else if (day.t === 'c') {
        var total = chainTotals(day.paths, data);
        if (!total) info.invalid = 'This part of the route is no longer in the guide. Remove the day and make it again.';
        else {
          info.start = { id: total.from, name: data.places[total.from] };
          info.end = { id: total.to, name: data.places[total.to] };
          info.metres = total.metres;
          info.seconds = walkingSeconds(total.weighted, state.pace, data.flat);
          if (here && here.id !== total.from) {
            info.warning = 'This day starts at ' + info.start.name + ', but the day before ended at ' + here.name + '.';
          }
        }
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
      if (info.type === 's' || info.type === 'c') {
        t.walking++;
        if (info.metres !== null) { t.metres += info.metres; t.seconds += info.seconds; }
      }
      else if (info.type === 'r') t.rest++;
      else t.travel++;
      if (state.days[i].stay) t.stays++;
    });
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
  function addCustom(state, chain, at) { return insertDay(state, at, { t: 'c', paths: chain.slice(), stay: null }); }
  // A day along this chain of paths: a guidebook stage when it is exactly one, otherwise the visitor's own.
  function addRoute(state, chain, data, at) {
    var sid = stageForChain(chain, data);
    return sid === null ? addCustom(state, chain, at) : addStage(state, sid, at);
  }
  function setCustomRoute(state, i, chain) {
    return withDays(state, function (d) { if (d[i] && d[i].t === 'c') d[i].paths = chain.slice(); });
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
        paths: day.t === 's' ? info.stage.paths : (day.t === 'c' ? day.paths : []), pace: state.pace, date: info.date,
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
    stageIds: stageIds, siblings: siblings, staysAt: staysAt, placeIdByName: placeIdByName,
    startFor: startFor, stageEnds: stageEnds, stayCount: stayCount, stageForChain: stageForChain, addRoute: addRoute,
    chainTotals: chainTotals, chainKey: chainKey, routePlaces: routePlaces, routesBetween: routesBetween, stopsFrom: stopsFrom,
    routeLabel: routeLabel, routeLabels: routeLabels, endBefore: endBefore, addCustom: addCustom, setCustomRoute: setCustomRoute,
    addStage: addStage, addRest: addRest, addTravel: addTravel, removeDay: removeDay, moveDay: moveDay,
    setStage: setStage, setTravel: setTravel, setStay: setStay, setStayStatus: setStayStatus, setMeta: setMeta,
    buildFile: buildFile, checkFile: checkFile, fileName: fileName,
    formatKm: formatKm, formatDuration: formatDuration, walkingSeconds: walkingSeconds, addDays: addDays, isIsoDate: isIsoDate
  };
});
