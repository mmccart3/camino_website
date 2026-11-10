#!/usr/bin/env python3
"""Makes the two files to import into Google My Maps from the guide's database (opened read-only).

    python tool/make_my_maps_files.py                       # camino.sqlite -> ./my_maps_files/
    python tool/make_my_maps_files.py camino.sqlite out_folder

  camino_route.gpx   every stage as one named track (an alternative route is a stage of its own), thinned so that the
                     line stays within 5 metres of the stored track (about 9,500 points instead of about 100,000)
  camino_towns.csv   every place with a position: Name, Latitude, Longitude, Description (the link to its guide page)

The README ("Route map on the town pages") says how to turn them into the map the town pages show. Uses only the
Python standard library.
"""
import csv
import math
import re
import sqlite3
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
TOLERANCE_M = 5.0
SITE = 'https://saintjeantosantiago.com'
PLACEHOLDER_NAME = re.compile(r'^\s*(unassigned|unknown|tbc|todo|placeholder)\b', re.IGNORECASE)


def thin(points, tolerance=TOLERANCE_M):
    """Douglas-Peucker: keeps the points that matter; the thinned line stays within `tolerance` metres of the original."""
    if len(points) < 3:
        return list(points)
    lat0 = points[0][0]
    xy = [(lon * 111320 * math.cos(math.radians(lat0)), lat * 110540) for lat, lon in points]
    keep = [False] * len(xy)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1e-9
        far, at = 0.0, -1
        for i in range(a + 1, b):
            d = abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / length
            if d > far:
                far, at = d, i
        if far > tolerance and at > 0:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [p for p, k in zip(points, keep) if k]


def clean_name(name, ref):
    """The stage name without its own number in front ("16b: Fromista ..." on stage 16b), as the website shows it."""
    text = re.sub(r'^\s*' + re.escape(str(ref)) + r'\s*:\s*', '', name or '', count=1, flags=re.IGNORECASE)
    return text if text.strip() else name


def write_files(db_path, out_dir):
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="Saint Jean to Santiago" xmlns="http://www.topografix.com/GPX/1/1">',
             '<metadata><name>Camino Frances - all stages</name></metadata>']
    stats = {'stages': 0, 'raw': 0, 'kept': 0, 'places': 0}
    for stage_id, name, ref in con.execute('select ID, stageName, stageDisplayReference from stages order by ID').fetchall():
        legs = []
        for (path_id,) in con.execute('select pathID from paths where stageID=? order by pathID', (stage_id,)).fetchall():
            pts = con.execute('select latitude, longitude from elevation_points where pathID=? order by sequence',
                              (path_id,)).fetchall()
            pts = [(lat, lon) for lat, lon in pts if lat is not None and lon is not None]
            stats['raw'] += len(pts)
            pts = thin(pts)
            stats['kept'] += len(pts)
            if pts:
                legs.append(pts)
        if not legs:
            continue
        stats['stages'] += 1
        lines.append('<trk><name>%s</name><trkseg>' % escape(f'Stage {ref}: {clean_name(name, ref)}'))
        for leg in legs:   # the paths of a stage are consecutive legs, so they make one unbroken line
            lines += ['<trkpt lat="%.6f" lon="%.6f"/>' % p for p in leg]
        lines.append('</trkseg></trk>')
    lines.append('</gpx>')
    (out_dir / 'camino_route.gpx').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    with open(out_dir / 'camino_towns.csv', 'w', newline='', encoding='utf-8-sig') as fh:   # the BOM keeps accents right in Excel
        writer = csv.writer(fh)
        writer.writerow(['Name', 'Latitude', 'Longitude', 'Description'])
        for loc_id, name, lat, lon in con.execute('select ID, locationName, latitude, longitude from locations order by ID'):
            if lat is None or lon is None or (abs(lat) < 0.001 and abs(lon) < 0.001) or PLACEHOLDER_NAME.match(name or ''):
                continue   # a holding place such as "Unassigned" is not a place anyone visits
            writer.writerow([name, '%.6f' % lat, '%.6f' % lon, f'{SITE}/location/{loc_id}/'])
            stats['places'] += 1
    con.close()
    return stats


def main(argv):
    db_path = Path(argv[1]) if len(argv) > 1 else ROOT / 'camino.sqlite'
    out_dir = Path(argv[2]) if len(argv) > 2 else Path('my_maps_files')
    stats = write_files(db_path, out_dir)
    print('%(stages)d stages, track points %(raw)d -> %(kept)d, %(places)d places' % stats)
    print('written to', out_dir.resolve())


if __name__ == '__main__':
    main(sys.argv)
