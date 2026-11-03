/* qr.js: a small QR code generator for the plan page.
 *
 * Byte mode only (the plan code is a URL), versions 1 to 40, all four error-correction levels.
 * It draws nothing by itself: encode() returns the grid of modules, toSvg() and toCanvas() show it.
 * The same file runs in the browser (window.CaminoQR) and in Node tests, where its output is
 * decoded with an independent QR reader (see camino/jstests/qr.test.js and docs).
 *
 * The method is the one in ISO/IEC 18004: Reed-Solomon codewords per block, blocks interleaved,
 * function patterns, zig-zag placement, the mask with the lowest penalty.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaminoQR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LEVELS = ['L', 'M', 'Q', 'H'];           // the order of the tables below
  var FORMAT_BITS = [1, 0, 3, 2];              // L, M, Q, H as the format information writes them

  // Error-correction codewords in each block, and the number of blocks, by level then version.
  // Index 0 is padding: versions start at 1.
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  // ---------------------------------------------------------------- sizes

  function rawDataModules(version) {
    var result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      var align = Math.floor(version / 7) + 2;
      result -= (25 * align - 10) * align - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(version, level) {
    return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[level][version] * NUM_BLOCKS[level][version];
  }

  // How many bytes of text fit in a version at a level (byte mode: 4 bits of mode, 8 or 16 of length).
  function capacity(version, levelName) {
    var level = LEVELS.indexOf(levelName);
    var bits = dataCodewords(version, level) * 8 - 4 - (version < 10 ? 8 : 16);
    var n = Math.floor(bits / 8);
    return version < 10 ? Math.min(n, 255) : n;
  }

  // ---------------------------------------------------------------- Reed-Solomon over GF(256), polynomial 0x11D

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    var result = [], i, j;
    for (i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }

  // ---------------------------------------------------------------- the codewords

  function utf8(text) {
    if (typeof TextEncoder === 'function') return Array.prototype.slice.call(new TextEncoder().encode(text));
    var out = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function appendBits(bits, value, count) {
    for (var i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  function dataBytes(bytes, version, level) {
    var bits = [], capacityBits = dataCodewords(version, level) * 8, i;
    appendBits(bits, 4, 4);                                   // byte mode
    appendBits(bits, bytes.length, version < 10 ? 8 : 16);    // number of bytes
    bytes.forEach(function (b) { appendBits(bits, b, 8); });
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));   // terminator
    appendBits(bits, 0, (8 - bits.length % 8) % 8);                 // to a whole byte
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);
    var out = [];
    for (i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    return out;
  }

  // Splits the data into blocks, adds each block's error-correction codewords, then interleaves them.
  function allCodewords(data, version, level) {
    var blocks = NUM_BLOCKS[level][version], eccLen = ECC_PER_BLOCK[level][version];
    var rawCodewords = Math.floor(rawDataModules(version) / 8);
    var shortBlocks = blocks - rawCodewords % blocks, shortLen = Math.floor(rawCodewords / blocks);
    var divisor = rsDivisor(eccLen), list = [], k = 0, i, j;
    for (i = 0; i < blocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < shortBlocks) dat.push(0);        // a placeholder, skipped when interleaving
      list.push(dat.concat(ecc));
    }
    var result = [];
    for (i = 0; i < list[0].length; i++) {
      for (j = 0; j < blocks; j++) {
        if (i !== shortLen - eccLen || j >= shortBlocks) result.push(list[j][i]);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- the grid

  function alignmentPositions(version) {
    if (version === 1) return [];
    var count = Math.floor(version / 7) + 2, size = version * 4 + 17;
    var step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function Grid(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = [];
    this.fixed = [];
    for (var y = 0; y < this.size; y++) {
      var row = [], fixed = [];
      for (var x = 0; x < this.size; x++) { row.push(false); fixed.push(false); }
      this.modules.push(row);
      this.fixed.push(fixed);
    }
  }

  Grid.prototype.setFunction = function (x, y, dark) {
    this.modules[y][x] = dark;
    this.fixed[y][x] = true;
  };

  Grid.prototype.drawFunctionPatterns = function () {
    var size = this.size, i, j, self = this;
    for (i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) self.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    var pos = alignmentPositions(this.version), n = pos.length;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) this.setFunction(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0, 0);   // reserves the format areas
    this.drawVersion();
  };

  Grid.prototype.drawFormat = function (level, mask) {
    var data = (FORMAT_BITS[level] << 3) | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, size = this.size;
    function bit(n) { return ((bits >>> n) & 1) !== 0; }
    for (i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true);   // the always-dark module
  };

  Grid.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version, i;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;
    for (i = 0; i < 18; i++) {
      var dark = ((bits >>> i) & 1) !== 0, a = this.size - 11 + i % 3, b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  };

  Grid.prototype.drawCodewords = function (data) {
    var i = 0, size = this.size;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (!this.fixed[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  };

  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x, y) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
    function (x, y) { return x * y % 2 + x * y % 3 === 0; },
    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }
  ];

  Grid.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (!this.fixed[y][x] && MASKS[mask](x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  // The penalty rules of the standard: runs of one colour, 2x2 blocks, finder-like patterns, dark balance.
  Grid.prototype.penalty = function () {
    var size = this.size, m = this.modules, score = 0, x, y, i;
    var FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function line(get) {
      var run = 1, i, padded = [false, false, false, false];
      for (i = 0; i < size; i++) padded.push(get(i));
      padded.push(false, false, false, false);
      var result = 0;
      for (i = 1; i < size; i++) {
        if (get(i) === get(i - 1)) run++;
        else { if (run >= 5) result += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) result += 3 + (run - 5);
      for (i = 0; i + 11 <= padded.length; i++) {
        var a = true, b = true;
        for (var k = 0; k < 11; k++) {
          var v = padded[i + k] ? 1 : 0;
          if (v !== FINDER_A[k]) a = false;
          if (v !== FINDER_B[k]) b = false;
        }
        if (a) result += 40;
        if (b) result += 40;
      }
      return result;
    }
    for (y = 0; y < size; y++) score += line(function (i) { return m[y][i]; });
    for (x = 0; x < size; x++) score += line(function (i) { return m[i][x]; });
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
      }
    }
    var dark = 0, total = size * size;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  };

  // ---------------------------------------------------------------- the public functions

  function build(bytes, version, level, forcedMask) {
    var grid = new Grid(version);
    grid.drawFunctionPatterns();
    grid.drawCodewords(allCodewords(dataBytes(bytes, version, level), version, level));
    var best = 0, lowest = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      if (forcedMask !== undefined && mask !== forcedMask) continue;
      grid.applyMask(mask);
      grid.drawFormat(level, mask);
      var p = grid.penalty();
      if (p < lowest) { lowest = p; best = mask; }
      grid.applyMask(mask);   // undo
    }
    grid.applyMask(best);
    grid.drawFormat(level, best);
    return grid;
  }

  // encode(text, { levels: ['M', 'L'], minVersion: 1, boost: true })
  // Tries each level in turn and takes the first at which the text fits in some version (smallest
  // version first). With `boost`, the level goes up for free when the same version has room.
  // Returns { version, level, size, mask-free modules (array of rows of booleans) }, or null if it does not fit.
  function encode(text, options) {
    var opts = options || {}, levels = opts.levels || ['M', 'L'], boost = opts.boost !== false;
    var bytes = typeof text === 'string' ? utf8(text) : Array.prototype.slice.call(text);
    for (var i = 0; i < levels.length; i++) {
      var level = LEVELS.indexOf(levels[i]);
      if (level < 0) throw new Error('unknown error-correction level');
      for (var version = Math.max(1, opts.minVersion || 1); version <= 40; version++) {
        if (bytes.length > capacity(version, levels[i])) continue;
        if (boost) {
          for (var up = 3; up > level; up--) {
            if (bytes.length <= capacity(version, LEVELS[up])) { level = up; break; }
          }
        }
        var grid = build(bytes, version, level, opts.mask);   // `mask` is only for tests
        return { version: version, level: LEVELS[level], size: grid.size, modules: grid.modules };
      }
    }
    return null;
  }

  // An SVG document as text: black modules on white, with the quiet zone the standard asks for (4 modules).
  function toSvg(qr, border) {
    var b = border === undefined ? 4 : border, n = qr.size + 2 * b, path = [], x, y;
    for (y = 0; y < qr.size; y++) {
      for (x = 0; x < qr.size; x++) {
        if (!qr.modules[y][x]) continue;
        var run = 1;
        while (x + run < qr.size && qr.modules[y][x + run]) run++;
        path.push('M' + (x + b) + ',' + (y + b) + 'h' + run + 'v1h-' + run + 'z');
        x += run - 1;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + path.join('') + '" fill="#000"/></svg>';
  }

  // Draws the code on a canvas, `scale` pixels to a module.
  function toCanvas(qr, canvas, scale, border) {
    var b = border === undefined ? 4 : border, s = scale || 8, n = (qr.size + 2 * b) * s;
    canvas.width = n;
    canvas.height = n;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, n, n);
    ctx.fillStyle = '#000';
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) if (qr.modules[y][x]) ctx.fillRect((x + b) * s, (y + b) * s, s, s);
    }
    return canvas;
  }

  return { encode: encode, capacity: capacity, toSvg: toSvg, toCanvas: toCanvas, LEVELS: LEVELS.slice() };
});
