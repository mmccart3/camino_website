/* Light / dark / automatic theme button.
 *
 * The colours themselves are CSS variables in base.html. "Automatic" follows the device (dark mode and
 * high contrast); "light" and "dark" set data-theme on <html> and are remembered in this browser only.
 * A few lines in <head> apply the saved choice before the first paint; this file drives the button and
 * tells scripts that draw with theme colours (the elevation charts, the map line) to redraw.
 */
(function () {
  'use strict';
  var KEY = 'camino-theme';
  var ORDER = ['auto', 'light', 'dark'];
  var root = document.documentElement;

  function saved() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : 'auto';
    } catch (e) { return 'auto'; }
  }

  function announce() {
    if (window.caminoColor && window.caminoColor.reset) window.caminoColor.reset();
    document.dispatchEvent(new CustomEvent('camino:themechange'));
  }

  function apply(mode) {
    if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    try {
      if (mode === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode);
    } catch (e) {}
    announce();
  }

  function show(button, mode) {
    var label = button.getAttribute('data-label-' + mode) || '';
    button.setAttribute('data-mode', mode);
    button.setAttribute('aria-label', label);
    button.title = label;
    var text = button.querySelector('.theme-label');
    if (text) text.textContent = label.replace(/^[^:]*:\s*/, '');
  }

  function start() {
    var button = document.getElementById('theme-toggle');
    if (button) {
      show(button, saved());
      button.hidden = false;
      button.addEventListener('click', function () {
        var next = ORDER[(ORDER.indexOf(button.getAttribute('data-mode')) + 1) % ORDER.length];
        apply(next);
        show(button, next);
      });
    }
    // In automatic mode the device can change theme or contrast while the page is open.
    if (window.matchMedia) {
      ['(prefers-color-scheme: dark)', '(prefers-contrast: more)'].forEach(function (query) {
        var media = window.matchMedia(query);
        if (media.addEventListener) media.addEventListener('change', announce);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
