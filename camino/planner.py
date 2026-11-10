# camino/planner.py
"""Data for the itinerary planner (/plan/).

The planner lets a visitor build a day-by-day itinerary from guidebook stages. For each stage it
needs the distance and the "weighted distance" the app uses to estimate walking time, worked out
exactly as the app does (lib/services/walking_day.dart and tool/itinerary_file.py in the app
project), so a file made here opens in the app with the same figures.

This module is plain Python with no Django import at the top, so the arithmetic can be tested
on its own. load_inputs() and get_planner_data() are the only functions that touch the database.
"""
import hashlib
import json
import math
import os
import re
import threading

from .stage_names import clean_stage_name

FORMAT_VERSION = 1
DEFAULT_PACE = 4.2
PACE_MIN, PACE_MAX, PACE_STEP = 2.0, 6.0, 0.1   # what the planner's and the stage page's pace sliders offer, in km/h
# lib/services/walking_time.dart: weights are stored for a 7% downhill, so normalise to flat ground.
FLAT_SLOPE_EFFECT = math.exp(-2.25 * 0.07)
EARTH_RADIUS = 6378137.0
MAX_JOIN_GAP = 150.0      # metres between one path's end and the next path's start
MAX_TRACK_GAP = 250.0     # metres between two consecutive track points


class RouteData(Exception):
    """The app would refuse to guide along this stage."""


def haversine(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dphi, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS * math.asin(min(1.0, math.sqrt(h)))


def guide_fingerprint(paths, location_ids):
    """Short hash of the route structure. Matches tool/itinerary_file.py in the app project."""
    h = hashlib.sha256()
    for p in sorted(paths, key=lambda p: p['id']):
        h.update(f"{p['id']},{p['stage']},{p['origin']},{p['dest']};".encode())
    for lid in sorted(location_ids):
        h.update(f'L{lid};'.encode())
    return h.hexdigest()[:16]


# --- lib/data/route_assembler.dart ------------------------------------------------------------

def order_points(rows):
    """Puts one path's track points in order by following previous_track_point_id."""
    by_id = {p['id']: p for p in rows}
    if len(by_id) != len(rows):
        raise RouteData('Duplicate track point IDs.')
    heads = [p for p in rows if p['prev'] not in by_id]
    if len(heads) != 1:
        raise RouteData('Track point chain has missing links or a cycle.')
    following = {}
    for p in rows:
        prior = p['prev']
        if prior is not None and prior in by_id:
            if prior in following:
                raise RouteData(f'Track point chain branches at {prior}.')
            following[prior] = p
    ordered, seen, current = [], set(), heads[0]
    while current is not None:
        if current['id'] in seen:
            raise RouteData('Track point chain contains a cycle.')
        seen.add(current['id'])
        ordered.append(current)
        current = following.get(current['id'])
    if len(ordered) != len(rows):
        raise RouteData('Track point chain is disconnected.')
    return ordered


def order_paths(stage, paths):
    """Orders a stage's paths from its start to its finish. Alternatives are not guessed."""
    if not paths:
        raise RouteData('No paths are available for this stage.')
    result, used, current = [], set(), stage['start']
    while current != stage['finish']:
        candidates = [p for p in paths if p['origin'] == current]
        if not candidates:
            raise RouteData(f'Route is incomplete at location {current}.')
        if len(candidates) != 1:
            raise RouteData(f'Route has multiple paths from location {current}.')
        path = candidates[0]
        if path['id'] in used:
            raise RouteData(f"Route contains a cycle at path {path['id']}.")
        used.add(path['id'])
        result.append(path)
        current = path['dest']
    if len(result) != len(paths):
        raise RouteData('Stage contains disconnected or alternative paths.')
    return result


def _position(point):
    return (point['lat'], point['lon'])


def _usable(point):
    """lib/services/walking_day.dart: a path is only planned across when every point is complete."""
    return (point['ele'] is not None and math.isfinite(point['ele'])
            and point['d3'] is not None and math.isfinite(point['d3']) and point['d3'] >= 0
            and point['w'] is not None and math.isfinite(point['w']) and point['w'] >= 0)


def stage_totals(stage, paths, points_by_path, locations):
    """Distance (metres) and weighted distance for one guidebook stage, as the app saves it.

    Returns {'paths': [ids in walking order], 'metres': float, 'weighted': float,
    'ordered': [(path, its ordered track points)]}.
    Raises RouteData when the app could not plan across the stage.
    """
    tracks = {}
    for path in paths:
        rows = points_by_path.get(path['id'], [])
        for point in rows:
            lat, lon = point['lat'], point['lon']
            if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise RouteData(f"Invalid coordinate in track point {point['id']}.")
        tracks[path['id']] = order_points(rows) if rows else []
    ordered = order_paths(stage, paths)
    ids = {stage['start'], stage['finish']}
    for path in ordered:
        ids.update((path['origin'], path['dest']))
    if any(i not in locations for i in ids):
        raise RouteData('Some route locations are missing from the database.')
    # Whole-stage checks the app makes before it will guide along a stage.
    last = None
    for path in ordered:
        rows = tracks[path['id']]
        if len(rows) < 2:
            raise RouteData(f"Track points are missing for path {path['id']}.")
        if last is not None:
            pred = rows[0]['prev']
            if pred is not None and pred != 0 and pred != last['id']:
                raise RouteData(f"Path {path['id']} does not follow the previous track point chain.")
            if haversine(_position(last), _position(rows[0])) > MAX_JOIN_GAP:
                raise RouteData(f"Track geometry has a gap before path {path['id']}.")
        for i in range(1, len(rows)):
            if haversine(_position(rows[i - 1]), _position(rows[i])) > MAX_TRACK_GAP:
                raise RouteData(f"Path {path['id']} contains a track gap greater than 250 m.")
        if not all(_usable(p) for p in rows):
            raise RouteData(f"Path {path['id']} has incomplete elevation or distance data.")
        last = rows[-1]
    start, finish = locations[stage['start']], locations[stage['finish']]
    first_point, last_point = tracks[ordered[0]['id']][0], tracks[ordered[-1]['id']][-1]
    if (start[1] is None or finish[1] is None
            or haversine((start[1], start[2]), _position(first_point)) > MAX_JOIN_GAP
            or haversine((finish[1], finish[2]), _position(last_point)) > MAX_JOIN_GAP):
        raise RouteData('Track geometry does not reach both declared stage endpoints.')
    # WalkingDayPlanner._calculate: the first point adds nothing, and neither does the first
    # point of a path that does not continue the previous path's track.
    metres = weighted = 0.0
    previous = None
    for n, path in enumerate(ordered):
        rows = tracks[path['id']]
        if previous is not None and rows[0]['prev'] != previous['id']:
            previous = None
        for point in rows:
            if previous is not None:
                if point['prev'] != previous['id']:
                    raise RouteData('Track connection is incomplete.')
                metres += point['d3']
                weighted += point['w']
            previous = point
    return {'paths': [p['id'] for p in ordered], 'metres': metres, 'weighted': weighted,
            'ordered': [(p, tracks[p['id']]) for p in ordered]}


# --- walking between any two places (WalkingDayPlanner.routes and _calculate) --------------------

def path_shape(rows):
    """A short code for a path's line on the map. Two paths with the same code are the same walk,
    so the page can offer it once (the app does the same when it lists routes)."""
    coords = []
    for p in rows:
        c = f"{p['lat']:.6f},{p['lon']:.6f}"
        if not coords or coords[-1] != c:
            coords.append(c)
    return hashlib.sha1(';'.join(coords).encode()).hexdigest()[:8]


def climb_of(heights):
    """Metres climbed and descended along a line of heights, the way the stage pages count them:
    every step up is climb, every other step is descent (camino/views.py, stage_detail)."""
    up = down = 0.0
    for before, after in zip(heights, heights[1:]):
        step = after - before
        if step > 0:
            up += step
        else:
            down -= step
    return up, down


def build_route_graph(legs, elevations=None):
    """What the page needs to join paths into a day of the visitor's own, as the app does.

    legs: [(path, ordered track points)] for every path of every plannable stage.
    elevations: optional {path id: [heights in metres along the path]} from the guide's elevation points.
    Returns {'paths': [[id, origin, dest, stage, distance, weighted, first distance, first weighted, shape,
                        climb, descent, first height, last height]],
             'next':  {path id: [[next path id, 1 if it continues the same track else 0]]}}.
    The last four numbers are left off a path with no heights. A day's climb is its paths' climbs plus
    the step between one path's last height and the next one's first, as on the stage pages.

    A day over several paths adds every point's distance, except that the first point of the day,
    and the first point of a path that starts a different stage's track, add nothing. So a path's
    contribution is its whole total minus its first point unless it continues the track before it.
    """
    out, info, by_origin = [], {}, {}
    for path, rows in legs:
        first, last = rows[0], rows[-1]
        row = [path['id'], path['origin'], path['dest'], path['stage'],
               round(sum(p['d3'] for p in rows), 6), round(sum(p['w'] for p in rows), 6),
               round(first['d3'], 6), round(first['w'], 6), path_shape(rows)]
        heights = (elevations or {}).get(path['id'])
        if heights and len(heights) >= 2:
            up, down = climb_of(heights)
            row += [round(up, 2), round(down, 2), round(heights[0], 2), round(heights[-1], 2)]
        out.append(row)
        info[path['id']] = (path, first, last)
        by_origin.setdefault(path['origin'], []).append(path['id'])
    following = {}
    for pid, (path, first, last) in info.items():
        joins = []
        for other in by_origin.get(path['dest'], []):
            other_path, other_first, _ = info[other]
            same_stage = other_path['stage'] == path['stage']
            if haversine(_position(last), _position(other_first)) > MAX_JOIN_GAP:
                continue
            if same_stage and other_first['prev'] != last['id']:
                continue
            joins.append([other, 1 if same_stage else 0])
        if joins:
            following[str(pid)] = joins
    return {'paths': out, 'next': following}


# --- the JSON the page loads -----------------------------------------------------------------

VARIANT_KEYS = {'badge-valley': 'valley', 'badge-mountain': 'mountain', 'badge-alt': 'alt', 'badge-main': 'main'}


def build_planner_data(stages, paths, points_by_path, locations, stays, sections=None, elevations=None):
    """Builds the planner JSON.

    stages:   [{'id', 'name', 'ref', 'start', 'finish'}]
    paths:    [{'id', 'stage', 'origin', 'dest'}]
    points_by_path: {path_id: [{'id', 'prev', 'lat', 'lon', 'ele', 'd3', 'w'}]}
    locations: {id: (name, lat, lon)}
    stays:    [(kind, id, location_id, name)] with kind 0 = albergue, 1 = private
    sections: optional [{'n': 1, 'stages': [ids], 'variants': {id: 'main'|'valley'|'mountain'|'alt'}}]
              giving the guide's own grouping of stages and their variants.
    elevations: optional {path id: [heights]}; without it the page shows no climb.
    """
    by_stage = {}
    for path in paths:
        by_stage.setdefault(path['stage'], []).append(path)
    out_stages, skipped, legs = {}, [], []
    for stage in sorted(stages, key=lambda s: s['id']):
        try:
            totals = stage_totals(stage, by_stage.get(stage['id'], []), points_by_path, locations)
        except RouteData as error:
            skipped.append({'stage': stage['id'], 'reason': str(error)})
            continue
        legs.extend(totals['ordered'])
        out_stages[str(stage['id'])] = {
            'ref': stage['ref'] or str(stage['id']),
            'name': stage['name'],
            'start': stage['start'],
            'finish': stage['finish'],
            'm': round(totals['metres'], 3),
            'w': totals['weighted'],
            'paths': totals['paths'],
        }
    if sections is None:
        sections = [{'n': i + 1, 'stages': [sid], 'variants': {}}
                    for i, sid in enumerate(sorted(int(k) for k in out_stages))]
    clean_sections = []
    for section in sections:
        ids = [sid for sid in section['stages'] if str(sid) in out_stages]
        if not ids:
            continue
        clean_sections.append({'n': section['n'], 'stages': ids})
        for sid in ids:
            out_stages[str(sid)]['section'] = section['n']
            out_stages[str(sid)]['kind'] = section.get('variants', {}).get(sid, 'main')
    # Stages the sections did not mention still get a section so the page can list them.
    next_n = max([s['n'] for s in clean_sections] or [0]) + 1
    for sid_text, entry in out_stages.items():
        if 'section' not in entry:
            entry['section'], entry['kind'] = next_n, 'main'
            clean_sections.append({'n': next_n, 'stages': [int(sid_text)]})
            next_n += 1
    routes = build_route_graph(legs, elevations)
    used_places = {s['start'] for s in out_stages.values()} | {s['finish'] for s in out_stages.values()}
    for row in routes['paths']:
        used_places.update((row[1], row[2]))
    out_stays = [[kind, ident, loc, name] for (kind, ident, loc, name) in stays if loc in used_places]
    out_stays.sort(key=lambda s: (s[2], s[0], (s[3] or '').lower(), s[1]))
    places = {str(i): locations[i][0] for i in used_places if i in locations}
    return {
        'v': FORMAT_VERSION,
        'guide': guide_fingerprint(paths, locations.keys()),
        'flat': FLAT_SLOPE_EFFECT,
        'pace': {'default': DEFAULT_PACE, 'min': PACE_MIN, 'max': PACE_MAX},
        'sections': sorted(clean_sections, key=lambda s: s['n']),
        'stages': out_stages,
        'places': places,
        'routes': routes,
        'stays': out_stays,
        'skipped': skipped,
    }


# --- database access (the only part that needs Django) ----------------------------------------

def load_elevations(cursor):
    """The guide's elevation points as {path id: [heights in metres]} in order along each path."""
    cursor.execute('SELECT pathID, elevationMetres FROM elevation_points ORDER BY pathID, sequence')
    heights = {}
    for path_id, metres in cursor.fetchall():
        if metres is not None:
            heights.setdefault(path_id, []).append(float(metres))
    return heights


def load_inputs(cursor):
    """Reads everything build_planner_data needs, with plain SQL (about 30,000 track points)."""
    cursor.execute('SELECT ID, stageName, stageStartLocationID, stageFinishLocationID, stageDisplayReference FROM stages')
    stages = [{'id': r[0], 'name': clean_stage_name(r[1], r[4]), 'start': r[2], 'finish': r[3], 'ref': r[4]}
              for r in cursor.fetchall()]
    cursor.execute('SELECT pathID, stageID, originLoc, destinationLoc FROM paths')
    paths = [{'id': r[0], 'stage': r[1], 'origin': r[2], 'dest': r[3]} for r in cursor.fetchall()]
    cursor.execute('SELECT ID, locationName, latitude, longitude FROM locations')
    locations = {r[0]: (r[1], r[2], r[3]) for r in cursor.fetchall()}
    cursor.execute('SELECT track_point_id, pathID, latitude, longitude, elevation, previous_track_point_id, '
                   'distance_3d_meters, "3D-Distance", weighted_distance FROM track_points ORDER BY track_point_id')
    points_by_path = {}
    for r in cursor.fetchall():
        points_by_path.setdefault(r[1], []).append({
            'id': r[0], 'lat': r[2], 'lon': r[3], 'ele': r[4], 'prev': r[5],
            'd3': r[6] if r[6] is not None else r[7], 'w': r[8]})
    cursor.execute('SELECT ID, albergueName, locationID FROM albergues WHERE albergueName IS NOT NULL')
    stays = [(0, r[0], r[2], r[1]) for r in cursor.fetchall()]
    cursor.execute('SELECT ID, privateAccommName, locationID FROM privateAccommDetail WHERE privateAccommName IS NOT NULL')
    stays += [(1, r[0], r[2], r[1]) for r in cursor.fetchall()]
    return stages, paths, points_by_path, locations, stays


_lock = threading.Lock()
_cache = {'key': None, 'body': None}


def get_planner_json(connection, sections_provider=None):
    """The planner JSON as compact text, rebuilt only when the database file changes."""
    name = str(connection.settings_dict['NAME'])
    try:
        stat = os.stat(name)
        key = (name, stat.st_mtime_ns, stat.st_size)
    except OSError:
        key = (name, None, None)
    with _lock:
        if _cache['key'] != key or _cache['body'] is None:
            with connection.cursor() as cursor:
                stages, paths, points_by_path, locations, stays = load_inputs(cursor)
                elevations = load_elevations(cursor)
            sections = sections_provider() if sections_provider else None
            data = build_planner_data(stages, paths, points_by_path, locations, stays, sections, elevations)
            body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
            _cache.update(key=key, body=body)
        return _cache['body']


# --- the details of each place to stay (a second, lazily loaded file) ------------------------------
#
# The planner page carries only the names of the places to stay. The prices, beds, facilities and
# contact links are about 250 KB, so the page loads them from /plan/stays.json the first time it
# needs them and the service worker keeps a copy for use offline. Nothing here affects the guide
# fingerprint, so plans and plan codes made before this file existed still open.

STAY_DETAILS_VERSION = 1
# Words the data uses where a value is missing.
NO_VALUE = {'', 'null', 'none', 'n/a', 'na', 'unknown', '-', 'no website available', 'not on booking',
            'not on booking.com', 'no website', 'none available'}
LIMITS = {'address': 160, 'opening': 400, 'checkin': 250, 'notes': 160, 'url': 300, 'email': 64}
MAX_PRICE = 2000


def clean_text(value, limit):
    """One line of plain text, or None when the field is empty or holds a placeholder."""
    text = ' '.join(str(value if value is not None else '').split())
    if text.lower() in NO_VALUE:
        return None
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '\u2026'


def clean_price(value):
    """A price in euros as a number, or None for blanks, zero (the data's way of saying unknown) and nonsense."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= 0 or number > MAX_PRICE:
        return None
    number = round(number, 2)
    return int(number) if number == int(number) else number


def clean_url(value):
    """The web address, or None unless it is a plain http or https address."""
    text = str(value if value is not None else '').strip()
    if text.lower() in NO_VALUE or len(text) > LIMITS['url'] or re.search(r'\s', text):
        return None
    return text if re.match(r'https?://[^/\s]+', text, re.I) else None


def clean_email_address(value):
    text = str(value if value is not None else '').strip()
    if len(text) > LIMITS['email'] or not re.fullmatch(r'[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+', text):
        return None
    return text


def clean_phone(country_code, number):
    """The telephone number in international form ("+34987123456"), or None when it cannot be told.

    The data keeps the country code apart from the number. A number that already starts with "+"
    or the country code is taken as it is, and a French or British number loses the 0 it is dialled
    with at home.
    """
    raw = str(number if number is not None else '').strip()
    digits = re.sub(r'\D', '', raw)
    if not digits:
        return None
    code = re.sub(r'\D', '', str(country_code if country_code is not None else ''))
    if raw.startswith('+'):
        full = digits
    elif digits.startswith('00') and len(digits) > 10:
        full = digits[2:]
    elif code and len(digits) >= 11 and digits.startswith(code):
        full = digits
    else:
        code = code or ('34' if len(digits) == 9 else '')      # most of the Camino is in Spain
        if not code:
            return None
        full = code + (digits.lstrip('0') if code in ('33', '44') else digits)
    return '+' + full if 8 <= len(full) <= 15 else None


def clean_whatsapp(number):
    """WhatsApp numbers are kept as digits with the country code, ready for https://wa.me/<digits>."""
    digits = re.sub(r'\D', '', str(number if number is not None else ''))
    return digits if 8 <= len(digits) <= 15 else None


def owner_language(country_code, whatsapp, latitude, longitude):
    """'fr' when the owner is better written to in French, else None (Spanish).

    The same rules as helperLanguage in the app (lib/services/booking_message.dart): a WhatsApp number
    that starts with +33, then a calling code of 33, and only when there is no calling code at all,
    a position on the French side of the border (north of 43.10 N and east of 1.35 W).
    """
    digits = re.sub(r'\D', '', str(whatsapp if whatsapp is not None else ''))
    if len(digits) >= 10 and digits.startswith('33'):
        return 'fr'
    code = re.sub(r'\D', '', str(country_code if country_code is not None else ''))
    if code == '33':
        return 'fr'
    if not code:
        try:
            lat, lon = float(latitude), float(longitude)
        except (TypeError, ValueError):
            return None
        if lat > 43.10 and lon > -1.35:
            return 'fr'
    return None


def _flag(value):
    return str(value).strip().lower() in ('1', 'true', 'yes') if value is not None else False


def albergue_details(row):
    """What the page shows for one albergue. Keys that have no value are left out.

    row: id, address, beds, low, high, notes, kitchen, meal, washer, dryer, rooms, opening, checkin,
         country, phone, whatsapp, email, website, booking, lat, lon
    """
    out = {}
    low, high = clean_price(row.get('low')), clean_price(row.get('high'))
    if low:
        out['p'] = low
        if high and high > low:
            out['px'] = high
    try:
        beds = int(row.get('beds') or 0)
    except (TypeError, ValueError):
        beds = 0
    if 0 < beds < 1000:
        out['n'] = beds
    facilities = ''.join(letter for letter, key in (('k', 'kitchen'), ('m', 'meal'), ('w', 'washer'), ('d', 'dryer'), ('r', 'rooms'))
                         if _flag(row.get(key)))
    if facilities:
        out['f'] = facilities
    _common_details(out, row)
    for key, field, limit in (('op', 'opening', 'opening'), ('ci', 'checkin', 'checkin')):
        text = clean_text(row.get(field), LIMITS[limit])
        if text:
            out[key] = text
    return out


def private_details(row):
    """What the page shows for one hotel or guesthouse.

    row: id, address, single, double, notes, country, phone, whatsapp, email, website, booking, lat, lon
    """
    out = {}
    single, double = clean_price(row.get('single')), clean_price(row.get('double'))
    if single:
        out['p'] = single
    if double:
        out['p2'] = double
    _common_details(out, row)
    return out


def _common_details(out, row):
    for key, field, limit in (('ad', 'address', 'address'), ('rn', 'notes', 'notes')):
        text = clean_text(row.get(field), LIMITS[limit])
        if text:
            out[key] = text
    phone = clean_phone(row.get('country'), row.get('phone'))
    if phone:
        out['t'] = phone
    whatsapp = clean_whatsapp(row.get('whatsapp'))
    if whatsapp:
        out['wa'] = whatsapp
    for key, value in (('em', clean_email_address(row.get('email'))), ('web', clean_url(row.get('website'))),
                       ('bk', clean_url(row.get('booking')))):
        if value:
            out[key] = value
    if owner_language(row.get('country'), row.get('whatsapp'), row.get('lat'), row.get('lon')) == 'fr':
        out['lg'] = 'fr'


def build_stay_details(albergues, privates, affiliate=None):
    """The stay-details JSON: {'v', 'aff', 'a': {id: details}, 'p': {id: details}}.

    aff holds the query parameters that go on every Booking.com link (the site's affiliate
    details), once, so they are not repeated about 1,100 times. The page adds them as it makes a link.
    """
    out = {'v': STAY_DETAILS_VERSION, 'aff': dict(affiliate or {}), 'a': {}, 'p': {}}
    for rows, make, key in ((albergues, albergue_details, 'a'), (privates, private_details, 'p')):
        for row in sorted(rows, key=lambda r: r['id']):
            details = make(row)
            if details:
                out[key][str(row['id'])] = details
    return out


def load_stay_rows(cursor):
    """Reads the albergues and private places to stay, with plain SQL."""
    cursor.execute('SELECT ID, albergueStreetAdress, numberOfBeds, onedPersonRateMin, onedPersonRateMax, rateNotes, '
                   'kitchenFacilitiesAvailable, communalMealAvailable, washingMachineAvailable, dryingMachineAvailable, '
                   'privateRoomsAvailable, openingPeriod, checkInTimes, tel1CountryCode, tel1PhoneNumber, whatsAppNumber, '
                   'email, albergueWebsiteURL, albergueBookingDotComURL, gps_lat, gps_lng FROM albergues WHERE albergueName IS NOT NULL')
    names = ('id', 'address', 'beds', 'low', 'high', 'notes', 'kitchen', 'meal', 'washer', 'dryer', 'rooms', 'opening',
             'checkin', 'country', 'phone', 'whatsapp', 'email', 'website', 'booking', 'lat', 'lon')
    albergues = [dict(zip(names, r)) for r in cursor.fetchall()]
    cursor.execute('SELECT ID, privateAccommStreetAdress, onedPersonRateMin, twoPersonRateMin, rateNotes, tel1CountryCode, '
                   'tel1PhoneNumber, whatsAppNumber, email, privateAccommWebsiteURL, privateAccommBookingDotComURL, '
                   'gps_lat, gps_lng FROM privateAccommDetail WHERE privateAccommName IS NOT NULL')
    names = ('id', 'address', 'single', 'double', 'notes', 'country', 'phone', 'whatsapp', 'email', 'website', 'booking',
             'lat', 'lon')
    privates = [dict(zip(names, r)) for r in cursor.fetchall()]
    return albergues, privates


_stay_cache = {'key': None, 'body': None}


def get_stay_details_json(connection, affiliate=None):
    """The stay details as compact text, rebuilt only when the database file changes."""
    name = str(connection.settings_dict['NAME'])
    try:
        stat = os.stat(name)
        key = (name, stat.st_mtime_ns, stat.st_size, json.dumps(affiliate or {}, sort_keys=True))
    except OSError:
        key = (name, None, None, json.dumps(affiliate or {}, sort_keys=True))
    with _lock:
        if _stay_cache['key'] != key or _stay_cache['body'] is None:
            with connection.cursor() as cursor:
                albergues, privates = load_stay_rows(cursor)
            body = json.dumps(build_stay_details(albergues, privates, affiliate), ensure_ascii=False, separators=(',', ':'))
            _stay_cache.update(key=key, body=body)
        return _stay_cache['body']
