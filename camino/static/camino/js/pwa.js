/* Registers the service worker, offers updates, and shows an offline notice. */
(function () {
  'use strict';

  function makeBar(className, role) {
    var bar = document.createElement('div');
    bar.className = className;
    bar.setAttribute('role', role);
    bar.hidden = true;
    document.body.appendChild(bar);
    return bar;
  }

  // Offline notice
  function setupOfflineNotice() {
    var bar = makeBar('offline-bar', 'status');
    bar.textContent = "You're offline. Showing pages saved on this device.";
    function refresh() { bar.hidden = navigator.onLine; }
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    refresh();
  }

  // "New version available" prompt
  function showUpdate(worker) {
    if (document.querySelector('.update-banner')) return;
    var bar = makeBar('update-banner', 'status');
    var text = document.createElement('span');
    text.textContent = 'A new version of the guide is available.';
    var update = document.createElement('button');
    update.type = 'button';
    update.textContent = 'Update now';
    update.addEventListener('click', function () {
      update.disabled = true;
      text.textContent = 'Updating…';
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
    var later = document.createElement('button');
    later.type = 'button';
    later.className = 'update-later';
    later.textContent = 'Later';
    later.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(text);
    bar.appendChild(update);
    bar.appendChild(later);
    bar.hidden = false;
  }

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = Boolean(navigator.serviceWorker.controller);
    var reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // The first install also fires this event; only reload when replacing an older worker.
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (registration) {
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdate(registration.waiting);
        }
        registration.addEventListener('updatefound', function () {
          var installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', function () {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdate(installing);
            }
          });
        });
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) registration.update().catch(function () {});
        });
      }).catch(function (error) {
        console.warn('Service worker registration failed:', error);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOfflineNotice);
  } else {
    setupOfflineNotice();
  }
  setupServiceWorker();
})();
