'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../static/camino/js/i18n.js');

function spanish(entries) {
  global.document = { documentElement: { lang: 'es' } };
  global.CAMINO_I18N = { es: entries };
}
function english() {
  global.document = { documentElement: { lang: 'en' } };
  delete global.CAMINO_I18N;
}

test('English text is returned as written, with its values filled in', () => {
  english();
  assert.equal(I18n.t('Rest day in {0}', 'Pamplona'), 'Rest day in Pamplona');
  assert.equal(I18n.t('{n} of {total}', { n: 2, total: 5 }), '2 of 5');
  assert.equal(I18n.t('No values here'), 'No values here');
});

test('Spanish text is used when there is some, and English when there is not', () => {
  spanish({ 'Rest day in {0}': 'Día de descanso en {0}' });
  assert.equal(I18n.t('Rest day in {0}', 'Pamplona'), 'Día de descanso en Pamplona');
  assert.equal(I18n.t('Undo'), 'Undo');
  english();
});

test('Spanish text is found even when the name has a space at the end', () => {
  spanish({ 'Los Arcos to Logroño': 'De Los Arcos a Logroño' });
  assert.equal(I18n.t('Los Arcos to Logroño '), 'De Los Arcos a Logroño');
  english();
});

test('A word with a meaning of its own can have its own Spanish, and falls back to the plain word', () => {
  spanish({ Open: 'Abrir', 'stay fact|Open': 'Apertura' });
  assert.equal(I18n.tc('stay fact', 'Open'), 'Apertura');
  assert.equal(I18n.tc('other', 'Open'), 'Abrir');
  assert.equal(I18n.t('Open'), 'Abrir');
  english();
  assert.equal(I18n.tc('stay fact', 'Open'), 'Open');
});

test('A value that is not given leaves its placeholder visible instead of failing', () => {
  english();
  assert.equal(I18n.t('Day {0} of {1}', 3), 'Day 3 of {1}');
});

test('numbers and addresses follow the language', () => {
  english();
  assert.equal(I18n.num(12.5), '12.5');
  assert.equal(I18n.path('/towns/'), '/towns/');
  assert.equal(I18n.locale(), undefined);
  spanish({});
  assert.equal(I18n.num(12.5), '12,5');
  assert.equal(I18n.path('/towns/'), '/es/towns/');
  assert.equal(I18n.locale(), 'es');
  english();
});

test('the generated Spanish files load, use the same placeholders and translate real phrases', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const dir = path.join(__dirname, '..', 'static', 'camino', 'js');
  const window = {};
  for (const file of ['i18n-es.js', 'i18n-es-plan.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(dir, file), 'utf8'), { window });
  }
  const table = window.CAMINO_I18N.es;
  assert.ok(Object.keys(table).length > 500);
  const holes = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
  for (const [english, text] of Object.entries(table)) {
    assert.equal(holes(text), holes(english), english);
  }
  global.document = { documentElement: { lang: 'es' } };
  global.CAMINO_I18N = window.CAMINO_I18N;
  assert.equal(I18n.t('Rest day in {0}', 'Burgos'), 'Día de descanso en Burgos');
  assert.equal(I18n.t('{0} days', 3), '3 días');
  assert.equal(I18n.t('Hotel or guesthouse'), 'Hotel o pensión');
  assert.equal(I18n.t('All year'), 'Todo el año');
  english();
});
