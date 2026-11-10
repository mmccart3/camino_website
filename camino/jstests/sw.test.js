// Tests for the service worker's fetch rules (camino/static/camino/js/sw.js).
// Run with:  node --test camino/jstests/*.test.js
//
// The worker is loaded the way the browser would load it, in an empty context with just enough of the worker's world (self, caches,
// fetch) for it to register its handlers, and the two placeholders Django fills in are filled with plain values.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'static', 'camino', 'js', 'sw.js'), 'utf8');
const ORIGIN = 'https://example.test';

function loadWorker() {
  const handlers = {};
  const cache = { put: async () => {}, match: async () => undefined, keys: async () => [], delete: async () => true };
  const context = {
    self: { location: new URL(ORIGIN + '/'), addEventListener: (type, fn) => { handlers[type] = fn; }, clients: { claim() {} }, skipWaiting() {} },
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [], delete: async () => true },
    fetch: async () => new Response('ok'),
    setTimeout: () => 0,   // the worker's slow-network timer is not needed here
    URL, Request, Response, Headers, Promise, Array, Object, JSON,
  };
  // Django replaces every occurrence of the placeholders (the comment at the top of the file names them too), so this does as well.
  vm.runInNewContext(SOURCE.replaceAll('__VERSION__', 'test').replaceAll('__PRECACHE__', '[]'), context);
  return handlers;
}

// What a browser sends for a click on a link (a navigation: it asks for HTML) or for a file the page uses.
function fetchEvent(urlPath, { mode = 'navigate', accept = 'text/html,application/xhtml+xml,*/*;q=0.8' } = {}) {
  const event = {
    request: { method: 'GET', url: ORIGIN + urlPath, mode, destination: mode === 'navigate' ? 'document' : '', headers: new Headers({ accept }) },
    answered: false,
    respondWith(promise) { this.answered = true; Promise.resolve(promise).catch(() => {}); },
    waitUntil(promise) { Promise.resolve(promise).catch(() => {}); },
  };
  return event;
}

function answered(urlPath, options) {
  const event = fetchEvent(urlPath, options);
  loadWorker().fetch(event);
  return event.answered;
}

test('a GPX download is left to the browser, whichever language page it was on', () => {
  for (const url of ['/stage/1/route.gpx', '/es/stage/1/route.gpx', '/stage/16/route.gpx?download=1']) {
    assert.equal(answered(url), false, url);   // a click on the link is a navigation that asks for HTML: the worker must still stay out
    assert.equal(answered(url, { mode: 'cors', accept: '*/*' }), false, url);
  }
});

test('the worker still answers the pages, in both languages', () => {
  for (const url of ['/', '/stage/1/', '/es/stage/1/', '/location/9/', '/plan/']) {
    assert.equal(answered(url), true, url);
  }
});

test('the worker still answers the site files, and still ignores itself and the offline pack list', () => {
  assert.equal(answered('/static/camino/js/stage-pace.js', { mode: 'no-cors', accept: '*/*' }), true);
  assert.equal(answered('/sw.js'), false);
  assert.equal(answered('/offline-pack.json'), false);
});
