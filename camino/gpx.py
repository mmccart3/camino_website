# camino/gpx.py
"""A stage's route as a GPX file, for GPS apps and watches (Organic Maps, Komoot, Gaia GPS, Garmin and the like).

There is no Django in here, so it can be tested and run on its own: load_route() reads a database cursor and
build_gpx() writes the text of the file. The view (views.stage_gpx) adds the stage's name in the language of the
page and the names of the places along it.

The points are the guide's stored route: the elevation_points of the stage's paths, in walking order. They are the
same line the stage page and the app draw (the page's interactive map uses the sparser track_points, which lie
within about 3 metres of it), and they carry the height of every point.
"""
import math
import re
from xml.sax.saxutils import escape, quoteattr

CREATOR = 'Saint Jean to Santiago'

# XML 1.0 cannot hold most control characters, so a stray one in a name is dropped rather than breaking the file.
_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def _number(value):
    """The value as a finite float, or None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _text(value):
    return escape(_CONTROL.sub('', str(value or '')).strip())


def clean_points(rows):
    """[(latitude, longitude, elevation or None)] from database rows, in the order given.

    Rows without a usable position are left out. A point that is in the very same place as the one before it
    (to the sixth decimal, about 10 cm) is dropped: the paths of a stage are consecutive legs, and the end of one
    leg is sometimes the start of the next.
    """
    points = []
    previous = None
    for row in rows:
        lat, lon = _number(row[0]), _number(row[1])
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        here = (round(lat, 6), round(lon, 6))
        if here == previous:
            continue
        previous = here
        points.append((lat, lon, _number(row[2]) if len(row) > 2 else None))
    return points


def load_route(cursor, stage_id):
    """A stage's route from the database.

    Returns {'points': [(lat, lon, elevation), ...], 'place_ids': [location ids, in walking order]}. The places are
    the start of the first path and the end of every path, which are the places the stage page lists.
    `cursor` can be a Django cursor or a plain sqlite3 one; the stage id is made an int and written into the text,
    because the two kinds write placeholders differently.
    """
    stage_id = int(stage_id)
    cursor.execute(f'SELECT pathID, originLoc, destinationLoc FROM paths WHERE stageID = {stage_id} ORDER BY pathID')
    paths = cursor.fetchall()
    cursor.execute(
        'SELECT e.latitude, e.longitude, e.elevationMetres FROM elevation_points e '
        'JOIN paths p ON p.pathID = e.pathID '
        f'WHERE p.stageID = {stage_id} ORDER BY p.pathID, e.sequence'
    )
    points = clean_points(cursor.fetchall())
    place_ids = []
    for place in ([paths[0][1]] if paths else []) + [row[2] for row in paths]:
        if place and place not in place_ids:
            place_ids.append(place)
    return {'points': points, 'place_ids': place_ids}


def filename(display_ref, stage_id):
    """A safe file name for the download: saint-jean-to-santiago-stage-16b.gpx"""
    part = re.sub(r'[^a-z0-9]+', '-', str(display_ref or '').lower()).strip('-') or str(stage_id)
    return f'saint-jean-to-santiago-stage-{part}.gpx'


def build_gpx(name, points, places=(), page_url=None):
    """The text of a GPX 1.1 file: one track called `name` through `points`, and a waypoint for each place.

    points   [(latitude, longitude, elevation or None), ...], at least two
    places   [(name, latitude, longitude), ...]; one without a usable position is left out
    page_url the guide's page for the stage, written into the file as its link
    """
    if len(points) < 2:
        raise ValueError('a route needs at least two points')
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<gpx version="1.1" creator={quoteattr(CREATOR)} xmlns="http://www.topografix.com/GPX/1/1">',
        '<metadata>',
        f'<name>{_text(name)}</name>',
    ]
    if page_url:
        lines.append(f'<link href={quoteattr(str(page_url))}><text>{_text(CREATOR)}</text></link>')
    lines.append('<bounds minlat="%.6f" minlon="%.6f" maxlat="%.6f" maxlon="%.6f"/>' % (min(lats), min(lons), max(lats), max(lons)))
    lines.append('</metadata>')
    for place_name, lat, lon in places:
        lat, lon = _number(lat), _number(lon)
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        if abs(lat) < 0.001 and abs(lon) < 0.001:
            continue   # the (0, 0) of a place with no position
        lines.append('<wpt lat="%.5f" lon="%.5f"><name>%s</name></wpt>' % (lat, lon, _text(place_name)))
    lines.append(f'<trk><name>{_text(name)}</name><trkseg>')
    for lat, lon, elevation in points:
        if elevation is None:
            lines.append('<trkpt lat="%.6f" lon="%.6f"/>' % (lat, lon))
        else:
            lines.append('<trkpt lat="%.6f" lon="%.6f"><ele>%.1f</ele></trkpt>' % (lat, lon, elevation))
    lines.append('</trkseg></trk>')
    lines.append('</gpx>')
    return '\n'.join(lines) + '\n'
