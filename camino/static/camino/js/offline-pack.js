/* "Save for offline": stores every stage and town page (and optionally the stage maps)
   in the browser so the guide works with no signal. Nothing is sent anywhere. */
(function () {
  'use strict';

  var INFO_KEY = 'camino-pack-info';
  var root = document.getElementById('pack-root');
  if (!root) return;

  var startButton = document.getElementById('pack-start');
  var removeButton = document.getElementById('pack-remove');
  var imagesBox = document.getElementById('pack-images');
  var progress = document.getElementById('pack-progress');
  var status = document.getElementById('pack-status');
  var currentVersion = root.getAttribute('data-version');
  var busy = false;

  function readInfo() {
    try { return JSON.parse(localStorage.getItem(INFO_KEY) || 'null'); } catch (error) { return null; }
  }
  function writeInfo(info) {
    try {
      if (info) localStorage.setItem(INFO_KEY, JSON.stringify(info));
      else localStorage.removeItem(INFO_KEY);
    } catch (error) { /* storage can be blocked; the pack still works */ }
  }
  function say(text) { status.textContent = text; }

  function showSaved() {
    var info = readInfo();
    removeButton.hidden = !info;
    if (!info) { say('Not saved on this device yet.'); return; }
    var when = new Date(info.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    var text = info.pages + ' pages' + (info.images ? ' and ' + info.images + ' maps' : '') + ' saved on ' + when + '.';
    if (info.version !== currentVersion) text += ' The guide has been updated since. Save again to refresh it.';
    say(text);
    startButton.textContent = 'Save again';
  }

  async function savePage(cache, url) {
    var response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok || response.redirected) throw new Error('bad response');
    await cache.put(url, response);
  }

  async function saveImage(cache, url) {
    if (await cache.match(url)) return;
    var response;
    try {
      response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    } catch (error) {
      response = await fetch(url, { mode: 'no-cors' });
    }
    if (!response.ok && response.type !== 'opaque') throw new Error('bad response');
    await cache.put(url, response);
  }

  async function run() {
    if (busy) return;
    if (!('caches' in window)) { say('This browser cannot save pages for offline use.'); return; }
    if (!navigator.onLine) { say('Connect to the internet first, then try again.'); return; }
    busy = true;
    startButton.disabled = true;
    removeButton.hidden = true;
    progress.hidden = false;
    progress.value = 0;
    say('Preparing…');
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      var info = await fetch('/offline-pack.json', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('list unavailable');
        return r.json();
      });
      var cache = await caches.open(info.cache);
      var jobs = info.pages.map(function (url) { return { url: url, image: false }; });
      if (imagesBox.checked) {
        info.images.forEach(function (url) { jobs.push({ url: url, image: true }); });
      }
      progress.max = jobs.length;
      var done = 0, failedPages = 0, savedImages = 0;
      var queue = jobs.slice();

      async function worker() {
        while (queue.length) {
          var job = queue.shift();
          try {
            if (job.image) { await saveImage(cache, job.url); savedImages += 1; }
            else { await savePage(cache, job.url); }
          } catch (error) {
            if (!job.image) failedPages += 1;
          }
          done += 1;
          progress.value = done;
          say('Saving… ' + done + ' of ' + jobs.length);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);

      var savedPages = info.pages.length - failedPages;
      writeInfo({ version: info.version, savedAt: Date.now(), pages: savedPages, images: savedImages });
      showSaved();
      if (failedPages) say(status.textContent + ' ' + failedPages + ' pages could not be saved. Try again later.');
    } catch (error) {
      say('Could not finish saving. Check your connection and try again.');
    } finally {
      busy = false;
      startButton.disabled = false;
      progress.hidden = true;
      removeButton.hidden = !readInfo();
    }
  }

  async function remove() {
    if (busy) return;
    if ('caches' in window) await caches.delete('camino-pack');
    writeInfo(null);
    startButton.textContent = 'Save for offline';
    showSaved();
  }

  startButton.addEventListener('click', run);
  removeButton.addEventListener('click', remove);
  showSaved();
})();
