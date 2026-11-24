/* stay-request.js: "Ask for a bed" on a town page.
 *
 * Each place to stay with a WhatsApp number or an email address has a button that opens a form: arrival date,
 * nights, people, an optional name. The form writes the request in the owner's language (Spanish, or French on the
 * French side of the route) using plan-message.js, the same wording as the planner and the phone app, with an
 * English "what this says" beside it. The visitor can edit the message, then send it from their own WhatsApp or
 * email program, or copy it. Nothing is sent from here and nothing goes to the site: the name and the number of
 * people are kept in this browser only (shared with the planner).
 *
 * The buttons are plain buttons in the page's HTML, so without this script (or in a browser with no <dialog>) the
 * place's own WhatsApp and email buttons are still there.
 */
(function () {
  'use strict';

  var HELPER_KEY = 'camino-plan-helper-v1';   // the same key as the planner, so the name is asked for once

  function init() {
    var Msg = window.CaminoMessage;
    var dialog = document.getElementById('ask-dialog');
    if (!Msg || !dialog || typeof dialog.showModal !== 'function') {
      // Without the form the buttons would do nothing, so they are left out.
      Array.prototype.forEach.call(document.querySelectorAll('.btn-ask'), function (button) { button.hidden = true; });
      return;
    }

    function $(id) { return document.getElementById(id); }
    // The words in the language of the page (i18n.js); English as written if that script is missing.
    function tr(message) {
      var args = arguments;
      if (window.camT) return window.camT.apply(null, args);
      return message.replace(/\{(\d+)\}/g, function (all, n) { var value = args[Number(n) + 1]; return value === undefined ? all : String(value); });
    }
    function spanishPage() { return !!window.CaminoI18n && window.CaminoI18n.language() === 'es'; }

    var current = null;   // { button, kind, name, d, edited }

    function loadHelper() {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(HELPER_KEY) || 'null'); } catch (error) { saved = null; }
      var people = Math.floor(Number(saved && saved.people));
      return { name: Msg.cleanName(saved && saved.name), people: people >= 1 && people <= Msg.MAX_PEOPLE ? people : 1 };
    }

    function saveHelper() {
      try { localStorage.setItem(HELPER_KEY, JSON.stringify({ name: Msg.cleanName($('ask-name').value), people: wholeNumber($('ask-people').value) || 1 })); } catch (error) { /* it is only a convenience */ }
    }

    function wholeNumber(text) {
      var n = Number(String(text).trim());
      return String(text).trim() !== '' && n === Math.floor(n) ? n : NaN;
    }

    function today() {
      var now = new Date();
      function two(n) { return (n < 10 ? '0' : '') + n; }
      return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate());
    }

    // What the form says now, or what is wrong with it.
    function formNow() {
      var form = {
        language: Msg.languageFor(current.d), arrival: $('ask-date').value, yourName: $('ask-name').value,
        nights: wholeNumber($('ask-nights').value), people: wholeNumber($('ask-people').value),
        room: current.kind === 'p' || (!$('ask-room-row').hidden && $('ask-room').value === 'room') ? 'room' : 'dormitory',
        placeName: current.name
      };
      if (!Msg.parseDate(form.arrival)) form.problem = tr('Choose your arrival date to write the message.');
      else if (!(form.nights >= 1 && form.nights <= Msg.MAX_NIGHTS)) form.problem = tr('Nights must be a whole number from 1 to {0}.', Msg.MAX_NIGHTS);
      else if (!(form.people >= 1 && form.people <= Msg.MAX_PEOPLE)) form.problem = tr('People must be a whole number from 1 to {0}.', Msg.MAX_PEOPLE);
      return form;
    }

    function draftOf(form, channel) {
      return form.problem ? null : Msg.build({
        language: form.language, channel: channel, placeName: form.placeName, arrival: form.arrival,
        nights: form.nights, people: form.people, room: form.room, yourName: form.yourName,
        replyEnglish: !spanishPage()   // a Spanish visitor does not need to ask for English
      });
    }

    function setLink(anchor, href) {
      if (href) { anchor.setAttribute('href', href); anchor.removeAttribute('aria-disabled'); }
      else { anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true'); }
    }

    function say(text, failed) {
      var note = $('ask-status');
      note.hidden = !text;
      note.textContent = text || '';
      note.className = 'ask-status' + (failed ? ' ask-failed' : '');
    }

    // Redraws the message (unless the visitor has changed it) and the buttons that send it.
    function refresh() {
      if (!current) return;
      var d = current.d, form = formNow(), whatsapp = draftOf(form, 'whatsapp'), email = draftOf(form, 'email');
      var text = $('ask-text');
      if (!current.edited) text.value = whatsapp ? whatsapp.body : '';
      $('ask-problem').hidden = !form.problem;
      $('ask-problem').textContent = form.problem || '';
      $('ask-meaning').textContent = whatsapp ? whatsapp.meaning : '';
      // The English meaning is for visitors who do not read the owner's language; a Spanish visitor reads a Spanish message.
      $('ask-meaning-box').hidden = spanishPage() && form.language !== 'fr';
      $('ask-language').textContent = form.language === 'fr' ? tr('This message is in French, the language of the place.') : tr('This message is in Spanish, the language of the place.');
      $('ask-reset').hidden = !current.edited;
      var message = text.value, ready = message.trim() !== '';
      var wa = $('ask-whatsapp'), mail = $('ask-email');
      wa.hidden = !d.wa;
      mail.hidden = !d.em;
      var waLink = null, mailLink = null;
      try { if (d.wa && ready) waLink = Msg.whatsAppLink(d.wa, message); } catch (error) { waLink = null; }
      try { if (d.em && ready) mailLink = Msg.emailLink(d.em, email ? email.subject : '', current.edited || !email ? message : email.body); } catch (error) { mailLink = null; }
      setLink(wa, waLink);
      setLink(mail, mailLink);
      $('ask-copy').disabled = !ready;
    }

    function open(button) {
      var data = button.dataset;
      var d = { wa: data.wa || '', em: data.em || '', lg: data.lg || '' };
      if (!Msg.canAsk(d)) return;
      var kind = data.ask === 'p' ? 'p' : 'a', saved = loadHelper();
      current = { button: button, kind: kind, name: data.name || '', d: d, edited: false };
      $('ask-title').textContent = kind === 'p' ? tr('Ask {0} for a room', current.name) : tr('Ask {0} for a bed', current.name);
      var date = $('ask-date');
      date.min = today();
      date.value = '';
      $('ask-nights').value = '1';
      $('ask-people').value = String(saved.people);
      $('ask-name').value = saved.name;
      $('ask-room-row').hidden = !(kind === 'a' && data.rooms === '1');   // an albergue offers a room only when the guide says it has them
      $('ask-room').value = 'dormitory';
      say('');
      refresh();
      dialog.showModal();
      date.focus();
    }

    function close() { if (dialog.open) dialog.close(); }

    function legacyCopy(field) {
      try { field.focus(); field.select(); return !!document.execCommand('copy'); } catch (error) { return false; }
    }

    function copy() {
      var field = $('ask-text');
      function done(ok) {
        say(ok ? tr('Message copied.') : tr('Could not copy. Select the message and copy it yourself.'), !ok);
        saveHelper();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(field.value).then(function () { done(true); }, function () { done(legacyCopy(field)); });
      } else {
        done(legacyCopy(field));
      }
    }

    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('.btn-ask') : null;
      if (button) { event.preventDefault(); open(button); }
    });
    ['ask-date', 'ask-nights', 'ask-people', 'ask-room', 'ask-name'].forEach(function (id) {
      $(id).addEventListener('input', function () { say(''); refresh(); });
      $(id).addEventListener('change', function () { refresh(); });
    });
    $('ask-text').addEventListener('input', function () { current.edited = true; refresh(); });
    $('ask-reset').addEventListener('click', function () { current.edited = false; refresh(); });
    $('ask-copy').addEventListener('click', copy);
    $('ask-close').addEventListener('click', close);
    // Sending leaves the page for another app; the name and number of people are remembered as it goes.
    $('ask-whatsapp').addEventListener('click', saveHelper);
    $('ask-email').addEventListener('click', saveHelper);
    // Escape and the Close button both end here: remember the name, put the focus back on the button that opened the form.
    dialog.addEventListener('close', function () {
      var button = current ? current.button : null;
      if (current) saveHelper();
      current = null;
      if (button) button.focus();
    });
  }

  // Every script on the page is loaded (in order) before DOMContentLoaded, so plan-message.js and i18n.js are ready by then.
  if (document.readyState === 'complete') init(); else document.addEventListener('DOMContentLoaded', init);
})();
