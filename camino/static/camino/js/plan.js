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
  var Share = window.CaminoShare;   // plan codes and QR codes: the page works without them
  var QR = window.CaminoQR;
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
  var ui = { fromPlace: null, stayIndex: -1, insertAt: null, editAt: null, restAt: null, undo: null, far: false, openStop: null, shared: null, openMore: {} };
  var MODE_LABELS = { flight: 'Flight', train: 'Train', bus: 'Bus', taxi: 'Taxi', ferry: 'Ferry', other: 'Other' };
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

  // How a day is named in a sentence: "day 3", or "day 3, part 2" when a day has more than one part.
  // Looked up in `st` (the plan as it will be, or as it is now) because the numbers depend on the plan.
  function ref(i, st) {
    var info = Plan.layout(st || state, data).days[i];
    return info ? Plan.dayRef(info) : 'day ' + (i + 1);
  }
  function cap(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  // ------------------------------------------------------------------ drawing the page

  function update(next, focusKey, message, undoText) {
    if (next.days.length !== state.days.length) ui.openMore = {};   // the numbers of the days have moved
    ui.undo = undoText ? { state: state, text: undoText } : null;
    ui.editAt = null;
    ui.restAt = null;
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
      if (k > index && state.days[k].t !== 'r') break;   // rest days follow the place; stop after the first walking day
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
    renderShared();
    renderFields();
    renderSummary();
    renderDays();
    renderAdd();
    renderSend();
    if (keep) {
      var target = keep === 'first-stop'
        ? (root.querySelector('#plan-stops .plan-stop') || $('plan-add-rest'))
        : root.querySelector('[data-focus="' + keep + '"]');
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

  // A plan that arrived by QR code or link: shown for the visitor to open or ignore, never opened on its own.
  function renderShared() {
    var box = $('plan-shared'), shared = ui.shared;
    box.hidden = !shared;
    if (!shared) return;
    var bad = !!shared.error;
    $('plan-shared-title').textContent = bad ? 'This plan code cannot be opened' : 'A plan has been shared with you';
    $('plan-shared-error').textContent = bad ? shared.error : '';
    $('plan-shared-error').hidden = !bad;
    $('plan-shared-name').hidden = bad;
    $('plan-shared-detail').hidden = bad;
    $('plan-shared-open').hidden = bad;
    $('plan-shared-keep').textContent = bad ? 'Close' : 'Keep my plan';
    var replace = $('plan-shared-replace');
    replace.hidden = true;
    if (bad) return;
    var other = shared.state, t = Plan.totals(other, data), p = Plan.progress(other, data);
    $('plan-shared-name').textContent = other.name;
    var detail = [];
    if (!t.days) detail.push('It has no days yet.');
    else {
      detail.push(plural(t.days, 'day') + (p.start && p.end ? ', from ' + p.start.name + ' to ' + p.end.name : '') +
        (other.startDate ? ', starting ' + formatDate(other.startDate) : '') + '.');
      detail.push(t.stays + ' of ' + plural(t.days, 'night') + ' chosen.');
    }
    $('plan-shared-detail').textContent = detail.join(' ');
    if (state.days.length) {
      replace.textContent = 'You already have a plan on this device (' + plural(Plan.totals(state, data).days, 'day') + '). ' +
        'Opening this one replaces it. You can undo that straight afterwards.';
      replace.hidden = false;
    }
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
    if (info.type === 'c') return info.start && info.end ? info.start.name + ' to ' + info.end.name : 'Walking day';
    var travel = state.days[info.index];
    return (travel && MODE_LABELS[travel.mode]) || 'Travel';
  }

  function fillNotes(container, info) {
    container.innerHTML = '';
    if (info.invalid) container.appendChild(el('p', { 'class': 'plan-error', role: 'alert', text: info.invalid }));
    if (info.warning) {
      var note = el('p', { 'class': 'plan-warning' }, [el('span', { text: info.warning })]);
      var fix = info.type === 's' || info.type === 'c' ? Plan.refitStart(state, info.index, data) : null;
      if (fix) {
        note.appendChild(button('Start this day from ' + fix.from.name, 'refit', {
          'class': 'plan-btn plan-btn-small', 'data-focus': 'day-' + info.index + '-refit',
          'aria-label': 'Start ' + Plan.dayRef(info) + ' from ' + fix.from.name }));
      }
      container.appendChild(note);
    }
  }

  function staySummary(stay) { return 'Booking reference and notes' + (stay.ref ? ': ' + stay.ref : ''); }

  // The booking reference (it goes in the file, the plan code and the link), and a contact and notes (the file only).
  function stayDetails(stay, i, name) {
    var key = 's' + i;
    return el('details', { 'class': 'plan-more plan-stay-more', 'data-more': key, open: ui.openMore[key] ? true : null }, [
      el('summary', { text: staySummary(stay) }),
      el('div', { 'class': 'plan-more-grid' }, [
        el('label', {}, [el('span', { text: 'Booking reference' }), el('input', { type: 'text', 'class': 'plan-input', 'data-act': 'sref',
          'data-focus': 'day-' + i + '-sref', maxlength: String(Plan.MAX_REF), autocomplete: 'off', value: stay.ref || '',
          'aria-label': 'Booking reference for ' + name })]),
        el('label', {}, [el('span', { text: 'Contact (phone or email)' }), el('input', { type: 'text', 'class': 'plan-input', 'data-act': 'scontact',
          maxlength: String(Plan.MAX_CONTACT), autocomplete: 'off', value: stay.contact || '', 'aria-label': 'Contact for the stay on ' + name })]),
        el('label', { 'class': 'plan-more-wide' }, [el('span', { text: 'Notes' }), el('textarea', { 'class': 'plan-input plan-textarea', 'data-act': 'snotes',
          rows: '2', maxlength: String(Plan.MAX_STAY_NOTES), 'aria-label': 'Notes for the stay on ' + name }, [stay.notes || ''])])
      ]),
      el('p', { 'class': 'plan-hint', text: 'The reference goes in the file and in the plan code and link, so anyone who has those can read it. The contact and notes go in the file only.' })
    ]);
  }

  // How a journey is made, when it leaves and arrives, and its reference and notes. All of it goes in the plan code.
  function travelMore(day, i, name) {
    var mode = el('select', { 'class': 'plan-input', 'data-act': 'tmode', 'data-focus': 'day-' + i + '-tmode', 'aria-label': 'How you travel on ' + name });
    mode.appendChild(el('option', { value: '', text: 'Not said' }));
    Plan.MODES.forEach(function (m) { mode.appendChild(el('option', { value: m, selected: day.mode === m, text: MODE_LABELS[m] })); });
    function time(act, value, label) {
      return el('input', { type: 'time', 'class': 'plan-input', 'data-act': act, value: Plan.formatClock(value), 'aria-label': label + ' on ' + name });
    }
    return el('div', { 'class': 'plan-travel-more' }, [
      el('div', { 'class': 'plan-more-grid' }, [
        el('label', {}, [el('span', { text: 'How' }), mode]),
        el('label', {}, [el('span', { text: 'Leaves' }), time('tdep', day.dep, 'Departure time')]),
        el('label', {}, [el('span', { text: 'Arrives' }), time('tarr', day.arr, 'Arrival time')]),
        el('label', {}, [el('span', { text: 'Ticket or booking reference' }), el('input', { type: 'text', 'class': 'plan-input', 'data-act': 'tref',
          maxlength: String(Plan.MAX_REF), autocomplete: 'off', value: day.ref || '', 'aria-label': 'Ticket reference for ' + name })]),
        el('label', { 'class': 'plan-more-wide' }, [el('span', { text: 'Notes' }), el('textarea', { 'class': 'plan-input plan-textarea', 'data-act': 'tnotes',
          rows: '2', maxlength: String(Plan.MAX_TRAVEL_NOTES), 'aria-label': 'Notes for ' + name }, [day.notes || ''])])
      ]),
      el('p', { 'class': 'plan-hint', text: 'These go in the plan code and the file. The phone app does not show them yet.' })
    ]);
  }

  function fillStay(container, info, day, i) {
    var name = Plan.dayRef(info);
    container.innerHTML = '';
    if (!info.end || info.invalid) return;
    if (day.stay) {
      var status = el('select', { 'class': 'plan-input plan-status', 'data-act': 'status', 'data-focus': 'day-' + i + '-status',
        'aria-label': 'Booking status for ' + name });
      Plan.STATUSES.forEach(function (s) {
        status.appendChild(el('option', { value: s, selected: s === day.stay.status, text: s }));
      });
      container.appendChild(el('span', { 'class': 'plan-stay-label', text: 'Night ' + info.no + ':' }));
      container.appendChild(el('strong', { 'class': 'plan-stay-name', text: day.stay.name }));
      container.appendChild(status);
      container.appendChild(button('Change', 'stay', { 'data-focus': 'day-' + i + '-stay', 'aria-label': 'Change where to stay on ' + name }));
      container.appendChild(button('Remove', 'stay-clear', { 'aria-label': 'Remove the stay on ' + name }));
      container.appendChild(stayDetails(day.stay, i, name));
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
    var name = Plan.dayRef(info);
    var walking = info.type === 's' || info.type === 'c';
    var kindClass = walking ? 'stage' : (info.type === 'r' ? 'rest' : 'travel');
    var head = el('div', { 'class': 'plan-day-head' }, [
      el('span', { 'class': 'plan-day-no', text: Plan.dayLabel(info) }),
      info.date ? el('span', { 'class': 'plan-day-date', text: formatDate(info.date) }) : null,
      info.type === 's' && KIND_LABELS[info.stage.kind] ? chip(KIND_LABELS[info.stage.kind], info.stage.kind) : null
    ]);
    var body = [head, el('h4', { 'class': 'plan-day-title', tabindex: '-1', 'data-focus': 'day-' + i + '-title', text: dayTitle(info) })];

    if (walking && info.metres !== null) {
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
      if (i > 0) {
        body.push(el('label', { 'class': 'plan-check' }, [
          el('input', { type: 'checkbox', 'data-act': 'same', 'data-focus': 'day-' + i + '-same', checked: day.same ? true : null }),
          el('span', { text: 'Same day as the day before (for example a bus after the walk)' })
        ]));
      }
      body.push(travelMore(day, i, name));
    } else if (info.type === 'r' && i === 0) {
      body.push(el('div', { 'class': 'plan-rest-at' }, [
        el('label', {}, [el('span', { text: 'Where will you rest?' }), el('input', { type: 'text', 'class': 'plan-input', list: 'plan-places',
          value: day.at || '', autocomplete: 'off', placeholder: 'For example Saint Jean Pied de Port', 'data-act': 'restat',
          'data-focus': 'day-0-restat', maxlength: '100' })]),
        el('p', { 'class': 'plan-day-hint', text: 'Nothing comes before the first day, so say where it is. Start typing a town on the Camino to pick it from the list, or type any place.' })
      ]));
    }

    var notes = el('div', { 'class': 'plan-day-notes' });
    var stayRow = el('div', { 'class': 'plan-stay' });
    fillNotes(notes, info);
    fillStay(stayRow, info, day, i);
    body.push(notes);
    body.push(stayRow);

    if (info.type === 'r' && ui.restAt === i && info.end && !info.invalid) {
      body.push(el('form', { 'class': 'plan-rest-move', novalidate: true }, [
        el('label', {}, [el('span', { text: 'Where will you rest?' }), el('input', {
          type: 'text', 'class': 'plan-input', name: 'place', list: 'plan-places', autocomplete: 'off', maxlength: '100',
          placeholder: 'For example Santiago', 'data-focus': 'day-' + i + '-restplace' })]),
        el('p', { 'class': 'plan-hint', text: 'If this is not ' + info.end.name + ', a journey from there is added before this rest day.' +
          (day.stay ? ' The place to stay you chose here is cleared.' : '') }),
        el('div', { 'class': 'plan-rest-move-actions' }, [
          el('button', { type: 'submit', 'class': 'plan-btn plan-btn-primary', text: 'Move the rest day' }),
          button('Cancel', 'restcancel', { 'data-focus': 'day-' + i + '-restcancel' })
        ])
      ]));
    }

    var actions = el('div', { 'class': 'plan-day-actions' });
    if (info.type === 's') {
      var same = Plan.siblings(day.stage, data);
      if (same.length > 1) {
        var choose = el('select', { 'class': 'plan-input plan-route', 'data-act': 'route', 'data-focus': 'day-' + i + '-route',
          'aria-label': 'Choose the route for ' + name });
        same.forEach(function (id) {
          var s = data.stages[id];
          choose.appendChild(el('option', { value: String(id), selected: id === day.stage,
            text: s.name + ' (' + Plan.formatKm(s.m) + ')' }));
        });
        actions.appendChild(choose);
      }
    }
    if (info.type === 'c' && info.start && info.end) {
      var found = Plan.routesBetween(info.start.id, info.end.id, data).routes;
      if (found.length > 1) {
        var mine = Plan.chainKey(day.paths, data);
        var pick = el('select', { 'class': 'plan-input plan-route', 'data-act': 'croute', 'data-focus': 'day-' + i + '-route',
          'aria-label': 'Choose the route for ' + name });
        var foundLabels = Plan.routeLabels(found, data);
        found.forEach(function (chain, n) {
          var t = Plan.chainTotals(chain, data);
          pick.appendChild(el('option', { value: chain.join(','), selected: Plan.chainKey(chain, data) === mine,
            text: (foundLabels[n] || info.end.name) + ' (' + Plan.formatKm(t.metres) + ')' }));
        });
        actions.appendChild(pick);
      }
    }
    if (walking && info.start && info.end && !info.invalid) {
      actions.appendChild(button('Change where it ends', 'reend', { 'data-focus': 'day-' + i + '-reend', 'aria-label': 'Change where ' + name + ' ends' }));
    }
    if (info.type === 'r' && info.end && !info.invalid && i > 0) {
      actions.appendChild(button('Rest somewhere else', 'restmove', { 'data-focus': 'day-' + i + '-restmove', 'aria-label': 'Rest somewhere else on ' + name }));
    }
    actions.appendChild(button('Move up', 'up', { 'data-focus': 'day-' + i + '-up', disabled: i === 0, 'aria-label': 'Move ' + name + ' earlier' }));
    actions.appendChild(button('Move down', 'down', { 'data-focus': 'day-' + i + '-down', disabled: i === count - 1, 'aria-label': 'Move ' + name + ' later' }));
    actions.appendChild(button('Add a day after', 'insert', { 'data-focus': 'day-' + i + '-insert', 'aria-label': 'Add a day after day ' + info.no }));
    actions.appendChild(button('Remove day', 'remove', { 'data-focus': 'day-' + i + '-remove', 'class': 'plan-btn plan-btn-danger', 'aria-label': 'Remove ' + name }));
    body.push(actions);

    return el('li', { 'class': 'plan-day plan-day-' + kindClass + (ui.editAt === i ? ' plan-day-editing' : ''), 'data-index': String(i) }, body);
  }

  function renderDays() {
    var list = $('plan-days'), layout = Plan.layout(state, data);
    list.innerHTML = '';
    layout.days.forEach(function (info, i) { list.appendChild(dayCard(info, i, layout.days.length)); });
    list.hidden = !layout.days.length;
  }

  function stopRow(stop, start, ends, current) {
    var routes = stop.routes;
    var seconds = Plan.walkingSeconds(stop.weighted, state.pace, data.flat);
    var stays = Plan.stayCount(stop.place, data);
    var open = ui.openStop === stop.place && routes.length > 1;
    var tags = [];
    if (current === stop.place) tags.push(chip('Where it ends now', 'alt'));
    if (ends[stop.place]) tags.push(chip('Guidebook stage end', 'stage'));
    if (routes.length > 1) tags.push(chip(routes.length + ' routes', 'alt'));
    var meta = Plan.formatKm(stop.metres) + ', about ' + Plan.formatDuration(seconds) + (stays ? ', ' + plural(stays, 'place') + ' to stay' : '');
    var item = el('li', { 'class': 'plan-stop-item' }, [el('button', {
      type: 'button', 'class': 'plan-stop', 'data-act': 'stop', 'data-place': String(stop.place),
      'aria-expanded': routes.length > 1 ? String(open) : null
    }, [
      el('span', { 'class': 'plan-stop-name', text: stop.name }),
      el('span', { 'class': 'plan-stop-meta', text: meta }),
      tags.length ? el('span', { 'class': 'plan-stop-tags' }, tags) : null
    ])]);
    if (open) {
      var sub = el('ul', { 'class': 'plan-stop-routes', 'aria-label': 'Routes to ' + stop.name });
      var labels = Plan.routeLabels(routes, data);
      routes.forEach(function (chain, n) {
        var t = Plan.chainTotals(chain, data);
        var time = Plan.formatDuration(Plan.walkingSeconds(t.weighted, state.pace, data.flat));
        sub.appendChild(el('li', {}, [el('button', { type: 'button', 'class': 'plan-option', 'data-act': 'stop-route', 'data-chain': chain.join(',') }, [
          el('span', { 'class': 'plan-option-name', text: labels[n] || stop.name }),
          el('span', { 'class': 'plan-option-meta', text: Plan.formatKm(t.metres) + ', about ' + time })
        ])]));
      });
      item.appendChild(sub);
    }
    return item;
  }

  // Where a new day goes: null for the end. Never between a day and the journey on the same date
  // (day 3, part 1 and part 2), which would move that journey on to the new day.
  function insertPoint() {
    var at = ui.insertAt;
    if (at === null) return null;
    while (at < state.days.length && at > 0 && state.days[at].t === 't' && state.days[at].same) at += 1;
    return at >= state.days.length ? null : at;
  }

  function shortTitle(info) {
    var t = dayTitle(info);
    return t.length > 38 ? t.slice(0, 36) + '…' : t;
  }

  // The day being changed, if the visitor is changing where one ends.
  function editingIndex() {
    var i = ui.editAt;
    if (i === null || i < 0 || i >= state.days.length) return null;
    var info = Plan.layout(state, data).days[i];
    return (info.type === 's' || info.type === 'c') && info.start && info.end && !info.invalid ? i : null;
  }

  // Where the day being added, or changed, starts.
  function addStart() {
    var i = editingIndex();
    if (i === null) return Plan.startFor(state, data, insertPoint(), ui.fromPlace);
    var info = Plan.layout(state, data).days[i];
    return { id: info.start.id, name: info.start.name, fixed: true, previous: null };
  }

  function renderAdd() {
    var count = state.days.length, editing = editingIndex(), at = editing === null ? insertPoint() : null;
    var position = editing !== null ? editing : (at === null ? count : at);   // number of days before the new one
    var start = addStart();
    var current = null, editInfo = null;
    // The plan already reaches the end of the guide: there is nowhere further to walk.
    var finished = editing === null && !start.fixed && !!start.previous && start.previous.id === Plan.guideEnd(data);
    if (editing !== null) {
      editInfo = Plan.layout(state, data).days[editing];
      current = editInfo.end.id;
    }
    var allDays = Plan.layout(state, data).days;
    $('plan-add-title').textContent = editing !== null ? 'Change ' + Plan.dayRef(editInfo)
      : 'Day ' + (position > 0 ? allDays[position - 1].no + 1 : 1) + (at === null ? '' : ' (new)');

    var lead = '';
    if (editing !== null) {
      lead = cap(Plan.dayRef(editInfo)) + ' is ' + dayTitle(editInfo) + '. Choose where it should end instead.' +
        (state.days[editing].stay ? ' If you pick a different place, the place to stay you chose is cleared.' : '');
    } else if (finished) {
      lead = 'Your plan reaches ' + start.previous.name + ', the end of the guide. Add a rest day or a journey home, or send the plan below.';
    } else if (!start.fixed && !start.previous) {
      lead = position === 0 && count
        ? 'This day will go at the start of your plan.'
        : 'Choose where your walk begins, then where you stop on this first day. If you arrive by plane or train first, add a travel day instead; to begin with a rest day, add one below.';
    } else if (!start.fixed) {
      lead = 'The day before ends at ' + start.previous.name + ', which is not on the route. Choose where this day starts, or add a travel day to get there.';
    }
    $('plan-add-lead').textContent = lead;
    $('plan-add-lead').hidden = !lead;
    $('plan-edit-row').hidden = editing === null;
    $('plan-add-other').hidden = editing !== null;
    $('plan-any').hidden = editing !== null;

    // Where the new day goes
    var where = $('plan-add-where');
    where.innerHTML = '';
    where.appendChild(el('option', { value: 'end', text: 'At the end' }));
    if (count) where.appendChild(el('option', { value: '0', text: 'At the start' }));
    allDays.forEach(function (info, i) {
      // a day can only be added after the last part of a day, not between its parts
      if (i < count - 1 && !allDays[i + 1].same) where.appendChild(el('option', { value: String(i + 1), text: 'After ' + Plan.dayRef(info) + ': ' + shortTitle(info) }));
    });
    where.value = at === null ? 'end' : String(at);
    $('plan-add-where-row').hidden = count === 0 || editing !== null;

    // Where the day starts, when it does not simply continue from the day before
    var from = $('plan-from');
    from.innerHTML = '';
    if (!start.fixed) {
      Plan.routePlaces(data).forEach(function (p) { from.appendChild(el('option', { value: String(p.id), text: p.name })); });
      from.value = String(start.id);
    }
    $('plan-from-row').hidden = start.fixed || finished;   // always fixed while a day is being changed

    // Places to stop
    var ends = Plan.stageEnds(data), list = $('plan-stops'), empty = $('plan-stops-empty');
    list.innerHTML = '';
    $('plan-stops-title').hidden = finished;
    if (finished) {
      empty.hidden = true;
      $('plan-stops-more').hidden = true;
    } else {
      var all = Plan.stopsFrom(start.id, data, 60000);
      var stops = ui.far ? all : all.filter(function (s) { return s.metres <= 40000 || s.place === current; });
      stops.forEach(function (stop) { list.appendChild(stopRow(stop, start, ends, current)); });
      $('plan-stops-title').textContent = 'From ' + start.name + (editing !== null ? ': where should it end?' : ': where will you stop?');
      if (!all.length) empty.textContent = 'There is nowhere further along the route from ' + start.name + '. You can still add a rest day or a journey.';
      else if (!stops.length) empty.textContent = 'There is no town within 40 km of ' + start.name + '.';
      empty.hidden = !!stops.length;
      $('plan-stops-more').hidden = ui.far || all.length === stops.length;
    }
    $('plan-add-travel-same').disabled = position === 0;

    // Any stage in the guide
    var any = $('plan-any-stage');
    if (!any.options.length) {
      Plan.stageIds(data).forEach(function (id) {
        var s = data.stages[id];
        any.appendChild(el('option', { value: String(id), text: s.name + ' (' + Plan.formatKm(s.m) + ')' }));
      });
    }
  }

  function renderSend() {
    var l = Plan.layout(state, data), t = Plan.totals(state, data);
    var problem = '';
    if (!state.days.length) problem = 'Add at least one day to create the file.';
    else {
      var bad = l.days.filter(function (d) { return d.invalid; })[0];
      if (bad) problem = cap(Plan.dayRef(bad)) + ' needs attention: ' + bad.invalid;
    }
    $('plan-download').disabled = !!problem;
    var qrButton = $('plan-qr-open');
    qrButton.hidden = !(Share && QR);
    qrButton.disabled = !!problem;          // a code, like the file, waits until every day can be built
    var share = $('plan-share');
    share.hidden = !canShareFiles();
    share.disabled = !!problem;
    var msg = $('plan-send-problem');
    msg.textContent = problem;
    msg.hidden = !problem;
    msg.className = state.days.length ? 'plan-error' : 'plan-hint-box';
    var hasPrivate = state.days.some(function (d) { return (d.stay && d.stay.ref) || d.ref || d.notes; });
    $('plan-send-private').hidden = !hasPrivate;
    var stays = t.stays;
    $('plan-send-count').textContent = state.days.length
      ? plural(t.days, 'day') + ', ' + plural(stays, 'stay') + ' chosen.'
      : '';

    // Where the plan goes, and anything to check before it is sent
    var p = Plan.progress(state, data), route = $('plan-send-route'), warn = $('plan-send-warn');
    if (!p.start || !p.end) {
      route.hidden = true;
      warn.hidden = true;
      return;
    }
    var goal = data.places[Plan.guideEnd(data)] || 'the end of the guide';
    var line = 'From ' + p.start.name + ' to ' + p.end.name + ', ' + Plan.formatKm(p.metres) + ' on foot.';
    if (p.reachesEnd) line += ' It reaches ' + goal + '.';
    else if (p.remaining !== null) line += ' It stops about ' + Plan.formatKm(p.remaining) + ' short of ' + goal + '. Keep adding days above, or send it as it is.';
    route.textContent = line;
    route.className = 'plan-send-route' + (p.reachesEnd ? ' plan-send-done' : '');
    route.hidden = false;
    var n = p.warnings.length;
    if (n) {
      var plain = p.warnings.every(function (i) { return l.days[i].parts === 1; });
      var names = p.warnings.map(function (i) { return plain ? String(l.days[i].no) : Plan.dayRef(l.days[i]); });
      var list = n === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[n - 1];
      warn.textContent = (plain ? (n === 1 ? 'Day ' : 'Days ') + list : cap(list)) + (n === 1 ? ' does not start' : ' do not start') +
        ' where the day before ended. You can still send the plan, but check ' + (n === 1 ? 'it' : 'them') + ' first.';
    }
    warn.hidden = !n;
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

  // ------------------------------------------------------------------ sharing by QR code or link

  var shown = { url: '', image: null };

  function pageUrl() { return location.origin + location.pathname; }

  function qrSay(message, isError) {
    var box = $('plan-qr-msg');
    box.textContent = message;
    box.className = 'plan-send-msg' + (isError ? ' plan-error' : '');
    box.hidden = !message;
  }

  // Shows the plan as it is now as a code and a link. A plan too big for a QR code still gets its link.
  function openQr() {
    if (!Share || !QR || !state.days.length) return;
    var error = '', hint = '', code = null;
    shown = { url: '', image: null };
    try { code = Share.encode(state, data); } catch (problem) { error = 'This plan cannot be turned into a code.'; }
    if (code) {
      shown.url = Share.toUrl(pageUrl(), code.text);
      shown.image = QR.encode(shown.url, { levels: ['M', 'L'] });
      if (!shown.image) error = 'This plan is too big for a QR code. You can still copy the link, or send the file.';
      else if (shown.image.version > 25) hint = 'This code is dense, because the plan carries a lot of text (places typed in by hand, booking references or notes). If a phone has trouble reading it, send the link or the file instead.';
      if (code.notes.length) hint = (hint ? hint + ' ' : '') + code.notes.join(' ');
    }
    var image = $('plan-qr-img');
    if (shown.image) {
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(QR.toSvg(shown.image));
      image.alt = 'QR code for the plan ' + state.name;
    } else {
      image.removeAttribute('src');
      image.alt = '';
    }
    $('plan-qr-frame').hidden = !shown.image;
    $('plan-qr-error').textContent = error;
    $('plan-qr-error').hidden = !error;
    $('plan-qr-hint').textContent = hint;
    $('plan-qr-hint').hidden = !hint;
    $('plan-qr-link').value = shown.url;
    $('plan-qr-copy').disabled = !shown.url;
    $('plan-qr-png').disabled = !shown.image;
    qrSay('', false);
    var dialog = $('plan-qr-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  function copyLink() {
    var field = $('plan-qr-link');
    function selectIt() { field.focus(); field.select(); qrSay('Select the link and copy it.', false); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shown.url).then(function () { qrSay('Link copied.', false); }, selectIt);
        return;
      }
    } catch (error) { /* fall through */ }
    selectIt();
  }

  function saveQrPicture() {
    if (!shown.image) return;
    var canvas = document.createElement('canvas');
    QR.toCanvas(shown.image, canvas, 8, 4);
    canvas.toBlob(function (blob) {
      if (!blob) { qrSay('The picture could not be made here.', true); return; }
      var name = Plan.fileName(state).replace(/\.json$/, '-qr.png');
      var url = URL.createObjectURL(blob);
      var link = el('a', { href: url, download: name });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      qrSay('Saved ' + name + '.', false);
    }, 'image/png');
  }

  // A plan code in the address (a scanned QR code, or a link): decoded and offered, never opened on its own.
  function readLink() {
    if (!Share) return false;
    var code = Share.fromUrl(location.hash);
    if (code === null) return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (error) { /* it stays in the address bar */ }
    var result = Share.decode(code, data);
    ui.shared = result.ok ? { state: result.state } : { error: result.message };
    return true;
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
    var old = state.days[i].stay;
    if (old && old.k === stay.k && old.id === stay.id && old.name === stay.name) {   // the same place again: its details stay
      ['ref', 'notes', 'contact'].forEach(function (key) { if (old[key]) stay[key] = old[key]; });
    }
    update(Plan.setStay(state, i, stay, data), 'day-' + i + '-stay', 'Stay chosen for ' + ref(i) + '.');
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

  // Adds a day at the chosen place and moves on: at the end, to the next list of places;
  // in the middle, to the new day.
  function added(next, at, message) {
    var position = at === null ? next.days.length - 1 : at;
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    update(next, at === null ? 'first-stop' : 'day-' + position + '-title', message + ' as ' + ref(position, next) + '.');
  }

  function addChain(chain) {
    var at = insertPoint(), t = Plan.chainTotals(chain, data);
    added(Plan.addRoute(state, chain, data, at), at, 'Added ' + data.places[t.from] + ' to ' + data.places[t.to]);
  }

  // Changes where the day being edited ends. Its place to stay goes unless the place is the same.
  function changeChain(chain) {
    var i = editingIndex(), t = Plan.chainTotals(chain, data);
    if (i === null || !t) return;
    var next = Plan.setDayRoute(state, i, chain, data);
    var lost = !!state.days[i].stay && !next.days[i].stay;
    var message = cap(ref(i, next)) + ' now ends at ' + data.places[t.to] + '.';
    var after = Plan.layout(next, data).days[i + 1];
    ui.openStop = null;
    ui.far = false;
    update(next, 'day-' + i + '-title',
      message + (lost ? ' Its place to stay was cleared.' : '') +
      (after && after.warning ? ' ' + cap(ref(i + 1, next)) + ' no longer starts where this one ends.' : ''),
      message + (lost ? ' Its place to stay was cleared.' : ''));
  }

  function pickChain(chain) {
    if (editingIndex() !== null) changeChain(chain); else addChain(chain);
  }

  function closeEdit(focusKey) {
    ui.editAt = null;
    ui.openStop = null;
    ui.far = false;
    renderDays();
    renderAdd();
    var target = focusKey && root.querySelector('[data-focus="' + focusKey + '"]');
    if (target) target.focus();
  }

  $('plan-edit-cancel').addEventListener('click', function () {
    var i = ui.editAt;
    announce('Change cancelled.');
    closeEdit(i === null ? null : 'day-' + i + '-reend');
  });

  $('plan-add-where').addEventListener('change', function (e) {
    ui.editAt = null;
    ui.insertAt = e.target.value === 'end' ? null : Number(e.target.value);
    ui.fromPlace = null;
    ui.openStop = null;
    renderAdd();
    $('plan-add-where').focus();
  });

  $('plan-from').addEventListener('change', function (e) {
    ui.fromPlace = Number(e.target.value);
    ui.openStop = null;
    renderAdd();
    $('plan-from').focus();
  });

  $('plan-stops-more').addEventListener('click', function () {
    ui.far = true;
    renderAdd();
    $('plan-stops-title').focus();
  });

  $('plan-stops').addEventListener('click', function (e) {
    var routeButton = e.target.closest ? e.target.closest('[data-act="stop-route"]') : null;
    if (routeButton) {
      pickChain(routeButton.getAttribute('data-chain').split(',').map(Number));
      return;
    }
    var stopButton = e.target.closest ? e.target.closest('[data-act="stop"]') : null;
    if (!stopButton) return;
    var place = Number(stopButton.getAttribute('data-place'));
    var start = addStart();
    var routes = Plan.routesBetween(start.id, place, data).routes;
    if (routes.length === 1) pickChain(routes[0]);
    else if (routes.length > 1) {
      ui.openStop = ui.openStop === place ? null : place;
      renderAdd();
      var again = $('plan-stops').querySelector('[data-place="' + place + '"]');
      if (again) again.focus();
    }
  });

  $('plan-add-rest').addEventListener('click', function () {
    var at = insertPoint(), position = at === null ? state.days.length : at, next = Plan.addRest(state, at);
    if (position === 0) {               // the first day has no day before it, so it asks where it is
      ui.fromPlace = null;
      ui.insertAt = null;
      ui.openStop = null;
      ui.far = false;
      update(next, 'day-0-restat', 'Rest day added as day 1. Say where you will rest.');
      return;
    }
    added(next, at, 'Rest day added');
  });
  function addJourney(same) {
    var at = insertPoint(), next = Plan.addTravel(state, data, at, same), i = at === null ? next.days.length - 1 : at;
    ui.insertAt = null;
    update(next, 'day-' + i + (next.days[i].from ? '-to' : '-from'),
      (same ? 'Journey added as ' : 'Travel day added as ') + ref(i, next) + '.');
  }
  $('plan-add-travel').addEventListener('click', function () { addJourney(false); });
  $('plan-add-travel-same').addEventListener('click', function () { addJourney(true); });
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

  function dayIndex(node) {
    var item = node.closest ? node.closest('.plan-day') : null;
    return item ? Number(item.getAttribute('data-index')) : -1;
  }

  $('plan-days').addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!target) return;
    var i = dayIndex(target), act = target.getAttribute('data-act');
    if (i < 0) return;
    if (act === 'up' || act === 'down') ui.openMore = {};
    if (act === 'up') update(Plan.moveDay(state, i, -1), i > 1 ? 'day-' + (i - 1) + '-up' : 'day-' + (i - 1) + '-down', 'Day moved earlier.');
    else if (act === 'down') update(Plan.moveDay(state, i, 1), i + 1 < state.days.length - 1 ? 'day-' + (i + 1) + '-down' : 'day-' + (i + 1) + '-up', 'Day moved later.');
    else if (act === 'reend') {
      ui.editAt = i;
      ui.insertAt = null;
      ui.fromPlace = null;
      ui.openStop = null;
      ui.far = false;
      renderDays();
      renderAdd();
      announce('Choose where ' + ref(i) + ' should end instead.');
      $('plan-add-title').focus();
    } else if (act === 'restmove') {
      ui.restAt = i;
      renderDays();
      var field = root.querySelector('[data-focus="day-' + i + '-restplace"]');
      if (field) field.focus();
    } else if (act === 'restcancel') {
      ui.restAt = null;
      renderDays();
      var back = root.querySelector('[data-focus="day-' + i + '-restmove"]');
      if (back) back.focus();
    } else if (act === 'refit') {
      var fix = Plan.refitStart(state, i, data);
      if (!fix) return;
      var said = cap(ref(i)) + ' now starts from ' + fix.from.name + '.';
      update(fix.state, 'day-' + i + '-title', said, said);
    } else if (act === 'insert') {
      ui.editAt = null;
      ui.insertAt = i + 1;
      ui.fromPlace = null;
      ui.openStop = null;
      renderAdd();
      announce('Choose the day to add after ' + ref((insertPoint() === null ? state.days.length : insertPoint()) - 1) + '.');
      $('plan-add-title').focus();
    } else if (act === 'remove') {
      var gone = dayTitle(Plan.layout(state, data).days[i]);
      update(Plan.removeDay(state, i), state.days.length > 1 ? 'day-' + Math.min(i, state.days.length - 2) + '-remove' : 'add-rest',
        cap(ref(i)) + ' removed.', 'Removed ' + ref(i) + ' (' + gone + ').');
    }
    else if (act === 'stay') openStay(i);
    else if (act === 'stay-clear') update(Plan.setStay(state, i, null, data), 'day-' + i + '-stay', 'Stay removed.');
  });

  $('plan-days').addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.classList || !form.classList.contains('plan-rest-move')) return;
    e.preventDefault();
    var i = dayIndex(form), input = form.querySelector('input[name="place"]'), place = input.value.trim();
    if (i < 0) return;
    if (!place) { announce('Type where you will rest.'); input.focus(); return; }
    if (state.days.length >= Plan.MAX_DAYS) { announce('The plan is full.'); return; }
    var next = Plan.moveRest(state, i, place, data);
    if (next === state) {
      ui.restAt = null;
      renderDays();
      announce(cap(ref(i)) + ' is already ' + place + '.');
      var again = root.querySelector('[data-focus="day-' + i + '-restmove"]');
      if (again) again.focus();
      return;
    }
    var where = next.days[i].to;
    update(next, 'day-' + (i + 1) + '-title', 'Rest day moved to ' + where + '. A journey was added as ' + ref(i, next) + '.',
      'Rest day moved to ' + where + ' (journey added as ' + ref(i, next) + ').');
  });

  $('plan-days').addEventListener('change', function (e) {
    var target = e.target, act = target.getAttribute && target.getAttribute('data-act');
    if (!act) return;
    var i = dayIndex(target);
    if (i < 0) return;
    if (act === 'route') update(Plan.setStage(state, i, Number(target.value)), 'day-' + i + '-route', 'Route changed for ' + ref(i) + '.');
    else if (act === 'croute') update(Plan.setCustomRoute(state, i, target.value.split(',').map(Number)), 'day-' + i + '-route', 'Route changed for ' + ref(i) + '.');
    else if (act === 'status') update(Plan.setStayStatus(state, i, target.value), 'day-' + i + '-status');
    else if (act === 'same') {
      var split = Plan.setTravel(state, i, { same: target.checked });
      update(split, 'day-' + i + '-same',
        cap(ref(i, split)) + (target.checked ? ' is now on the same date as the part before it.' : ' now has a day of its own.'));
    }
    else if (act === 'from') edit(Plan.setTravel(state, i, { from: target.value }), i);
    else if (act === 'to') edit(Plan.setTravel(state, i, { to: target.value }), i);
    else if (act === 'restat') edit(Plan.setRestPlace(state, i, target.value), i);
    else if (act === 'sref' || act === 'scontact' || act === 'snotes') {
      // nothing else on the page depends on these, so the cards are left alone and the field keeps its focus
      var patch = {}, field = act === 'sref' ? 'ref' : (act === 'scontact' ? 'contact' : 'notes');
      patch[field] = target.value;
      state = Plan.setStayDetails(state, i, patch);
      saveState();
      var kept = state.days[i].stay;
      if (kept) target.value = kept[field] || '';
      var summary = target.closest('details') && target.closest('details').querySelector('summary');
      if (summary && kept) summary.textContent = staySummary(kept);
      renderSend();
    } else if (act === 'tmode' || act === 'tdep' || act === 'tarr' || act === 'tref' || act === 'tnotes') {
      var change = {}, minutes = act === 'tdep' || act === 'tarr' ? Plan.parseClock(target.value) : null;
      if (act === 'tmode') change.mode = target.value;
      else if (act === 'tdep') change.dep = minutes;
      else if (act === 'tarr') change.arr = minutes;
      else if (act === 'tref') change.ref = target.value;
      else change.notes = target.value;
      state = Plan.setTravel(state, i, change);
      saveState();
      var now = state.days[i];
      if (act === 'tdep') target.value = Plan.formatClock(now.dep);
      else if (act === 'tarr') target.value = Plan.formatClock(now.arr);
      else if (act === 'tref') target.value = now.ref || '';
      else if (act === 'tnotes') target.value = now.notes || '';
      var heading = target.closest('.plan-day').querySelector('.plan-day-title');
      heading.textContent = dayTitle(Plan.layout(state, data).days[i]);
      renderSend();
    }
  });

  // Which detail panels are open, kept across redraws.
  $('plan-days').addEventListener('toggle', function (e) {
    var box = e.target, key = box && box.getAttribute && box.getAttribute('data-more');
    if (!key) return;
    if (box.open) ui.openMore[key] = true; else delete ui.openMore[key];
  }, true);

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
  $('plan-qr-open').addEventListener('click', openQr);
  $('plan-qr-close').addEventListener('click', function () { closeDialog($('plan-qr-dialog')); });
  $('plan-qr-dialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeDialog(e.currentTarget); });
  $('plan-qr-copy').addEventListener('click', copyLink);
  $('plan-qr-png').addEventListener('click', saveQrPicture);
  $('plan-qr-link').addEventListener('focus', function (e) { e.target.select(); });

  $('plan-shared-open').addEventListener('click', function () {
    var shared = ui.shared;
    if (!shared || !shared.state) return;
    var replacing = state.days.length > 0;
    ui.shared = null;
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    ui.notice = '';
    say('', false);
    update(shared.state, 'plan-name', 'Opened the shared plan.', replacing ? 'Opened the shared plan, in place of yours.' : '');
  });
  $('plan-shared-keep').addEventListener('click', function () {
    ui.shared = null;
    render('plan-name');
    announce('Closed.');
  });
  window.addEventListener('hashchange', function () { if (readLink()) render('shared-title'); });

  $('plan-reset-cancel').addEventListener('click', function () { closeDialog($('plan-reset-dialog')); });
  $('plan-reset-confirm').addEventListener('click', function () {
    closeDialog($('plan-reset-dialog'));
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
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
  render(readLink() ? 'shared-title' : undefined);
}());
