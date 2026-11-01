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
import threading

FORMAT_VERSION = 1
DEFAULT_PACE = 4.2
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

    Returns {'paths': [ids in walking order], 'metres': float, 'weighted': float}.
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
    return {'paths': [p['id'] for p in ordered], 'metres': metres, 'weighted': weighted}


# --- the JSON the page loads -----------------------------------------------------------------

VARIANT_KEYS = {'badge-valley': 'valley', 'badge-mountain': 'mountain', 'badge-alt': 'alt', 'badge-main': 'main'}


def build_planner_data(stages, paths, points_by_path, locations, stays, sections=None):
    """Builds the planner JSON.

    stages:   [{'id', 'name', 'ref', 'start', 'finish'}]
    paths:    [{'id', 'stage', 'origin', 'dest'}]
    points_by_path: {path_id: [{'id', 'prev', 'lat', 'lon', 'ele', 'd3', 'w'}]}
    locations: {id: (name, lat, lon)}
    stays:    [(kind, id, location_id, name)] with kind 0 = albergue, 1 = private
    sections: optional [{'n': 1, 'stages': [ids], 'variants': {id: 'main'|'valley'|'mountain'|'alt'}}]
              giving the guide's own grouping of stages and their variants.
    """
    by_stage = {}
    for path in paths:
        by_stage.setdefault(path['stage'], []).append(path)
    out_stages, skipped = {}, []
    for stage in sorted(stages, key=lambda s: s['id']):
        try:
            totals = stage_totals(stage, by_stage.get(stage['id'], []), points_by_path, locations)
        except RouteData as error:
            skipped.append({'stage': stage['id'], 'reason': str(error)})
            continue
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
    finish_ids = {s['finish'] for s in out_stages.values()}
    used_places = {s['start'] for s in out_stages.values()} | finish_ids
    out_stays = [[kind, ident, loc, name] for (kind, ident, loc, name) in stays if loc in finish_ids]
    out_stays.sort(key=lambda s: (s[2], s[0], (s[3] or '').lower(), s[1]))
    places = {str(i): locations[i][0] for i in used_places if i in locations}
    return {
        'v': FORMAT_VERSION,
        'guide': guide_fingerprint(paths, locations.keys()),
        'flat': FLAT_SLOPE_EFFECT,
        'pace': {'default': DEFAULT_PACE, 'min': 2.0, 'max': 6.0},
        'sections': sorted(clean_sections, key=lambda s: s['n']),
        'stages': out_stages,
        'places': places,
        'stays': out_stays,
        'skipped': skipped,
    }


# --- database access (the only part that needs Django) ----------------------------------------

def load_inputs(cursor):
    """Reads everything build_planner_data needs, with plain SQL (about 30,000 track points)."""
    cursor.execute('SELECT ID, stageName, stageStartLocationID, stageFinishLocationID, stageDisplayReference FROM stages')
    stages = [{'id': r[0], 'name': r[1], 'start': r[2], 'finish': r[3], 'ref': r[4]} for r in cursor.fetchall()]
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
            sections = sections_provider() if sections_provider else None
            data = build_planner_data(stages, paths, points_by_path, locations, stays, sections)
            body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
            _cache.update(key=key, body=body)
        return _cache['body']
