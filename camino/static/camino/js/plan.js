/* plan.js: the /plan/ page.
 *
 * Reads the guide data embedded in the page, keeps the visitor's itinerary in this browser
 * (localStorage) and builds the file the app restores. All the arithmetic and the file
 * format live in plan-core.js; this file only draws the page and reacts to clicks.
 * Nothing the visitor types leaves their device.
 */
(function () {
  'use strict';

  var Plan = window.CaminoPlan;
  var root = document.getElementById('plan-root');
  var dataElement = document.getElementById('plan-data');
  if (!Plan || !root || !dataElement) return;

  var data;
  try {
    data = JSON.parse(dataElement.textContent);
  } catch (error) {
    root.querySelector('.plan-fatal').hidden = false;
    return;
  }

  var STORAGE_KEY = 'camino-plan-v1';
  var KIND_LABELS = { valley: 'Low-valley route', mountain: 'Mountain route', alt: 'Alternative route' };
  var STAY_NAMES = { a: 'Albergue', p: 'Hotel or guesthouse', c: 'Your own choice' };

  var storageWorks = true;
  var ui = { startPlace: null, stayIndex: -1, insertAt: null, undo: null };
  var state = loadState();

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ saving

  function loadState() {
    var raw = null, notice = '';
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (error) { raw = null; }
    if (!raw || !raw.state) return Plan.newState(data);
    var saved = Plan.clean(raw.state, data);
    var before = Array.isArray(raw.state.days) ? raw.state.days.length : 0;
    if (saved.days.length < before) {
      notice = (before - saved.days.length) + ' saved day' + (before - saved.days.length === 1 ? ' was' : 's were') +
        ' dropped because that part of the guide no longer exists.';
    } else if (raw.guide && raw.guide !== data.guide) {
      notice = 'The guide has been updated since you saved this plan. Please check each day.';
    }
    ui.notice = notice;
    return saved;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ guide: data.guide, state: state }));
      storageWorks = true;
    } catch (error) {
      storageWorks = false;
    }
  }

  // ------------------------------------------------------------------ small DOM helpers

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      var value = attrs[name];
      if (value === null || value === undefined || value === false) return;
      if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value === true ? '' : value);
    });
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function button(label, act, extra) {
    var attrs = { type: 'button', 'class': 'plan-btn', 'data-act': act, text: label };
    Object.keys(extra || {}).forEach(function (name) { attrs[name] = extra[name]; });
    return el('button', attrs);
  }

  function chip(label, kind) { return el('span', { 'class': 'plan-chip plan-chip-' + kind, text: label }); }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function formatDate(iso) {
    try {
      return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
      });
    } catch (error) {
      return iso;
    }
  }

  function announce(message) { $('plan-live').textContent = message; }

  // ------------------------------------------------------------------ drawing the page

  function update(next, focusKey, message, undoText) {
    ui.undo = undoText ? { state: state, text: undoText } : null;
    state = next;
    ui.notice = '';
    saveState();
    render(focusKey);
    if (message) announce(message);
  }

  // A text edit on one day: patch the cards that depend on it in place, so the field the
  // visitor is typing in (or tabbing out of) keeps its focus.
  function edit(next, index) {
    state = next;
    ui.notice = '';
    ui.undo = null;
    renderUndo();
    saveState();
    var layout = Plan.layout(state, data), items = $('plan-days').children;
    for (var k = index; k < state.days.length; k += 1) {
      if (items[k]) patchCard(items[k], layout.days[k], k);
      if (k > index && state.days[k].type !== 'r') break;
    }
    renderNotice();
    renderSummary();
    renderAdd();
    renderSend();
  }

  function render(focusKey) {
    var keep = focusKey || (document.activeElement && document.activeElement.getAttribute &&
      document.activeElement.getAttribute('data-focus'));
    renderNotice();
    renderUndo();
    renderFields();
    renderSummary();
    renderDays();
    renderAdd();
    renderSend();
    if (keep) {
      var target = root.querySelector('[data-focus="' + keep + '"]');
      if (target && !target.disabled) target.focus();
    }
  }

  function renderNotice() {
    var messages = [];
    if (ui.notice) messages.push(ui.notice);
    if (!storageWorks) messages.push('This browser cannot save your plan, so it will be lost when you close the page. Download the file before you leave.');
    var box = $('plan-notice');
    box.textContent = messages.join(' ');
    box.hidden = !messages.length;
  }

  function renderUndo() {
    var box = $('plan-undo');
    box.hidden = !ui.undo;
    $('plan-undo-text').textContent = ui.undo ? ui.undo.text + ' ' : '';
  }

  function renderFields() {
    var name = $('plan-name'), start = $('plan-start'), pace = $('plan-pace');
    if (document.activeElement !== name) name.value = state.name;
    if (document.activeElement !== start) start.value = state.startDate;
    if (document.activeElement !== pace) pace.value = state.pace;
    $('plan-pace-out').textContent = state.pace.toFixed(1) + ' km/h';
    var hint = 'Your pace on the flat. The guide shows about ' + data.pace.default.toFixed(1) + ' km/h; slow down for hot weather, a heavy pack or sore feet.';
    $('plan-pace-hint').textContent = hint;
  }

  function stat(value, label) {
    return el('div', { 'class': 'plan-stat' }, [
      el('span', { 'class': 'plan-stat-value', text: value }),
      el('span', { 'class': 'plan-stat-label', text: label })
    ]);
  }

  function renderSummary() {
    var t = Plan.totals(state, data), box = $('plan-summary');
    box.innerHTML = '';
    if (!t.days) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.appendChild(stat(String(t.days), t.days === 1 ? 'day' : 'days'));
    box.appendChild(stat(String(t.walking), t.walking === 1 ? 'walking day' : 'walking days'));
    box.appendChild(stat(Plan.formatKm(t.metres), 'on foot'));
    box.appendChild(stat(Plan.formatDuration(t.seconds), 'walking time'));
    box.appendChild(stat(String(t.rest + t.travel), 'rest or travel'));
    box.appendChild(stat(t.stays + ' of ' + t.days, 'nights chosen'));
  }

  function dayTitle(info) {
    if (info.type === 's') return info.stage.name;
    if (info.type === 'r') return info.end ? 'Rest day in ' + info.end.name : 'Rest day';
    return 'Travel';
  }

  function fillNotes(container, info) {
    container.innerHTML = '';
    if (info.invalid) container.appendChild(el('p', { 'class': 'plan-error', role: 'alert', text: info.invalid }));
    if (info.warning) container.appendChild(el('p', { 'class': 'plan-warning', text: info.warning }));
  }

  function fillStay(container, info, day, i) {
    var no = i + 1;
    container.innerHTML = '';
    if (!info.end || info.invalid) return;
    if (day.stay) {
      var status = el('select', { 'class': 'plan-input plan-status', 'data-act': 'status', 'data-focus': 'day-' + i + '-status',
        'aria-label': 'Booking status for day ' + no });
      Plan.STATUSES.forEach(function (s) {
        status.appendChild(el('option', { value: s, selected: s === day.stay.status, text: s }));
      });
      container.appendChild(el('span', { 'class': 'plan-stay-label', text: 'Night ' + no + ':' }));
      container.appendChild(el('strong', { 'class': 'plan-stay-name', text: day.stay.name }));
      container.appendChild(status);
      container.appendChild(button('Change', 'stay', { 'data-focus': 'day-' + i + '-stay', 'aria-label': 'Change where to stay on day ' + no }));
      container.appendChild(button('Remove', 'stay-clear', { 'aria-label': 'Remove the stay on day ' + no }));
    } else {
      container.appendChild(button('Choose where to stay in ' + info.end.name, 'stay', { 'data-focus': 'day-' + i + '-stay', 'class': 'plan-btn plan-btn-quiet' }));
    }
  }

  function patchCard(item, info, i) {
    item.querySelector('.plan-day-title').textContent = dayTitle(info);
    fillNotes(item.querySelector('.plan-day-notes'), info);
    fillStay(item.querySelector('.plan-stay'), info, state.days[i], i);
  }

  function dayCard(info, i, count) {
    var day = state.days[i];
    var no = i + 1;
    var kindClass = info.type === 's' ? 'stage' : (info.type === 'r' ? 'rest' : 'travel');
    var head = el('div', { 'class': 'plan-day-head' }, [
      el('span', { 'class': 'plan-day-no', text: 'Day ' + no }),
      info.date ? el('span', { 'class': 'plan-day-date', text: formatDate(info.date) }) : null,
      info.type === 's' && KIND_LABELS[info.stage.kind] ? chip(KIND_LABELS[info.stage.kind], info.stage.kind) : null
    ]);
    var body = [head, el('h4', { 'class': 'plan-day-title', tabindex: '-1', 'data-focus': 'day-' + i + '-title', text: dayTitle(info) })];

    if (info.type === 's') {
      body.push(el('p', { 'class': 'plan-day-meta', text: Plan.formatKm(info.metres) + ' on foot, about ' + Plan.formatDuration(info.seconds) }));
    } else if (info.type === 't') {
      var from = el('input', { type: 'text', 'class': 'plan-input', list: 'plan-places', value: day.from, autocomplete: 'off',
        placeholder: 'Where from?', 'data-act': 'from', 'data-focus': 'day-' + i + '-from', maxlength: '100' });
      var to = el('input', { type: 'text', 'class': 'plan-input', list: 'plan-places', value: day.to, autocomplete: 'off',
        placeholder: 'Where to? e.g. Saint Jean Pied de Port', 'data-act': 'to', 'data-focus': 'day-' + i + '-to', maxlength: '100' });
      body.push(el('p', { 'class': 'plan-day-hint', text: 'Flight, train, bus or taxi. Start typing a town on the Camino to pick it from the list, or type any place.' }));
      body.push(el('div', { 'class': 'plan-travel' }, [
        el('label', {}, [el('span', { text: 'From' }), from]),
        el('label', {}, [el('span', { text: 'To' }), to])
      ]));
    }

    var notes = el('div', { 'class': 'plan-day-notes' });
    var stayRow = el('div', { 'class': 'plan-stay' });
    fillNotes(notes, info);
    fillStay(stayRow, info, day, i);
    body.push(notes);
    body.push(stayRow);

    var actions = el('div', { 'class': 'plan-day-actions' });
    if (info.type === 's') {
      var same = Plan.siblings(day.stage, data);
      if (same.length > 1) {
        var choose = el('select', { 'class': 'plan-input plan-route', 'data-act': 'route', 'data-focus': 'day-' + i + '-route',
          'aria-label': 'Choose the route for day ' + no });
        same.forEach(function (id) {
          var s = data.stages[id];
          choose.appendChild(el('option', { value: String(id), selected: id === day.stage,
            text: s.name + ' (' + Plan.formatKm(s.m) + ')' }));
        });
        actions.appendChild(choose);
      }
    }
    actions.appendChild(button('Move up', 'up', { 'data-focus': 'day-' + i + '-up', disabled: i === 0, 'aria-label': 'Move day ' + no + ' earlier' }));
    actions.appendChild(button('Move down', 'down', { 'data-focus': 'day-' + i + '-down', disabled: i === count - 1, 'aria-label': 'Move day ' + no + ' later' }));
    actions.appendChild(button('Add a day after', 'insert', { 'data-focus': 'day-' + i + '-insert', 'aria-label': 'Add a day after day ' + no }));
    actions.appendChild(button('Remove day', 'remove', { 'data-focus': 'day-' + i + '-remove', 'class': 'plan-btn plan-btn-danger', 'aria-label': 'Remove day ' + no }));
    body.push(actions);

    return el('li', { 'class': 'plan-day plan-day-' + kindClass, 'data-index': String(i) }, body);
  }

  function renderDays() {
    var list = $('plan-days'), layout = Plan.layout(state, data);
    list.innerHTML = '';
    layout.days.forEach(function (info, i) { list.appendChild(dayCard(info, i, layout.days.length)); });
    list.hidden = !layout.days.length;
  }

  function stageOption(id) {
    var s = data.stages[id];
    var seconds = Plan.walkingSeconds(s.w, state.pace, data.flat);
    var pieces = [
      el('span', { 'class': 'plan-option-name', text: s.name }),
      el('span', { 'class': 'plan-option-meta', text: Plan.formatKm(s.m) + ', about ' + Plan.formatDuration(seconds) })
    ];
    if (KIND_LABELS[s.kind]) pieces.push(chip(KIND_LABELS[s.kind], s.kind));
    return el('li', {}, [el('button', { type: 'button', 'class': 'plan-option', 'data-act': 'add-stage', 'data-stage': String(id),
      'data-focus': 'add-stage-' + id }, pieces)]);
  }

  function insertPoint() {
    var at = ui.insertAt;
    return (at === null || at >= state.days.length) ? null : at;
  }

  function renderAdd() {
    var count = state.days.length, at = insertPoint();
    var position = at === null ? count : at;           // number of days before the new one
    var next = Plan.nextOptions(state, data, at);
    var stages = next.stages, heading, lead = '';
    var atStart = position === 0;
    if (atStart && ui.startPlace) stages = Plan.stagesStartingAt(ui.startPlace, data);

    if (atStart) {
      heading = 'Day 1' + (count ? ' (new)' : '') + ': where does your walk begin?';
      lead = count ? 'This day will go at the start of your plan.'
        : 'Pick your first stage. If you arrive by plane or train first, add a travel day instead.';
    } else if (next.mode === 'finished') {
      heading = 'Day ' + (position + 1) + (at === null ? '' : ' (new)');
      lead = 'Your plan reaches ' + next.place.name + ', the end of the guide. You can still add a rest day or a journey home.';
    } else if (next.mode === 'elsewhere') {
      heading = 'Day ' + (position + 1) + (at === null ? '' : ' (new)');
      lead = 'The day before ends at ' + next.place.name + ', which is not in the guide. Add a travel day to reach the Camino, or pick a stage from the start.';
    } else if (next.mode === 'start') {
      heading = 'Day ' + (position + 1) + (at === null ? '' : ' (new)');
      lead = 'Finish the day above first, or pick a stage from the start of the guide.';
    } else {
      heading = 'Day ' + (position + 1) + (at === null ? '' : ' (new)') + ': from ' + next.place.name;
      lead = stages.length > 1 ? 'There is more than one way to go.' : '';
    }
    $('plan-add-title').textContent = heading;
    $('plan-add-lead').textContent = lead;
    $('plan-add-lead').hidden = !lead;

    // Where the new day goes
    var where = $('plan-add-where');
    where.innerHTML = '';
    where.appendChild(el('option', { value: 'end', text: 'At the end' }));
    if (count) where.appendChild(el('option', { value: '0', text: 'At the start' }));
    Plan.layout(state, data).days.forEach(function (info, i) {
      if (i < count - 1) where.appendChild(el('option', { value: String(i + 1), text: 'After day ' + (i + 1) + ': ' + shortTitle(info) }));
    });
    where.value = at === null ? 'end' : String(at);
    $('plan-add-where-row').hidden = count === 0;

    var picker = $('plan-start-picker');
    picker.hidden = !atStart;
    if (!picker.options.length) {
      Plan.startPlaces(data).forEach(function (p) {
        picker.appendChild(el('option', { value: String(p.id), text: p.name }));
      });
      picker.insertBefore(el('option', { value: '', text: 'The usual start' }), picker.firstChild);
    }
    if (atStart) picker.value = ui.startPlace ? String(ui.startPlace) : '';
    $('plan-start-picker-label').hidden = !atStart;

    var list = $('plan-next');
    list.innerHTML = '';
    stages.forEach(function (id) { list.appendChild(stageOption(id)); });
    list.hidden = !stages.length;
    $('plan-add-rest').disabled = atStart;

    // Any stage in the guide
    var any = $('plan-any-stage');
    if (!any.options.length) {
      Plan.stageIds(data).forEach(function (id) {
        var s = data.stages[id];
        any.appendChild(el('option', { value: String(id), text: s.name + ' (' + Plan.formatKm(s.m) + ')' }));
      });
    }
  }

  function shortTitle(info) {
    var t = dayTitle(info);
    return t.length > 38 ? t.slice(0, 36) + '…' : t;
  }

  function renderSend() {
    var l = Plan.layout(state, data), t = Plan.totals(state, data);
    var problem = '';
    if (!state.days.length) problem = 'Add at least one day to create the file.';
    else {
      var bad = l.days.filter(function (d) { return d.invalid; })[0];
      if (bad) problem = 'Day ' + (bad.index + 1) + ' needs attention: ' + bad.invalid;
    }
    $('plan-download').disabled = !!problem;
    var share = $('plan-share');
    share.hidden = !canShareFiles();
    share.disabled = !!problem;
    var msg = $('plan-send-problem');
    msg.textContent = problem;
    msg.hidden = !problem;
    msg.className = state.days.length ? 'plan-error' : 'plan-hint-box';
    var stays = t.stays;
    $('plan-send-count').textContent = state.days.length
      ? plural(t.days, 'day') + ', ' + plural(stays, 'stay') + ' chosen.'
      : '';
  }

  // ------------------------------------------------------------------ sending to the app

  function canShareFiles() {
    try {
      if (!navigator.share || !navigator.canShare || typeof File !== 'function') return false;
      return navigator.canShare({ files: [new File(['{}'], 'plan.json', { type: 'application/json' })] });
    } catch (error) {
      return false;
    }
  }

  function createdStamp() { return new Date().toISOString().replace('Z', '000Z'); }

  function makeFile() {
    var doc = Plan.buildFile(state, data, createdStamp());
    return { text: JSON.stringify(doc), name: Plan.fileName(state) };
  }

  function say(message, isError) {
    var box = $('plan-send-msg');
    box.textContent = message;
    box.className = 'plan-send-msg' + (isError ? ' plan-error' : '');
    box.hidden = !message;
  }

  function download() {
    var file;
    try { file = makeFile(); } catch (error) { say(error.message, true); return; }
    var blob = new Blob([file.text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: file.name });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    say('Saved ' + file.name + '. Now open it in the app (steps below).', false);
  }

  function share() {
    var file;
    try { file = makeFile(); } catch (error) { say(error.message, true); return; }
    var shared = new File([file.text], file.name, { type: 'application/json' });
    navigator.share({ files: [shared], title: state.name, text: 'Itinerary for the Saint Jean to Santiago app' })
      .then(function () { say('Shared. Open it in the app (steps below).', false); })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        say('Sharing did not work here. Use Download instead.', true);
      });
  }

  // ------------------------------------------------------------------ the stay chooser

  function stayItem(kind, id, name) {
    return el('li', {}, [el('button', { type: 'button', 'class': 'plan-pick', 'data-pick-kind': kind, 'data-pick-id': String(id), text: name })]);
  }

  function renderStayList() {
    var i = ui.stayIndex, layout = Plan.layout(state, data), info = layout.days[i];
    if (!info || !info.end) return;
    var query = $('plan-stay-search').value.trim().toLowerCase();
    var found = info.end.id > 0 ? Plan.staysAt(info.end.id, data) : { albergues: [], privates: [] };
    function match(s) { return !query || s.name.toLowerCase().indexOf(query) >= 0; }
    var albergues = found.albergues.filter(match), privates = found.privates.filter(match);
    var list = $('plan-stay-list');
    list.innerHTML = '';
    function group(title, items, kind) {
      if (!items.length) return;
      list.appendChild(el('li', { 'class': 'plan-pick-group', text: title }));
      items.forEach(function (s) { list.appendChild(stayItem(kind, s.id, s.name)); });
    }
    group('Albergues', albergues, 'a');
    group('Hotels and guesthouses', privates, 'p');
    var total = found.albergues.length + found.privates.length;
    $('plan-stay-empty').hidden = !!(albergues.length + privates.length);
    $('plan-stay-empty').textContent = total ? 'Nothing matches that. Try fewer letters.' : 'The guide has no places to stay listed for ' + info.end.name + '. Add your own below.';
    $('plan-stay-search-row').hidden = total < 8;
  }

  function openStay(index) {
    var layout = Plan.layout(state, data), info = layout.days[index];
    if (!info || !info.end) return;
    ui.stayIndex = index;
    var current = state.days[index].stay;
    $('plan-stay-title').textContent = 'Where will you stay in ' + info.end.name + '?';
    $('plan-stay-search').value = '';
    $('plan-stay-status').value = current ? current.status : 'Considering';
    $('plan-stay-own').value = current && current.k === 'c' ? current.name : '';
    renderStayList();
    var dialog = $('plan-stay-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }

  function chooseStay(stay) {
    var i = ui.stayIndex;
    closeDialog($('plan-stay-dialog'));
    if (i < 0) return;
    update(Plan.setStay(state, i, stay, data), 'day-' + i + '-stay', 'Stay chosen for day ' + (i + 1) + '.');
  }

  // ------------------------------------------------------------------ events

  $('plan-name').addEventListener('input', function (e) {
    state.name = e.target.value.slice(0, 80); // keep what is being typed; tidied when the field loses focus
    saveState();
  });
  $('plan-name').addEventListener('change', function (e) { update(Plan.setMeta(state, { name: e.target.value }, data)); });
  $('plan-start').addEventListener('change', function (e) { update(Plan.setMeta(state, { startDate: e.target.value }, data)); });
  $('plan-pace').addEventListener('input', function (e) {
    state = Plan.setMeta(state, { pace: e.target.value }, data);
    saveState();
    renderFields();
    renderSummary();
    renderDays();
    renderAdd();
  });

  $('plan-start-picker').addEventListener('change', function (e) {
    ui.startPlace = e.target.value ? Number(e.target.value) : null;
    renderAdd();
  });

  // Adds a day at the chosen place and moves to it: the end keeps offering the next stage,
  // an insertion in the middle shows the new day.
  function added(next, at, message) {
    var position = at === null ? next.days.length - 1 : at;
    ui.startPlace = null;
    ui.insertAt = null;
    var following = at === null ? Plan.nextOptions(next, data).stages : [];
    var focus = following.length ? 'add-stage-' + following[0] : (at === null ? 'add-rest' : 'day-' + position + '-title');
    update(next, focus, message + ' as day ' + (position + 1) + '.');
  }

  $('plan-add-where').addEventListener('change', function (e) {
    ui.insertAt = e.target.value === 'end' ? null : Number(e.target.value);
    ui.startPlace = null;
    renderAdd();
    $('plan-add-where').focus();
  });

  $('plan-add-rest').addEventListener('click', function () {
    var at = insertPoint();
    added(Plan.addRest(state, at), at, 'Rest day added');
  });
  $('plan-add-travel').addEventListener('click', function () {
    var at = insertPoint(), next = Plan.addTravel(state, data, at), i = at === null ? next.days.length - 1 : at;
    ui.insertAt = null;
    update(next, 'day-' + i + (next.days[i].from ? '-to' : '-from'), 'Travel day added as day ' + (i + 1) + '.');
  });
  $('plan-any-add').addEventListener('click', function () {
    var id = Number($('plan-any-stage').value), at = insertPoint();
    if (!data.stages[id]) return;
    added(Plan.addStage(state, id, at), at, 'Added ' + data.stages[id].name);
  });
  $('plan-undo-btn').addEventListener('click', function () {
    if (!ui.undo) return;
    var back = ui.undo.state;
    update(back, 'add-rest', 'Undone.');
  });

  $('plan-next').addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-act="add-stage"]') : null;
    if (!target) return;
    var id = Number(target.getAttribute('data-stage')), at = insertPoint();
    added(Plan.addStage(state, id, at), at, 'Added ' + data.stages[id].name);
  });

  function dayIndex(node) {
    var item = node.closest ? node.closest('.plan-day') : null;
    return item ? Number(item.getAttribute('data-index')) : -1;
  }

  $('plan-days').addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!target) return;
    var i = dayIndex(target), act = target.getAttribute('data-act');
    if (i < 0) return;
    if (act === 'up') update(Plan.moveDay(state, i, -1), i > 1 ? 'day-' + (i - 1) + '-up' : 'day-' + (i - 1) + '-down', 'Day moved earlier.');
    else if (act === 'down') update(Plan.moveDay(state, i, 1), i + 1 < state.days.length - 1 ? 'day-' + (i + 1) + '-down' : 'day-' + (i + 1) + '-up', 'Day moved later.');
    else if (act === 'insert') {
      ui.insertAt = i + 1;
      ui.startPlace = null;
      renderAdd();
      announce('Choose the day to add after day ' + (i + 1) + '.');
      $('plan-add-title').focus();
    } else if (act === 'remove') {
      var gone = dayTitle(Plan.layout(state, data).days[i]);
      update(Plan.removeDay(state, i), state.days.length > 1 ? 'day-' + Math.min(i, state.days.length - 2) + '-remove' : 'add-rest',
        'Day ' + (i + 1) + ' removed.', 'Removed day ' + (i + 1) + ' (' + gone + ').');
    }
    else if (act === 'stay') openStay(i);
    else if (act === 'stay-clear') update(Plan.setStay(state, i, null, data), 'day-' + i + '-stay', 'Stay removed.');
  });

  $('plan-days').addEventListener('change', function (e) {
    var target = e.target, act = target.getAttribute && target.getAttribute('data-act');
    if (!act) return;
    var i = dayIndex(target);
    if (i < 0) return;
    if (act === 'route') update(Plan.setStage(state, i, Number(target.value)), 'day-' + i + '-route', 'Route changed for day ' + (i + 1) + '.');
    else if (act === 'status') update(Plan.setStayStatus(state, i, target.value), 'day-' + i + '-status');
    else if (act === 'from') edit(Plan.setTravel(state, i, { from: target.value }), i);
    else if (act === 'to') edit(Plan.setTravel(state, i, { to: target.value }), i);
  });

  $('plan-stay-search').addEventListener('input', renderStayList);
  $('plan-stay-list').addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('button[data-pick-kind]') : null;
    if (!target) return;
    chooseStay({ k: target.getAttribute('data-pick-kind'), id: Number(target.getAttribute('data-pick-id')),
      name: target.textContent, status: $('plan-stay-status').value });
  });
  $('plan-stay-own-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('plan-stay-own').value.trim();
    if (!name) { $('plan-stay-own').focus(); return; }
    chooseStay({ k: 'c', id: 0, name: name, status: $('plan-stay-status').value });
  });
  $('plan-stay-close').addEventListener('click', function () { closeDialog($('plan-stay-dialog')); });
  $('plan-stay-dialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeDialog(e.currentTarget); });

  $('plan-download').addEventListener('click', download);
  $('plan-share').addEventListener('click', share);

  $('plan-reset').addEventListener('click', function () {
    var dialog = $('plan-reset-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  });
  $('plan-reset-cancel').addEventListener('click', function () { closeDialog($('plan-reset-dialog')); });
  $('plan-reset-confirm').addEventListener('click', function () {
    closeDialog($('plan-reset-dialog'));
    ui.startPlace = null;
    ui.insertAt = null;
    ui.notice = '';
    say('', false);
    update(Plan.newState(data), 'plan-name', 'Plan cleared.');
  });

  // ------------------------------------------------------------------ start

  var places = $('plan-places');
  Object.keys(data.places).map(function (id) { return data.places[id]; }).sort().forEach(function (name) {
    places.appendChild(el('option', { value: name }));
  });
  $('plan-pace').min = data.pace.min;
  $('plan-pace').max = data.pace.max;
  root.classList.add('plan-ready');
  render();
}());
