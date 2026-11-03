"""Checks the QR generator (camino/static/camino/js/qr.js) against an independent reader.

For every version (1 to 40) and every error-correction level it makes a code that exactly fills that
version, draws it, and decodes it with OpenCV. Run from the project folder:

    python camino/jstests/qr_decode_check.py

Needs Node and Python with numpy and opencv-python. Prints the codes that do not decode.

Version 21 at level L is known not to decode in OpenCV, even for codes OpenCV itself makes, so it is reported
but not counted. The planner never uses it: it asks for level M, and L only for text too long for M.
"""
import json, pathlib, subprocess, sys
import numpy as np, cv2

HERE = pathlib.Path(__file__).resolve().parent
QR_JS = (HERE.parent / 'static' / 'camino' / 'js' / 'qr.js').as_posix()
KNOWN = {(21, 'L')}

DUMP = """
const QR = require(%s);
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) %% 2147483648; return seed; }
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/:#=.';
const cases = [];
for (let version = 1; version <= 40; version++) {
  for (const level of ['L', 'M', 'Q', 'H']) {
    const n = QR.capacity(version, level);
    let text = 'https://x.test/plan/#p=';
    while (text.length < n) text += alphabet[rnd() %% alphabet.length];
    text = text.slice(0, n);
    const qr = QR.encode(text, { levels: [level], boost: false });
    cases.push({ version, level, text, size: qr.size, got: [qr.version, qr.level], modules: qr.modules.map(r => r.map(v => v ? 1 : 0).join('')) });
  }
}
console.log(JSON.stringify(cases));
""" % json.dumps(QR_JS)


def main():
    out = subprocess.run(['node', '-e', DUMP], capture_output=True, text=True, check=True).stdout
    cases = json.loads(out)
    detector = cv2.QRCodeDetectorAruco()
    failed = []
    for c in cases:
        n, quiet, scale = c['size'], 4, 8 if c['size'] < 100 else 6
        grid = np.array([[int(ch) for ch in row] for row in c['modules']], dtype=np.uint8)
        img = np.full((n + 2 * quiet, n + 2 * quiet), 255, dtype=np.uint8)
        img[quiet:quiet + n, quiet:quiet + n] = np.where(grid == 1, 0, 255)
        img = np.kron(img, np.ones((scale, scale), dtype=np.uint8))
        text, _, _ = detector.detectAndDecode(img)
        if c['got'] != [c['version'], c['level']] or text != c['text']:
            failed.append((c['version'], c['level']))
    unexpected = [f for f in failed if f not in KNOWN]
    for f in failed:
        print('version %d level %s: %s' % (f[0], f[1], 'does not decode (known)' if f in KNOWN else 'DOES NOT DECODE'))
    print('%d of %d decode%s' % (len(cases) - len(failed), len(cases), '' if not failed else ' (%d unexpected failures)' % len(unexpected)))
    return 1 if unexpected else 0


if __name__ == '__main__':
    sys.exit(main())
