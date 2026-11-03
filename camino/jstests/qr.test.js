// camino/jstests/qr.test.js
// Tests for the QR code generator (camino/static/camino/js/qr.js). No browser needed.
// Run from the project folder with:  node --test
//
// These tests check the sizes, the structure and a few fixed outputs. That the codes really scan was checked
// by decoding them with an independent reader: see qr_decode_check.py in this folder (needs Python with OpenCV).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const QR = require('../static/camino/js/qr.js');

function digest(qr) {
  return crypto.createHash('sha256').update(qr.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('\n')).digest('hex');
}

test('how much text fits matches the standard for the corner cases', () => {
  // versions 1, 10 and 40 in the standard's byte-mode capacity table
  const table = { 1: [17, 14, 11, 7], 10: [271, 213, 151, 119], 40: [2953, 2331, 1663, 1273] };
  Object.keys(table).forEach((v) => ['L', 'M', 'Q', 'H'].forEach((level, i) => {
    assert.strictEqual(QR.capacity(Number(v), level), table[v][i], 'version ' + v + ' ' + level);
  }));
  // a version always holds more than the one before it
  ['L', 'M', 'Q', 'H'].forEach((level) => {
    for (let v = 2; v <= 40; v++) assert.ok(QR.capacity(v, level) > QR.capacity(v - 1, level), level + v);
  });
});

test('the smallest version that fits is used, and the grid has the right shape', () => {
  const small = QR.encode('x'.repeat(14), { levels: ['M'], boost: false });
  assert.deepStrictEqual([small.version, small.level, small.size], [1, 'M', 21]);
  const next = QR.encode('x'.repeat(15), { levels: ['M'], boost: false });
  assert.deepStrictEqual([next.version, next.size], [2, 25]);
  // finder patterns in three corners, none in the fourth; the dark module; timing along row 6
  const m = next.modules, n = next.size;
  [[0, 0], [n - 7, 0], [0, n - 7]].forEach(([x, y]) => {
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      assert.strictEqual(m[y + j][x + i], ring !== 2, 'finder at ' + x + ',' + y);
    }
  });
  assert.strictEqual(m[n - 8][8], true);
  for (let i = 8; i < n - 8; i++) assert.strictEqual(m[6][i], i % 2 === 0);
});

test('the level: M first, L when M does not fit, higher when the same version has room', () => {
  const m = QR.encode('x'.repeat(2331), { levels: ['M', 'L'] });
  assert.deepStrictEqual([m.version, m.level], [40, 'M']);
  const l = QR.encode('x'.repeat(2332), { levels: ['M', 'L'] });
  let smallest = 1;
  while (QR.capacity(smallest, 'L') < 2332) smallest++;
  assert.deepStrictEqual([l.version, l.level], [smallest, 'L']);
  assert.ok(smallest > 30 && smallest < 40);
  assert.strictEqual(QR.encode('x'.repeat(2954), { levels: ['M', 'L'] }), null);
  // 10 bytes need version 1; M holds 14 there, Q holds 11 and H only 7, so it goes up to Q
  assert.strictEqual(QR.encode('x'.repeat(10), { levels: ['M'] }).level, 'Q');
  assert.strictEqual(QR.encode('x'.repeat(10), { levels: ['M'], boost: false }).level, 'M');
  assert.strictEqual(QR.encode('x'.repeat(5), { levels: ['M'] }).level, 'H');
});

test('text is sent as UTF-8', () => {
  const a = QR.encode('é', { levels: ['L'], boost: false });                       // two bytes
  const b = QR.encode(new Uint8Array([0xC3, 0xA9]), { levels: ['L'], boost: false });
  assert.strictEqual(digest(a), digest(b));
  assert.strictEqual(QR.encode('é'.repeat(8), { levels: ['L'], boost: false }).version, 1);   // 16 bytes <= 17
  assert.strictEqual(QR.encode('é'.repeat(9), { levels: ['L'], boost: false }).version, 2);   // 18 bytes
});

test('fixed outputs: these grids were decoded back to their text with an independent reader', () => {
  const cases = [
    ['Hello, Camino!', { levels: ['M'], boost: false }, 1, 'M', '8cabb3b8cf68a303d63de9500f94b700a0cc749386be41334372c39970ca4207'],
    ['https://example.test/plan/#p=AQEjRWcoqk0EVGVzdAOEAWQCCwUMTWFkcmlkYEE', { levels: ['M', 'L'] }, 5, 'M', 'c3910f11a5df9d9117cc6c56cac50cf8b77de492666fa373479b692a190f7147'],
    ['Peregrino été ☀ — Saint-Jean → Santiago ' + 'x'.repeat(120), { levels: ['L'], boost: false }, 8, 'L', 'b1d06fd83acf35aa1017f45c6c5b76d2247295a48c236c42517cd91cd42767e5']
  ];
  cases.forEach(([text, options, version, level, hash]) => {
    const q = QR.encode(text, options);
    assert.deepStrictEqual([q.version, q.level], [version, level]);
    assert.strictEqual(digest(q), hash, text.slice(0, 20));
  });
});

test('the SVG is black on white with a quiet zone of four modules', () => {
  const q = QR.encode('Hello', { levels: ['M'] });
  const svg = QR.toSvg(q);
  const side = q.size + 8;
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + side + ' ' + side + '"'));
  assert.ok(svg.includes('fill="#fff"') && svg.includes('fill="#000"'));
  assert.ok(!/[<>]\s*script/i.test(svg));
  // every dark module is covered by the path and nothing else: count the unit squares it draws
  const path = /<path d="([^"]*)"/.exec(svg)[1];
  let drawn = 0;
  path.replace(/M(\d+),(\d+)h(\d+)v1h-\d+z/g, (all, x, y, len) => { drawn += Number(len); return all; });
  let dark = 0;
  q.modules.forEach((row) => row.forEach((v) => { if (v) dark++; }));
  assert.strictEqual(drawn, dark);
  assert.strictEqual(QR.toSvg(q, 0).includes('viewBox="0 0 ' + q.size + ' ' + q.size + '"'), true);
});
