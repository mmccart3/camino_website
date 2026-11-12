/* stay-photos.js: a larger view of a place's photos, on the town page.
 *
 * Each photo on a card is a plain link to the large picture, so without this script (or in a browser without
 * <dialog>) a tap simply opens the picture. With it, the picture opens over the page, with Previous and Next when the
 * place has more than one, and Escape or the Close button to go back. Nothing is loaded until a photo is tapped.
 */
(function () {
  'use strict';
  var viewer = document.getElementById('photo-viewer');
  if (!viewer || typeof viewer.showModal !== 'function') return;
  var image = viewer.querySelector('img');
  var caption = viewer.querySelector('.photo-viewer-caption');
  var previous = viewer.querySelector('[data-step="-1"]');
  var next = viewer.querySelector('[data-step="1"]');
  var links = [], index = 0, opener = null;

  function show(i) {
    index = (i + links.length) % links.length;
    var link = links[index];
    image.src = link.href;
    image.alt = link.querySelector('img').alt;
    caption.textContent = image.alt;
    previous.hidden = next.hidden = links.length < 2;
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('a.stay-photo') : null;
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button) return;
    event.preventDefault();
    opener = link;
    links = Array.prototype.slice.call(link.parentNode.querySelectorAll('a.stay-photo'));
    show(links.indexOf(link));
    viewer.showModal();
  });

  viewer.addEventListener('click', function (event) {
    var step = event.target.closest('[data-step]');
    if (step) { show(index + Number(step.getAttribute('data-step'))); return; }
    // the Close button, or a tap on the dark surround (the dialog itself, not the picture)
    if (event.target.closest('[data-close]') || event.target === viewer) viewer.close();
  });

  viewer.addEventListener('keydown', function (event) {
    if (links.length < 2) return;
    if (event.key === 'ArrowLeft') show(index - 1);
    if (event.key === 'ArrowRight') show(index + 1);
  });

  viewer.addEventListener('close', function () {
    image.removeAttribute('src');   // stop a large picture that is still loading
    if (opener) opener.focus();
  });
})();
