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
  var Msg = window.CaminoMessage;   // the "Ask for a bed" message: the page works without it
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
  var ui = { fromPlace: null, stayIndex: -1, insertAt: null, editAt: null, restAt: null, undo: null, far: false, openStop: null, shared: null, openMore: {}, details: null, detailsLoading: false, openPick: null,
    savedAt: null, savedId: null, persisted: null, keepAsk: null, confirmDelete: null };
  var MODE_LABELS = { flight: 'Flight', train: 'Train', bus: 'Bus', taxi: 'Taxi', ferry: 'Ferry', other: 'Other' };
  var state = loadState();

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ saving

  function loadState() {
    var raw = null, notice = '';
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (error) { raw = null; }
    if (!raw || !raw.state) return Plan.newState(data);
    if (typeof raw.at === 'string' && !isNaN(Date.parse(raw.at))) ui.savedAt = new Date(raw.at);
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
      var now = new Date();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ guide: data.guide, state: state, at: now.toISOString() }));
      storageWorks = true;
      ui.savedAt = now;
    } catch (error) {
      storageWorks = false;
    }
    if (root.classList.contains('plan-ready')) renderKeepStatus();
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
    renderKeep();
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
    var bad = !!shared.error, several = !!shared.plans && shared.plans.length > 1;
    $('plan-shared-title').textContent = bad ? (shared.file ? 'This file cannot be opened' : 'This plan code cannot be opened')
      : (shared.file ? 'Choose a plan from ' + shared.file : 'A plan has been shared with you');
    $('plan-shared-pick-row').hidden = bad || !several;
    if (!bad && several) {
      var pick = $('plan-shared-pick');
      pick.innerHTML = '';
      shared.plans.forEach(function (plan, n) {
        pick.appendChild(el('option', { value: String(n), selected: n === shared.index, text: plan.name + ' (' + plural(plan.days, 'day') + ')' }));
      });
    }
    $('plan-shared-error').textContent = bad ? shared.error : '';
    $('plan-shared-error').hidden = !bad;
    $('plan-shared-name').hidden = bad;
    $('plan-shared-detail').hidden = bad;
    $('plan-shared-open').hidden = bad;
    $('plan-shared-keep').textContent = bad ? 'Close' : (shared.file ? 'Cancel' : 'Keep my plan');
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
    $('plan-shared-detail').textContent = detail.concat(shared.notes || []).join(' ');
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

  // "1,534 m up, 1,680 m down", or '' when the guide has no heights for the day
  function climbText(up, down) {
    if (up === null || up === undefined || down === null || down === undefined) return '';
    return Plan.formatMetres(up) + ' up, ' + Plan.formatMetres(down) + ' down';
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
    if (t.walking && t.climb) box.appendChild(stat(Plan.formatMetres(t.up), 'climbing'));
    if (t.walking && t.climb) box.appendChild(stat(Plan.formatMetres(t.down), 'descending'));
    if (t.long) box.appendChild(stat(String(t.long), t.long === 1 ? 'long day' : 'long days'));
    box.appendChild(stat(String(t.rest + t.travel), 'rest or travel'));
    box.appendChild(stat(t.stays + ' of ' + t.days, 'nights chosen'));
    var note = $('plan-climb-note');
    if (note) note.hidden = !(t.walking && t.climb);
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
        el('label', {}, [el('span', { 'class': 'plan-arrive-caption', text: arrivesCaption(day) }), time('tarr', day.arr, 'Arrival time')]),
        el('label', {}, [el('span', { text: 'Ticket or booking reference' }), el('input', { type: 'text', 'class': 'plan-input', 'data-act': 'tref',
          maxlength: String(Plan.MAX_REF), autocomplete: 'off', value: day.ref || '', 'aria-label': 'Ticket reference for ' + name })]),
        el('label', { 'class': 'plan-more-wide' }, [el('span', { text: 'Notes' }), el('textarea', { 'class': 'plan-input plan-textarea', 'data-act': 'tnotes',
          rows: '2', maxlength: String(Plan.MAX_TRAVEL_NOTES), 'aria-label': 'Notes for ' + name }, [day.notes || ''])])
      ]),
      el('p', { 'class': 'plan-hint plan-nextday-note', hidden: !Plan.arrivesNextDay(day),
        text: 'This journey ends the next day. For a journey after it, leave "Same day as the day before" unticked so it gets the next date.' }),
      el('p', { 'class': 'plan-hint', text: 'These go in the plan code and the file. The phone app does not show them yet.' })
    ]);
  }

  // The caption over a journey's arrival time: "Arrives", or "Arrives (next day)" for a night journey.
  function arrivesCaption(day) { return 'Arrives' + (Plan.arrivesNextDay(day) ? ' (next day)' : ''); }

  // ------------------------------------------------------------------ what the guide says about a place to stay

  var stayNames = {};
  data.stays.forEach(function (row) { stayNames[(row[0] === 0 ? 'a' : 'p') + row[1]] = row[3]; });
  var detailsUrl = $('plan-stay-dialog').getAttribute('data-details-url');

  // The guide's details for a place, once /plan/stays.json has arrived (and only for the place the plan named).
  function detailFor(kind, id, name) {
    if (!ui.details || (kind !== 'a' && kind !== 'p')) return null;
    if (name !== undefined && stayNames[kind + id] !== name) return null;
    return (ui.details[kind] && ui.details[kind][String(id)]) || null;
  }

  // A small icon from the page's sprite (_icons.html, the same one the place pages in the guide use).
  function icon(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'btn-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  // The same buttons as a place's own page in the guide (styles in base.html), so a link looks the same on both.
  // The plan-link classes are only hooks for the tests; the look comes from btn and btn-*.
  function linkItem(link, name) {
    var key = link.key, logo = root.getAttribute('data-wa-logo'), kids, label;
    if (key === 'booking') {
      kids = [el('span', { text: link.text })];
      label = 'Booking.com for ' + name;
    } else if (key === 'whatsapp') {
      label = 'Message ' + name + ' on WhatsApp';
      if (logo) {
        var img = el('img', { src: logo, alt: '', width: '86', height: '20' });
        img.addEventListener('error', function () { img.replaceWith(el('span', { text: 'WhatsApp' })); });   // never a blank button
        kids = [img];
      } else {
        kids = [el('span', { text: 'WhatsApp' })];
      }
    } else if (key === 'call') {
      kids = [icon('i-phone'), el('span', { text: link.text })];
      label = 'Call ' + name + ', ' + link.text;
    } else if (key === 'email') {
      kids = [icon('i-email'), el('span', { text: 'Email' })];
      label = 'Email ' + name;
    } else {
      kids = [icon('i-language'), el('span', { text: 'Website' })];
      label = 'Website of ' + name;
    }
    var look = { booking: 'booking', whatsapp: 'wa', call: 'phone', email: 'email', website: 'web' }[key];
    return el('a', { 'class': 'btn btn-' + look + ' plan-link plan-link-' + key, href: link.href, target: key === 'call' || key === 'email' ? null : '_blank', rel: 'noopener',
      'aria-label': label }, kids);
  }

  // The ways to reach a place. On a day's own card (day index given) the first is "Ask for a bed".
  function linkRow(d, name, dayIndex) {
    var links = Plan.stayLinks(d, ui.details && ui.details.aff).map(function (link) { return linkItem(link, name); });
    if (dayIndex !== undefined && Msg && Msg.canAsk(d)) {
      links.unshift(el('button', { type: 'button', 'class': 'btn btn-ask plan-link plan-link-ask', 'data-act': 'askbed', 'data-focus': 'day-' + dayIndex + '-askbed',
        'aria-label': 'Ask ' + name + ' for a bed' }, [el('span', { text: 'Ask for a bed' })]));
    }
    return links.length ? el('div', { 'class': 'plan-links' }, links) : null;
  }

  // Under a chosen place: its price and beds, and the ways to reach it.
  function fillGuide(box, stay, dayIndex) {
    box.innerHTML = '';
    var d = stay ? detailFor(stay.k, stay.id, stay.name) : null;
    var line = d ? Plan.stayLine(stay.k, d) : '';
    var links = d ? linkRow(d, stay.name, dayIndex) : null;
    box.hidden = !(line || links);
    if (line) box.appendChild(el('span', { 'class': 'plan-stay-line', text: line }));
    if (links) box.appendChild(links);
  }

  function loadDetails() {
    if (ui.details || ui.detailsLoading || !detailsUrl || typeof fetch !== 'function') return;
    ui.detailsLoading = true;
    fetch(detailsUrl, { credentials: 'omit' })
      .then(function (response) { if (!response.ok) throw new Error('no details'); return response.json(); })
      .then(function (json) {
        if (!json || json.v !== 1 || !json.a || !json.p) return;
        ui.details = json;
        var dialog = $('plan-stay-dialog');
        if (dialog.open || dialog.hasAttribute('open')) renderStayList();
        var cards = $('plan-days').children;
        state.days.forEach(function (day, k) {
          var box = cards[k] && cards[k].querySelector('.plan-stay-guide');
          if (box) fillGuide(box, day.stay, k);
        });
      })
      .catch(function () { /* offline and never saved: the list keeps showing names only */ })
      .then(function () { ui.detailsLoading = false; });
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
      var guide = el('div', { 'class': 'plan-stay-guide', hidden: true });
      fillGuide(guide, day.stay, i);
      container.appendChild(guide);
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
      info.type === 's' && KIND_LABELS[info.stage.kind] ? chip(KIND_LABELS[info.stage.kind], info.stage.kind) : null,
      walking && info.long ? chip('Long day', 'long') : null
    ]);
    var body = [head, el('h4', { 'class': 'plan-day-title', tabindex: '-1', 'data-focus': 'day-' + i + '-title', text: dayTitle(info) })];

    if (walking && info.metres !== null) {
      var climb = climbText(info.up, info.down);
      body.push(el('p', { 'class': 'plan-day-meta', text: Plan.formatKm(info.metres) + ' on foot, about ' + Plan.formatDuration(info.seconds) + (climb ? ', ' + climb : '') }));
    } else if (info.type === 't') {
      var from = el('input', { type: 'text', 'class': 'plan-input', list: 'plan-places', value: day.from, autocomplete: 'off',
        placeholder: 'Where from?', 'data-act': 'from', 'data-focus': 'day-' + i + '-from', maxlength: '100' });
      var to = el('input', { type: 'text', 'class': 'plan-input', list: 'plan-places', value: day.to, autocomplete: 'off',
        placeholder: 'Where to? e.g. Saint Jean Pied de Port', 'data-act': 'to', 'data-focus': 'day-' + i + '-to', maxlength: '100' });
      body.push(el('p', { 'class': 'plan-day-hint', text: 'Flight, train, bus or taxi. Start typing a town on the Camino to pick it from the list, or type any place.' }));
      // Said only while the day is a single journey: once a second leg is added the person has found the way, and a day of three legs does not say it three times.
      if (info.parts === 1) {
        body.push(el('p', { 'class': 'plan-day-hint plan-leg-hint',
          text: 'Going in more than one leg, such as a bus then two flights? Use "Travel on the same day" below to add each leg as its own journey, each with its own times and reference.' }));
      }
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
            text: (foundLabels[n] || info.end.name) + ' (' + Plan.formatKm(t.metres) + (t.up !== null ? ', ' + Plan.formatMetres(t.up) + ' up' : '') + ')' }));
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
    var meta = Plan.formatKm(stop.metres) + ', about ' + Plan.formatDuration(seconds) + (stop.up !== null && stop.up !== undefined ? ', ' + Plan.formatMetres(stop.up) + ' up' : '') +
      (stays ? ', ' + plural(stays, 'place') + ' to stay' : '');
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
          el('span', { 'class': 'plan-option-meta', text: Plan.formatKm(t.metres) + ', about ' + time + (t.up !== null ? ', ' + Plan.formatMetres(t.up) + ' up' : '') })
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

  // A plan marked complete puts the add-a-day card away, so the page does not end on a "Day 10" that is not
  // wanted. It comes back when a day is being added in the middle of the plan or changed, or the plan is emptied.
  function renderDone(editing) {
    var closed = !!state.done && state.days.length > 0 && editing === null && ui.insertAt === null;
    $('plan-add-card').hidden = closed;
    $('plan-done').hidden = !closed;
    if (closed) {
      var totals = Plan.totals(state, data), days = Plan.layout(state, data).days;
      var last = days[days.length - 1], place = last && last.end && last.end.name;
      $('plan-done-text').textContent = plural(totals.days, 'day') + (place ? ', ending at ' + place : '') +
        '. When you are ready, send it to the app, print it or save a copy, below. You can still change any day.';
    }
    $('plan-finish-row').hidden = editing !== null || !state.days.length;
  }

  function renderAdd() {
    var count = state.days.length, editing = editingIndex(), at = editing === null ? insertPoint() : null;
    renderDone(editing);
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

  // Hands the file to the browser as a download.
  function downloadFile(file) {
    var blob = new Blob([file.text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: file.name });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function download() {
    var file;
    try { file = makeFile(); } catch (error) { say(error.message, true); return; }
    downloadFile(file);
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


  // ------------------------------------------------------------------ keeping a plan
  //
  // The plan being worked on is saved in this browser after every change (STORAGE_KEY). On top of that the
  // visitor can keep named copies in this browser (LIBRARY_KEY), save a copy as a file wherever they like
  // (a folder on their computer, or one their cloud drive keeps in step), and open such a file again. Nothing
  // is sent anywhere, and there is no account.

  var LIBRARY_KEY = 'camino-plans-v1';
  var MAX_SAVED = 20;

  function readLibrary() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) || 'null'); } catch (error) { raw = null; }
    var list = raw && Array.isArray(raw.plans) ? raw.plans : [];
    return list.filter(function (p) { return p && typeof p.id === 'string' && typeof p.name === 'string' && p.state && typeof p.state === 'object'; });
  }

  function writeLibrary(list) {
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify({ v: 1, plans: list })); return true; } catch (error) { return false; }
  }

  function stamp(when) {
    var d = when instanceof Date ? when : new Date(when);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (error) { return d.toISOString(); }
  }

  function keepSay(message, isError) {
    var box = $('plan-keep-msg');
    box.textContent = message;
    box.className = 'plan-send-msg' + (isError ? ' plan-error' : '');
    box.hidden = !message;
  }

  function renderKeepStatus() {
    var line = state.days.length ? 'Your plan is saved in this browser, on this device, after every change' +
      (ui.savedAt ? ' (last at ' + stamp(ui.savedAt) + ')' : '') + '.' : 'Add a day and your plan is saved in this browser, on this device, after every change.';
    $('plan-keep-status').textContent = storageWorks ? line : 'This browser cannot save your plan, so keep a copy as a file.';
    var note = $('plan-keep-storage');
    if (ui.persisted === true) note.textContent = 'Your browser has agreed to keep what is saved here until you clear its site data.';
    else note.textContent = 'A browser can clear what it keeps when it is short of space, and Safari clears it after a week without a visit. Save a copy as a file to be safe.';
    note.hidden = !state.days.length && !readLibrary().length;
    var empty = !state.days.length;
    $('plan-save-copy').disabled = empty;
    $('plan-save-browser').disabled = empty;
    $('plan-print-go').disabled = empty;
  }

  function savedMeta(p) {
    var bits = [plural(p.days || 0, 'day')];
    if (p.startDate) bits.push('from ' + formatDate(p.startDate));
    bits.push('saved ' + stamp(p.savedAt));
    var meta = bits.join(', ') + '.';
    if (p.guide && p.guide !== data.guide) meta += ' Made for an older edition of the guide, so check each day.';
    return meta;
  }

  var savedSignature = '';

  function renderSaved() {
    var list = readLibrary().sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
    var box = $('plan-saved-list');
    // Drawn again only when something in it changed: a list that is rebuilt while the visitor presses one of its
    // buttons (the name field losing focus redraws the page) would lose the click.
    var signature = JSON.stringify([ui.confirmDelete, list.map(function (p) { return [p.id, p.name, p.savedAt, p.days, p.startDate, p.guide]; })]);
    if (signature === savedSignature) return;
    savedSignature = signature;
    box.innerHTML = '';
    list.forEach(function (p) {
      var asking = ui.confirmDelete === p.id;
      box.appendChild(el('li', { 'class': 'plan-saved-item' }, [
        el('span', { 'class': 'plan-saved-text' }, [
          el('span', { 'class': 'plan-saved-name', text: p.name }),
          el('span', { 'class': 'plan-saved-meta', text: savedMeta(p) })
        ]),
        el('span', { 'class': 'plan-saved-buttons' }, [
          el('button', { type: 'button', 'class': 'plan-btn plan-btn-small', 'data-saved': 'open', 'data-id': p.id, 'aria-label': 'Open ' + p.name, text: 'Open' }),
          el('button', { type: 'button', 'class': 'plan-btn plan-btn-small' + (asking ? ' plan-btn-danger' : ''), 'data-saved': 'delete', 'data-id': p.id,
            'aria-label': (asking ? 'Really delete ' : 'Delete ') + p.name, text: asking ? 'Delete it for good?' : 'Delete' })
        ])
      ]));
    });
    $('plan-saved-empty').hidden = list.length > 0;
  }

  function renderAsk() {
    var ask = ui.keepAsk, box = $('plan-keep-ask');
    box.hidden = !ask;
    if (ask) {
      $('plan-keep-ask-text').textContent = 'You already have a saved plan called "' + ask.existing.name + '" (' + plural(ask.existing.days || 0, 'day') +
        ', saved ' + stamp(ask.existing.savedAt) + '). Replace it with this one, or keep both?';
    }
  }

  function renderKeep() {
    renderKeepStatus();
    renderSaved();
    renderAsk();
  }

  function askPersistence() {
    if (!(navigator.storage && navigator.storage.persist && navigator.storage.persisted)) return;
    navigator.storage.persisted().then(function (already) { return already || navigator.storage.persist(); })
      .then(function (granted) { ui.persisted = !!granted; renderKeepStatus(); }, function () { /* the note stays as it was */ });
  }

  function newSavedId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // Puts a copy of the plan into the saved list, as `name` (replacing the one with `id` if given).
  function storeCopy(name, id) {
    var list = readLibrary(), t = Plan.totals(state, data);
    var entry = { id: id || newSavedId(), name: name, savedAt: new Date().toISOString(), guide: data.guide, days: t.days,
      startDate: state.startDate, state: JSON.parse(JSON.stringify(state)) };
    var next = list.filter(function (p) { return p.id !== entry.id; });
    if (!id && next.length >= MAX_SAVED) { keepSay('You have ' + MAX_SAVED + ' saved plans here, which is the most this page keeps. Delete one first.', true); return false; }
    next.push(entry);
    if (!writeLibrary(next)) { keepSay('This browser would not save it. Use "Save a copy" to keep a file instead.', true); return false; }
    ui.savedId = entry.id;
    ui.keepAsk = null;
    ui.confirmDelete = null;
    renderKeep();
    askPersistence();
    return entry;
  }

  function saveInBrowser() {
    if (!state.days.length) return;
    var name = (String(state.name || '').trim() || 'My Camino');
    var same = readLibrary().filter(function (p) { return p.name.trim().toLowerCase() === name.toLowerCase(); })[0];
    if (same && same.id !== ui.savedId) {
      ui.keepAsk = { name: name, existing: same };
      keepSay('', false);
      renderAsk();
      var first = $('plan-keep-replace');
      if (first) first.focus();
      return;
    }
    var entry = storeCopy(name, same ? same.id : null);
    if (entry) { keepSay('Saved "' + name + '" in this browser.', false); announce('Saved in this browser.'); }
  }

  function uniqueName(name) {
    var taken = readLibrary().map(function (p) { return p.name.trim().toLowerCase(); }), n = 2;
    while (taken.indexOf((name + ' (' + n + ')').toLowerCase()) >= 0) n += 1;
    return name + ' (' + n + ')';
  }

  // Saves the plan as a file: through the browser's save dialog where it has one (so the visitor chooses the
  // folder, perhaps one their cloud drive keeps in step), otherwise as a download.
  function saveCopy() {
    var file;
    try { file = makeFile(); } catch (error) { keepSay(error.message + ' Put that right to save a file, or use "Save in this browser".', true); return; }
    function viaDownload() {
      downloadFile(file);
      keepSay('Saved ' + file.name + ' to your downloads. Keep it somewhere safe.', false);
    }
    if (typeof window.showSaveFilePicker !== 'function') { viaDownload(); return; }
    window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: 'Camino itinerary', accept: { 'application/json': ['.json'] } }] })
      .then(function (handle) {
        return handle.createWritable().then(function (out) {
          return out.write(file.text).then(function () { return out.close(); });
        }).then(function () { keepSay('Saved ' + handle.name + '. Keep it somewhere safe.', false); });
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        viaDownload();
      });
  }

  // A field being typed in keeps what is in it when the page is drawn again. A whole plan arriving must not: let go of it.
  function releaseFocus() {
    var active = document.activeElement;
    if (active && active !== document.body && root.contains(active) && typeof active.blur === 'function') active.blur();
  }

  // Opens a plan from a saved copy or a file, in place of the plan on the page (Undo is offered).
  function openPlan(next, label, notes, savedId) {
    var replacing = state.days.length > 0;
    releaseFocus();
    ui.shared = null;
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    keepSay('', false);
    say('', false);
    update(next, 'plan-name', 'Opened ' + label + '.', replacing ? 'Opened ' + label + ', in place of your plan.' : '');
    ui.savedId = savedId || null;
    ui.notice = (notes || []).join(' ');
    renderNotice();
    renderKeep();
  }

  function openSaved(id) {
    var entry = readLibrary().filter(function (p) { return p.id === id; })[0];
    if (!entry) { keepSay('That saved plan is no longer here.', true); renderKeep(); return; }
    var cleaned = Plan.clean(entry.state, data), notes = [];
    var before = Array.isArray(entry.state.days) ? entry.state.days.length : 0;
    if (cleaned.days.length < before) notes.push((before - cleaned.days.length) + ' saved day' + (before - cleaned.days.length === 1 ? ' was' : 's were') + ' dropped because that part of the guide no longer exists.');
    else if (entry.guide && entry.guide !== data.guide) notes.push('The guide has been updated since you saved this plan. Please check each day.');
    openPlan(cleaned, '"' + entry.name + '"', notes, entry.id);
  }

  function deleteSaved(id) {
    var list = readLibrary(), gone = list.filter(function (p) { return p.id === id; })[0];
    if (!gone) return;
    if (!writeLibrary(list.filter(function (p) { return p.id !== id; }))) { keepSay('This browser would not let that go. Try again.', true); return; }
    if (ui.savedId === id) ui.savedId = null;
    ui.confirmDelete = null;
    keepSay('Deleted "' + gone.name + '" from this browser.', false);
    renderKeep();
    announce('Deleted.');
  }

  function openFile(file) {
    if (!file) return;
    keepSay('', false);
    if (file.size > 3000000) { keepSay('That file is too big to be a plan.', true); return; }
    var reader = new FileReader();
    reader.onerror = function () { keepSay('That file could not be read.', true); };
    reader.onload = function () {
      var doc;
      try { doc = JSON.parse(String(reader.result)); } catch (error) { keepSay('That is not a plan file: it is not readable text.', true); return; }
      var result = Plan.readFile(doc, data);
      if (!result.ok) { ui.shared = { error: result.message, file: file.name }; render('shared-title'); return; }
      if (result.plans.length === 1) {
        var only = result.plans[0];
        openPlan(Plan.setDone(only.state, true), '"' + only.name + '"', only.notes, null);
        return;
      }
      ui.shared = { state: result.plans[0].state, plans: result.plans, index: 0, file: file.name, notes: result.plans[0].notes };
      render('shared-title');
    };
    reader.readAsText(file);
  }


  // ------------------------------------------------------------------ the printed sheet
  //
  // "Print or save as PDF" (and the browser's own Print) shows only #plan-print, a table built here from the same
  // layout as the page. Nothing is added to it that the visitor did not choose: booking references, contacts and
  // notes are on the sheet only when that box is ticked.

  var PRINT_KEY = 'camino-plan-print-v1';
  var printOptions = { dates: true, stays: true, private: false, detail: 'full' };

  function loadPrintOptions() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PRINT_KEY) || 'null'); } catch (error) { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    ['dates', 'stays', 'private'].forEach(function (key) { if (typeof raw[key] === 'boolean') printOptions[key] = raw[key]; });
    if (raw.detail === 'full' || raw.detail === 'summary') printOptions.detail = raw.detail;
  }

  function showPrintOptions() {
    $('plan-print-dates').checked = printOptions.dates;
    $('plan-print-stays').checked = printOptions.stays;
    $('plan-print-private').checked = printOptions.private;
    $('plan-print-full').checked = printOptions.detail === 'full';
    $('plan-print-summary').checked = printOptions.detail === 'summary';
  }

  function readPrintOptions() {
    printOptions.dates = $('plan-print-dates').checked;
    printOptions.stays = $('plan-print-stays').checked;
    printOptions.private = $('plan-print-private').checked;
    printOptions.detail = $('plan-print-summary').checked ? 'summary' : 'full';
    try { localStorage.setItem(PRINT_KEY, JSON.stringify(printOptions)); } catch (error) { /* it is only a convenience */ }
  }

  function printDate(iso) {
    try {
      return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    } catch (error) {
      return iso;
    }
  }

  // What a day's route cell says: where, and for a journey how and when.
  function printRoute(info, day, full) {
    var kids = [];
    if (info.invalid) return [el('span', { 'class': 'plan-print-none', text: dayTitle(info) + ': not finished yet' })];
    if (info.type === 'r') {
      kids.push(el('span', { 'class': 'plan-print-place', text: dayTitle(info) }));
    } else if (info.type === 't') {
      var from = info.start ? info.start.name : '', to = info.end ? info.end.name : '';
      kids.push(el('span', { 'class': 'plan-print-place', text: dayTitle(info) + (from || to ? ': ' + from + ' to ' + to : '') }));
      if (full) {
        var times = [];
        if (day.dep !== undefined) times.push('leaves ' + Plan.formatClock(day.dep));
        if (day.arr !== undefined) times.push('arrives ' + Plan.formatClock(day.arr) + (Plan.arrivesNextDay(day) ? ' (next day)' : ''));
        if (times.length) kids.push(el('span', { 'class': 'plan-print-small', text: times.join(', ') }));
        if (printOptions.private && day.ref) kids.push(el('span', { 'class': 'plan-print-small', text: 'Reference: ' + day.ref }));
        if (printOptions.private && day.notes) kids.push(el('span', { 'class': 'plan-print-small', text: day.notes }));
      }
    } else {
      kids.push(el('span', { 'class': 'plan-print-place', text: dayTitle(info) }));
      var notes = [];
      if (info.type === 's' && KIND_LABELS[info.stage.kind]) notes.push(KIND_LABELS[info.stage.kind]);
      if (info.long) notes.push('long day');
      if (full && notes.length) kids.push(el('span', { 'class': 'plan-print-small', text: cap(notes.join(', ')) }));
    }
    return kids;
  }

  function printStay(day, full) {
    var stay = day.stay;
    if (!stay) return [el('span', { 'class': 'plan-print-none', text: 'Not chosen yet' })];
    var kids = [el('span', { 'class': 'plan-print-place', text: stay.name })];
    if (full) {
      kids.push(el('span', { 'class': 'plan-print-small', text: STAY_NAMES[stay.k] + ', ' + stay.status.toLowerCase() }));
      if (printOptions.private) {
        if (stay.ref) kids.push(el('span', { 'class': 'plan-print-small', text: 'Reference: ' + stay.ref }));
        if (stay.contact) kids.push(el('span', { 'class': 'plan-print-small', text: 'Contact: ' + stay.contact }));
        if (stay.notes) kids.push(el('span', { 'class': 'plan-print-small', text: stay.notes }));
      }
    }
    return kids;
  }

  function buildPrint() {
    var sheet = $('plan-print');
    sheet.innerHTML = '';
    var layout = Plan.layout(state, data), t = Plan.totals(state, data), p = Plan.progress(state, data);
    var full = printOptions.detail === 'full', dates = printOptions.dates && !!state.startDate, stays = printOptions.stays;
    sheet.appendChild(el('h2', { 'class': 'plan-print-title', text: state.name || 'My Camino' }));
    if (!state.days.length) {
      sheet.appendChild(el('p', { text: 'No days planned yet.' }));
      return;
    }
    var sub = [];
    if (p.start && p.end) sub.push(p.start.name + ' to ' + p.end.name);
    sub.push(plural(t.days, 'day'));
    if (dates) {
      var first = layout.days[0].date, last = layout.days[layout.days.length - 1].date;
      if (first) sub.push(first === last ? formatDate(first) : formatDate(first) + ' to ' + formatDate(last));
    }
    sheet.appendChild(el('p', { 'class': 'plan-print-sub', text: sub.join(', ') }));
    var totals = [];
    if (t.walking) {
      totals.push(Plan.formatKm(t.metres) + ' on foot over ' + plural(t.walking, 'walking day'));
      if (full) {
        totals.push('about ' + Plan.formatDuration(t.seconds) + ' of walking at ' + state.pace.toFixed(1) + ' km/h');
        if (t.climb) totals.push(Plan.formatMetres(t.up) + ' up, ' + Plan.formatMetres(t.down) + ' down');
        if (t.long) totals.push(plural(t.long, 'long day'));
      }
    }
    if (t.rest) totals.push(plural(t.rest, 'rest day'));
    if (t.travel) totals.push(plural(t.travel, 'travel day'));
    if (stays) totals.push(t.stays + ' of ' + plural(t.days, 'night') + ' chosen');
    sheet.appendChild(el('p', { 'class': 'plan-print-totals', text: totals.join('. ') + '.' }));

    var heads = [['Day', ''], dates ? ['Date', ''] : null, ['Route', 'plan-print-route'], ['Distance', 'plan-print-num'],
      full ? ['Time', 'plan-print-num'] : null, full ? ['Climb', 'plan-print-num'] : null, stays ? ['Where to stay', 'plan-print-stay'] : null].filter(Boolean);
    var table = el('table', { 'class': 'plan-print-table' }, [
      el('thead', {}, [el('tr', {}, heads.map(function (h) { return el('th', { scope: 'col', 'class': h[1] || null, text: h[0] }); }))])
    ]);
    var body = el('tbody');
    layout.days.forEach(function (info, i) {
      var day = state.days[i], walking = info.type === 's' || info.type === 'c';
      var cells = [el('td', { 'class': 'plan-print-day', text: Plan.dayLabel(info) })];
      if (dates) cells.push(el('td', { 'class': 'plan-print-date', text: info.date ? printDate(info.date) : '' }));
      cells.push(el('td', { 'class': 'plan-print-route' }, printRoute(info, day, full)));
      cells.push(el('td', { 'class': 'plan-print-num', text: walking && info.metres !== null ? Plan.formatKm(info.metres) : '' }));
      if (full) {
        cells.push(el('td', { 'class': 'plan-print-num', text: walking && info.seconds !== null ? Plan.formatDuration(info.seconds) : '' }));
        cells.push(el('td', { 'class': 'plan-print-num' }, walking && info.up !== null
          ? [el('span', { 'class': 'plan-print-line', text: Plan.formatMetres(info.up) + ' up' }), el('span', { 'class': 'plan-print-line', text: Plan.formatMetres(info.down) + ' down' })] : []));
      }
      if (stays) cells.push(el('td', { 'class': 'plan-print-stay' }, printStay(day, full)));
      body.appendChild(el('tr', { 'class': 'plan-print-' + (walking ? 'walk' : (info.type === 'r' ? 'rest' : 'travel')) }, cells));
    });
    table.appendChild(body);
    sheet.appendChild(table);
    var foot = 'Planned at ' + location.host + location.pathname + ' on ' + new Date().toLocaleDateString() +
      '. Distances and times are estimates for a walking pace of ' + state.pace.toFixed(1) + ' km/h on the flat. Check opening times, prices and availability before you go.';
    sheet.appendChild(el('p', { 'class': 'plan-print-foot', text: foot }));
  }

  function printPlan() {
    readPrintOptions();
    buildPrint();
    window.print();
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

  // The facts and the ways to reach a place, opened from its Details button.
  function pickPanel(kind, id, d, name, placeId, townName) {
    var facts = [];
    function fact(label, value) { if (value) facts.push(el('dt', { text: label }), el('dd', { text: value })); }
    fact('Address', d.ad);
    fact('Open', d.op);
    fact('Check-in', d.ci);
    fact('Facilities', Plan.facilityNames(d.f).join(', '));
    fact('Price note', d.rn);
    var kids = [];
    if (facts.length) kids.push(el('dl', { 'class': 'plan-facts' }, facts));
    var links = linkRow(d, name);
    if (links) kids.push(links);
    if (placeId > 0) {
      kids.push(el('p', { 'class': 'plan-pick-town' }, [el('a', { href: '/location/' + placeId + '/', target: '_blank', rel: 'noopener',
        text: 'More about ' + townName + ' in the guide' })]));
    }
    return el('div', { 'class': 'plan-pick-panel' }, kids);
  }

  function stayItem(kind, id, name, placeId, townName) {
    var d = detailFor(kind, id), line = Plan.stayLine(kind, d), key = kind + id;
    var open = !!d && ui.openPick === key;
    var pick = el('button', { type: 'button', 'class': 'plan-pick', 'data-pick-kind': kind, 'data-pick-id': String(id), 'data-pick-name': name }, [
      el('span', { 'class': 'plan-pick-name', text: name }),
      line ? el('span', { 'class': 'plan-pick-line', text: line }) : null
    ]);
    var info = d ? el('button', { type: 'button', 'class': 'plan-pick-info', 'data-info': key, 'aria-expanded': open ? 'true' : 'false',
      'aria-label': 'Details of ' + name, text: 'Details' }) : null;
    var kids = [el('div', { 'class': 'plan-pick-row' }, [pick, info])];
    if (open) kids.push(pickPanel(kind, id, d, name, placeId, townName));
    return el('li', {}, kids);
  }

  function renderStayList() {
    var i = ui.stayIndex, layout = Plan.layout(state, data), info = layout.days[i];
    if (!info || !info.end) return;
    var query = $('plan-stay-search').value.trim().toLowerCase();
    var found = info.end.id > 0 ? Plan.staysAt(info.end.id, data) : { albergues: [], privates: [] };
    function match(s) { return !query || s.name.toLowerCase().indexOf(query) >= 0; }
    var albergues = found.albergues.filter(match), privates = found.privates.filter(match);
    var list = $('plan-stay-list'), scrolled = list.scrollTop;
    list.innerHTML = '';
    function group(title, items, kind) {
      if (!items.length) return;
      list.appendChild(el('li', { 'class': 'plan-pick-group', text: title }));
      items.forEach(function (s) { list.appendChild(stayItem(kind, s.id, s.name, info.end.id, info.end.name)); });
    }
    group('Albergues', albergues, 'a');
    group('Hotels and guesthouses', privates, 'p');
    var total = found.albergues.length + found.privates.length;
    $('plan-stay-empty').hidden = !!(albergues.length + privates.length);
    $('plan-stay-empty').textContent = total ? 'Nothing matches that. Try fewer letters.' : 'The guide has no places to stay listed for ' + info.end.name + '. Add your own below.';
    $('plan-stay-search-row').hidden = total < 8;
    $('plan-stay-note').hidden = !(ui.details && total);
    list.scrollTop = scrolled;
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
    ui.openPick = null;
    renderStayList();
    loadDetails();
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

  // ------------------------------------------------------------------ ask for a bed

  var HELPER_KEY = 'camino-plan-helper-v1';   // the name and the number of people, kept in this browser only

  function loadHelper() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(HELPER_KEY) || 'null'); } catch (error) { saved = null; }
    var people = Math.floor(Number(saved && saved.people));
    return { name: Msg ? Msg.cleanName(saved && saved.name) : '', people: people >= 1 && people <= 10 ? people : 1 };
  }

  function saveHelper() {
    try { localStorage.setItem(HELPER_KEY, JSON.stringify({ name: Msg.cleanName($('plan-bed-name').value), people: wholeNumber($('plan-bed-people').value) || 1 })); } catch (error) { /* it is only a convenience */ }
  }

  function wholeNumber(text) {
    var n = Number(String(text).trim());
    return String(text).trim() !== '' && n === Math.floor(n) ? n : NaN;
  }

  // What the form says now, or what is wrong with it.
  function bedForm() {
    var stay = ui.bed.stay, d = ui.bed.d;
    var form = { language: Msg.languageFor(d), arrival: $('plan-bed-date').value, yourName: $('plan-bed-name').value,
      nights: wholeNumber($('plan-bed-nights').value), people: wholeNumber($('plan-bed-people').value),
      room: stay.k === 'p' || (!$('plan-bed-room-row').hidden && $('plan-bed-room').value === 'room') ? 'room' : 'dormitory',
      placeName: stay.name };
    if (!Msg.parseDate(form.arrival)) form.problem = 'Choose your arrival date to write the message.';
    else if (!(form.nights >= 1 && form.nights <= Msg.MAX_NIGHTS)) form.problem = 'Nights must be a whole number from 1 to ' + Msg.MAX_NIGHTS + '.';
    else if (!(form.people >= 1 && form.people <= Msg.MAX_PEOPLE)) form.problem = 'People must be a whole number from 1 to ' + Msg.MAX_PEOPLE + '.';
    return form;
  }

  function draftOf(form, channel) {
    return form.problem ? null : Msg.build({ language: form.language, channel: channel, placeName: form.placeName, arrival: form.arrival,
      nights: form.nights, people: form.people, room: form.room, yourName: form.yourName });
  }

  function setLink(anchor, href) {
    if (href) { anchor.setAttribute('href', href); anchor.removeAttribute('aria-disabled'); }
    else { anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true'); }
  }

  // Redraws the message (unless the visitor has changed it) and the buttons that send it.
  function refreshBed() {
    if (!ui.bed) return;
    var d = ui.bed.d, form = bedForm(), whatsapp = draftOf(form, 'whatsapp'), email = draftOf(form, 'email');
    var text = $('plan-bed-text');
    if (!ui.bed.edited) text.value = whatsapp ? whatsapp.body : '';
    $('plan-bed-problem').hidden = !form.problem;
    $('plan-bed-problem').textContent = form.problem || '';
    $('plan-bed-meaning').textContent = whatsapp ? whatsapp.meaning : '';
    $('plan-bed-language').textContent = 'This message is in ' + (form.language === 'fr' ? 'French' : 'Spanish') + ', the language of the place.';
    $('plan-bed-reset').hidden = !ui.bed.edited;
    var message = text.value, ready = message.trim() !== '';
    var wa = $('plan-bed-whatsapp'), mail = $('plan-bed-email');
    wa.hidden = !d.wa;
    mail.hidden = !d.em;
    var waLink = null, mailLink = null;
    try { if (d.wa && ready) waLink = Msg.whatsAppLink(d.wa, message); } catch (error) { waLink = null; }
    try { if (d.em && ready) mailLink = Msg.emailLink(d.em, email ? email.subject : '', ui.bed.edited || !email ? message : email.body); } catch (error) { mailLink = null; }
    setLink(wa, waLink);
    setLink(mail, mailLink);
    $('plan-bed-copy').disabled = !ready;
  }

  function openBed(index) {
    var stay = state.days[index] && state.days[index].stay;
    var d = stay ? detailFor(stay.k, stay.id, stay.name) : null;
    if (!Msg || !d || !Msg.canAsk(d)) return;
    var info = Plan.layout(state, data).days[index], saved = loadHelper();
    ui.bed = { i: index, stay: stay, d: d, edited: false };
    $('plan-bed-title').textContent = 'Ask ' + stay.name + ' for a bed';
    $('plan-bed-date').value = info && info.date ? info.date : '';
    $('plan-bed-nights').value = '1';
    $('plan-bed-people').value = String(saved.people);
    $('plan-bed-name').value = saved.name;
    var rooms = stay.k === 'a' && (d.f || '').indexOf('r') >= 0;   // an albergue offers a room only when the guide says it has them
    $('plan-bed-room-row').hidden = !rooms;
    $('plan-bed-room').value = 'dormitory';
    $('plan-bed-msg').hidden = true;
    refreshBed();
    var dialog = $('plan-bed-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    $('plan-bed-' + ($('plan-bed-date').value ? 'text' : 'date')).focus();
  }

  function closeBed() {
    var index = ui.bed ? ui.bed.i : -1;
    closeDialog($('plan-bed-dialog'));
    ui.bed = null;
    var back = index >= 0 ? root.querySelector('[data-focus="day-' + index + '-askbed"]') : null;
    if (back) back.focus();
  }

  function copyMessage() {
    var text = $('plan-bed-text'), note = $('plan-bed-msg');
    function done(ok) {
      note.hidden = false;
      note.textContent = ok ? 'Message copied.' : 'Could not copy. Select the message and copy it yourself.';
      note.className = 'plan-send-msg' + (ok ? '' : ' plan-error');
      saveHelper();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text.value).then(function () { done(true); }, function () { done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  }

  function legacyCopy(field) {
    try { field.focus(); field.select(); return !!document.execCommand('copy'); } catch (error) { return false; }
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
    if (state.done && ui.insertAt === null) { state = Plan.setDone(state, false); saveState(); }   // the end of the plan again: more days are coming
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
  // "My plan is complete" folds the add-a-day card away; "Add another day" brings it back.
  $('plan-finish').addEventListener('click', function () {
    if (!state.days.length) return;
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    update(Plan.setDone(state, true), 'done-title', 'Your plan is marked complete. Use Add another day to carry on.');
  });
  $('plan-reopen').addEventListener('click', function () {
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    update(Plan.setDone(state, false), 'add-title', 'Add the next day.');
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
    else if (act === 'askbed') openBed(i);
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
      if (act === 'tdep' || act === 'tarr') {
        // an arrival earlier than the departure means a night journey: say so beside the time, and what it means for the next one
        var more = target.closest('.plan-travel-more'), caption = more.querySelector('.plan-arrive-caption');
        var wasNext = caption.textContent !== 'Arrives', isNext = Plan.arrivesNextDay(now);
        caption.textContent = arrivesCaption(now);
        more.querySelector('.plan-nextday-note').hidden = !isNext;
        if (wasNext !== isNext) announce(cap(ref(i)) + (isNext ? ' now arrives the next day.' : ' now arrives the same day.'));
      }
      renderSend();
    }
  });

  // Which detail panels are open, kept across redraws.
  $('plan-days').addEventListener('toggle', function (e) {
    var box = e.target, key = box && box.getAttribute && box.getAttribute('data-more');
    if (!key) return;
    if (box.open) ui.openMore[key] = true; else delete ui.openMore[key];
  }, true);

  ['plan-bed-date', 'plan-bed-nights', 'plan-bed-people', 'plan-bed-room', 'plan-bed-name'].forEach(function (id) {
    $(id).addEventListener('input', function () { refreshBed(); });
    $(id).addEventListener('change', function () { refreshBed(); saveHelper(); });
  });
  $('plan-bed-text').addEventListener('input', function () { if (ui.bed) { ui.bed.edited = true; refreshBed(); } });
  $('plan-bed-reset').addEventListener('click', function () { if (ui.bed) { ui.bed.edited = false; refreshBed(); $('plan-bed-text').focus(); } });
  $('plan-bed-copy').addEventListener('click', copyMessage);
  $('plan-bed-whatsapp').addEventListener('click', saveHelper);
  $('plan-bed-email').addEventListener('click', saveHelper);
  $('plan-bed-close').addEventListener('click', closeBed);
  $('plan-bed-dialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeBed(); });
  $('plan-bed-dialog').addEventListener('cancel', function () { ui.bed = null; });

  $('plan-stay-search').addEventListener('input', renderStayList);
  $('plan-stay-list').addEventListener('click', function (e) {
    var toggle = e.target.closest ? e.target.closest('button[data-info]') : null;
    if (toggle) {
      var key = toggle.getAttribute('data-info');
      ui.openPick = ui.openPick === key ? null : key;
      renderStayList();
      var again = $('plan-stay-list').querySelector('[data-info="' + key + '"]');
      if (again) again.focus();
      var shown = $('plan-stay-list').querySelector('.plan-pick-panel');
      if (shown) {   // bring the place and its details to the top of the list
        var item = shown.parentNode, box = $('plan-stay-list');
        box.scrollTop += item.getBoundingClientRect().top - box.getBoundingClientRect().top;
      }
      return;
    }
    var target = e.target.closest ? e.target.closest('button[data-pick-kind]') : null;
    if (!target) return;
    chooseStay({ k: target.getAttribute('data-pick-kind'), id: Number(target.getAttribute('data-pick-id')),
      name: target.getAttribute('data-pick-name'), status: $('plan-stay-status').value });
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
    if (shared.file) {
      var chosen = shared.plans[shared.index];
      openPlan(Plan.setDone(chosen.state, true), '"' + chosen.name + '"', chosen.notes, null);
      return;
    }
    var replacing = state.days.length > 0;
    releaseFocus();
    ui.shared = null;
    ui.fromPlace = null;
    ui.insertAt = null;
    ui.openStop = null;
    ui.far = false;
    ui.notice = '';
    say('', false);
    update(Plan.setDone(shared.state, true), 'plan-name', 'Opened the shared plan.', replacing ? 'Opened the shared plan, in place of yours.' : '');
  });
  $('plan-shared-pick').addEventListener('change', function (e) {
    var shared = ui.shared;
    if (!shared || !shared.plans) return;
    shared.index = Number(e.target.value) || 0;
    shared.state = shared.plans[shared.index].state;
    shared.notes = shared.plans[shared.index].notes;
    renderShared();
  });

  ['plan-print-dates', 'plan-print-stays', 'plan-print-private', 'plan-print-full', 'plan-print-summary'].forEach(function (id) {
    $(id).addEventListener('change', readPrintOptions);
  });
  $('plan-print-go').addEventListener('click', printPlan);
  // The browser's own Print (Ctrl+P, or its menu) gets the same sheet.
  window.addEventListener('beforeprint', function () { readPrintOptions(); buildPrint(); });

  $('plan-save-copy').addEventListener('click', saveCopy);
  $('plan-save-browser').addEventListener('click', saveInBrowser);
  $('plan-open-file').addEventListener('click', function () { $('plan-file').click(); });
  $('plan-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    openFile(file);
    e.target.value = '';   // choosing the same file again must work
  });
  $('plan-keep-replace').addEventListener('click', function () {
    var ask = ui.keepAsk;
    if (!ask) return;
    var entry = storeCopy(ask.name, ask.existing.id);
    if (entry) keepSay('Replaced "' + ask.name + '" in this browser.', false);
  });
  $('plan-keep-both').addEventListener('click', function () {
    var ask = ui.keepAsk;
    if (!ask) return;
    var name = uniqueName(ask.name);
    var entry = storeCopy(name, null);
    if (entry) keepSay('Saved this plan as "' + name + '" next to the other.', false);
  });
  $('plan-keep-cancel').addEventListener('click', function () {
    ui.keepAsk = null;
    renderAsk();
    $('plan-save-browser').focus();
  });
  $('plan-saved-list').addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('button[data-saved]') : null;
    if (!target) return;
    var id = target.getAttribute('data-id');
    if (target.getAttribute('data-saved') === 'open') { ui.confirmDelete = null; openSaved(id); return; }
    if (ui.confirmDelete === id) { deleteSaved(id); return; }
    ui.confirmDelete = id;
    renderSaved();
    var again = root.querySelector('#plan-saved-list button[data-saved="delete"][data-id="' + id + '"]');
    if (again) again.focus();
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
    ui.savedId = null;
    update(Plan.newState(data), 'plan-name', 'Plan cleared.');
  });

  // ------------------------------------------------------------------ start

  var places = $('plan-places');
  Object.keys(data.places).map(function (id) { return data.places[id]; }).sort().forEach(function (name) {
    places.appendChild(el('option', { value: name }));
  });
  $('plan-pace').min = data.pace.min;
  $('plan-pace').max = data.pace.max;
  loadPrintOptions();
  showPrintOptions();
  root.classList.add('plan-ready');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(function (yes) { ui.persisted = !!yes; renderKeepStatus(); }, function () { /* unknown */ });
  }
  render(readLink() ? 'shared-title' : undefined);
  if (state.days.some(function (d) { return d.stay && d.stay.k !== 'c'; })) loadDetails();
}());
