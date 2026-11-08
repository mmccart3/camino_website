/* i18n.js: the words the guide's scripts put on the screen, in the language of the page.
 *
 *   camT('Rest day in {0}', name)         numbered values
 *   camT('{n} of {total}', { n: 2, total: 5 })   named values
 *
 * English is the text written in the script itself. On a Spanish page (<html lang="es">) the text is looked up
 * in window.CAMINO_I18N.es, which static/camino/js/i18n-es.js (and i18n-es-plan.js on the planner page) fill
 * from camino/locale/es.json. A phrase with no Spanish is shown in English. Nothing here talks to the network.
 *
 * It runs in the browser (window.camT, window.CaminoI18n) and in Node tests.
 */
(function (root, factory) {
  // The page (window) in a browser; the global object in Node, where the tests set document and CAMINO_I18N.
  var api = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CaminoI18n = api; root.camT = api.t; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function language() {
    var doc = root.document;
    var lang = doc && doc.documentElement && doc.documentElement.lang;
    return String(lang || 'en').slice(0, 2).toLowerCase();
  }

  function table(lang) {
    var all = root.CAMINO_I18N;
    return (all && all[lang]) || {};
  }

  function lookup(message) {
    var lang = language();
    if (lang === 'en') return message;
    var texts = table(lang);
    // Names in the guide's data sometimes end in a space ("Los Arcos to Logroño "); the catalogue has them without.
    var found = texts[message];
    if (found === undefined && typeof message === 'string') found = texts[message.trim()];
    return typeof found === 'string' && found !== '' ? found : message;
  }

  // {0}, {1} take the extra arguments in order; {name} takes that property of an object passed instead.
  function fill(text, args) {
    var first = args[0];
    var named = args.length === 1 && first !== null && typeof first === 'object' ? first : null;
    return text.replace(/\{(\w+)\}/g, function (all, key) {
      var value = named ? named[key] : args[Number(key)];
      return value === undefined || value === null ? all : String(value);
    });
  }

  function t(message) {
    return fill(lookup(message), Array.prototype.slice.call(arguments, 1));
  }

  // The same English word can need two Spanish words: "Open" on a button, and "Open" as the label of a place's
  // opening dates. tc('stay fact', 'Open') looks for the Spanish of "stay fact|Open" first, then for "Open".
  function tc(context, message) {
    var args = Array.prototype.slice.call(arguments, 2);
    var lang = language();
    var found = lang === 'en' ? undefined : table(lang)[context + '|' + message];
    return fill(typeof found === 'string' && found !== '' ? found : lookup(message), args);
  }

  // A number in text: 12.5 is "12.5" in English and "12,5" in Spanish.
  function num(value) {
    var text = String(value);
    return language() === 'es' ? text.replace('.', ',') : text;
  }

  // The language to give to toLocaleString and friends: the visitor's own setting on an English page (as before),
  // Spanish on a Spanish page.
  function locale() {
    return language() === 'es' ? 'es' : undefined;
  }

  // The address of a page of the guide in the language of this page: '/towns/' is '/es/towns/' in Spanish.
  function path(address) {
    return language() === 'es' ? '/es' + address : address;
  }

  return { t: t, tc: tc, lookup: lookup, fill: fill, num: num, locale: locale, path: path, language: language };
});
