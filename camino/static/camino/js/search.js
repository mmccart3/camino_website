/* Town search on the home page and live filtering on the towns list.
   Works from the page's own data, so it keeps working offline. */
(function () {
  'use strict';

  function normalise(text) {
    return (text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---- Home page: suggestions under the search box -------------------------------------
  function setupSuggestions() {
    var form = document.getElementById('town-search-form');
    var input = document.getElementById('town-search-input');
    var list = document.getElementById('town-suggestions');
    var data = document.getElementById('town-index-data');
    if (!form || !input || !list || !data) return;

    var towns = [];
    try { towns = JSON.parse(data.textContent); } catch (error) { return; }
    var active = -1;
    var matches = [];

    function render() {
      list.innerHTML = '';
      matches.forEach(function (town, index) {
        var item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.id = 'town-option-' + town.id;
        var link = document.createElement('a');
        link.href = town.url;
        link.textContent = town.name;
        var note = document.createElement('span');
        note.className = 'suggest-note';
        note.textContent = town.stays ? town.stays + (town.stays === 1 ? ' place to stay' : ' places to stay') : 'no listed stays';
        link.appendChild(note);
        item.appendChild(link);
        if (index === active) item.className = 'is-active';
        list.appendChild(item);
      });
      list.hidden = matches.length === 0;
      input.setAttribute('aria-expanded', String(matches.length > 0));
      if (active >= 0 && matches[active]) {
        input.setAttribute('aria-activedescendant', 'town-option-' + matches[active].id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function update() {
      var needle = normalise(input.value);
      active = -1;
      if (!needle) { matches = []; render(); return; }
      var starts = [];
      var contains = [];
      towns.forEach(function (town) {
        if (town.norm.indexOf(needle) === 0) starts.push(town);
        else if (town.norm.indexOf(needle) > -1) contains.push(town);
      });
      matches = starts.concat(contains).slice(0, 8);
      render();
    }

    input.addEventListener('input', update);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' && matches.length) {
        event.preventDefault();
        active = (active + 1) % matches.length;
        render();
      } else if (event.key === 'ArrowUp' && matches.length) {
        event.preventDefault();
        active = active <= 0 ? matches.length - 1 : active - 1;
        render();
      } else if (event.key === 'Escape') {
        matches = [];
        render();
      }
    });
    form.addEventListener('submit', function (event) {
      var choice = active >= 0 ? matches[active] : (matches.length === 1 ? matches[0] : null);
      if (choice) {
        event.preventDefault();
        window.location.href = choice.url;
      } else if (!navigator.onLine) {
        event.preventDefault();  // the results page needs a connection; the suggestions do not
      }
    });
    document.addEventListener('click', function (event) {
      if (!form.contains(event.target)) { matches = []; render(); }
    });
  }

  // ---- Towns page: filter the full list ------------------------------------------------
  function setupFilter() {
    var input = document.getElementById('town-filter-input');
    if (!input) return;
    var items = Array.prototype.slice.call(document.querySelectorAll('.town-item'));
    var groups = Array.prototype.slice.call(document.querySelectorAll('.town-group'));
    var empty = document.getElementById('town-filter-empty');

    function apply() {
      var needle = normalise(input.value);
      var shown = 0;
      items.forEach(function (item) {
        var match = !needle || (item.getAttribute('data-norm') || '').indexOf(needle) > -1;
        item.hidden = !match;
        if (match) shown += 1;
      });
      groups.forEach(function (group) {
        group.hidden = !group.querySelector('.town-item:not([hidden])');
      });
      if (empty) empty.hidden = shown > 0;
    }
    input.addEventListener('input', apply);
    apply();
  }

  function init() { setupSuggestions(); setupFilter(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
