#!/usr/bin/env python3
"""Read-only audit of the Camino guide database (the website's camino.sqlite).

    python tool/audit_database.py camino.sqlite                      # report to the screen
    python tool/audit_database.py camino.sqlite --app path/to/app/camino.sqlite
    python tool/audit_database.py camino.sqlite --markdown report.md --json report.json
    python tool/audit_database.py camino.sqlite --spanish camino/locale/es.json   # (found automatically next to the database)

Uses only the Python standard library and opens the database read-only, so it is safe to run at
any time. Findings are ranked:  ERROR  would show wrong or broken content,
WARN  is a data-quality problem worth fixing,  INFO  is a fact worth knowing.
Exit status: 0 when there are no ERROR findings, 1 otherwise.
"""
import argparse
import json
import math
import os
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict

EXAMPLES = 6
FINDINGS = []


def add(area, severity, title, count=None, examples=None, note=None):
    FINDINGS.append({'area': area, 'severity': severity, 'title': title, 'count': count,
                     'examples': [str(e) for e in (examples or [])][:EXAMPLES], 'note': note})


def ok(area, title):
    add(area, 'OK', title)


def connect(path):
    con = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    con.row_factory = sqlite3.Row
    return con


def rows(con, sql, *params):
    return con.execute(sql, params).fetchall()


def scalar(con, sql, *params):
    return con.execute(sql, params).fetchone()[0]


def norm(text):
    text = unicodedata.normalize('NFKD', str(text or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def blank(v):
    return v is None or str(v).strip() == '' or str(v).strip().upper() == 'NULL'


# A route box that comfortably holds Saint-Jean-Pied-de-Port to Santiago (and a little beyond).
LAT_RANGE, LON_RANGE = (41.9, 43.7), (-9.4, -0.9)


def in_box(lat, lon):
    return lat is not None and lon is not None and LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]


def tables(con):
    return [r[0] for r in rows(con, "select name from sqlite_master where type='table' and name not like 'sqlite_%'")]


# --------------------------------------------------------------------------------------------
def check_integrity(con):
    a = 'Integrity'
    res = scalar(con, 'pragma integrity_check')
    (ok if res == 'ok' else lambda *x: add(a, 'ERROR', 'SQLite integrity_check: ' + res))(a, 'SQLite integrity_check passes')
    fk = rows(con, 'pragma foreign_key_check')
    if fk:
        by = Counter(r[0] for r in fk)
        add(a, 'INFO', 'PRAGMA foreign_key_check reports rows (SQLite checks the declared keys only; the data tables declare none)',
            len(fk), ['%s: %d' % kv for kv in by.most_common()])
    names = tables(con)
    data_tables = ['stages', 'locations', 'albergues', 'privateAccommDetail', 'paragraphs', 'mapLocationCoords', 'paths', 'track_points']
    no_unique = []
    for t in data_tables:
        key = 'pathID' if t == 'paths' else 'track_point_id' if t == 'track_points' else 'ID'
        unique = False
        for idx in rows(con, 'pragma index_list("%s")' % t):
            if idx['unique']:
                cols = [c['name'] for c in rows(con, 'pragma index_info("%s")' % idx['name'])]
                if cols == [key]:
                    unique = True
        pk = [c['name'] for c in rows(con, 'pragma table_info("%s")' % t) if c['pk']]
        if not unique and pk != [key]:
            no_unique.append(t)
    if no_unique:
        add(a, 'WARN', 'Tables whose ID column is neither a primary key nor unique (SQLite will not stop duplicate IDs)',
            len(no_unique), no_unique)
    for t in data_tables:
        key = 'pathID' if t == 'paths' else 'track_point_id' if t == 'track_points' else 'ID'
        dup = rows(con, 'select "%s" k, count(*) n from "%s" group by "%s" having n > 1' % (key, t, key))
        if dup:
            add(a, 'ERROR', 'Duplicate IDs in ' + t, len(dup), ['%s=%s (x%d)' % (key, d['k'], d['n']) for d in dup])
        nulls = scalar(con, 'select count(*) from "%s" where "%s" is null' % (t, key))
        if nulls:
            add(a, 'ERROR', 'NULL IDs in ' + t, nulls)
    django = [t for t in names if t.startswith('auth_') or t.startswith('django_')]
    if django:
        used = {t: scalar(con, 'select count(*) from "%s"' % t) for t in django}
        add(a, 'INFO', 'Leftover Django tables (the site no longer installs auth, admin or sessions)', len(django),
            ['%s (%d rows)' % kv for kv in used.items()],
            'Harmless, but they are dead weight and django_migrations records only the migrations that created them.')


def check_references(con):
    a = 'Links between tables'
    rels = [
        ('paths', 'stageID', 'stages', 'ID', False),
        ('paths', 'originLoc', 'locations', 'ID', False),
        ('paths', 'destinationLoc', 'locations', 'ID', False),
        ('stages', 'stageStartLocationID', 'locations', 'ID', True),
        ('stages', 'stageFinishLocationID', 'locations', 'ID', True),
        ('stages', 'priorStage', 'stages', 'ID', True),
        ('stages', 'altPriorStage', 'stages', 'ID', True),
        ('stages', 'nextStage', 'stages', 'ID', True),
        ('stages', 'altNextStage', 'stages', 'ID', True),
        ('locations', 'priorLoc', 'locations', 'ID', True),
        ('locations', 'nextLoc', 'locations', 'ID', True),
        ('locations', 'altPriorLoc', 'locations', 'ID', True),
        ('locations', 'altNextLoc', 'locations', 'ID', True),
        ('albergues', 'locationID', 'locations', 'ID', False),
        ('privateAccommDetail', 'locationID', 'locations', 'ID', False),
        ('paragraphs', 'locationID', 'locations', 'ID', False),
        ('mapLocationCoords', 'stageId', 'stages', 'ID', False),
        ('mapLocationCoords', 'locationId', 'locations', 'ID', False),
        ('elevation_points', 'pathID', 'paths', 'pathID', False),
        ('track_points', 'pathID', 'paths', 'pathID', False),
        ('track_points', 'previous_track_point_id', 'track_points', 'track_point_id', True),
        ('locationFacilities', 'locationID', 'locations', 'ID', False),
        ('waterRouteLinks', 'pathId', 'paths', 'pathID', False),
        ('waterRouteLinks', 'waterId', 'waterPoints', 'id', False),
    ]
    bad = 0
    for child, col, parent, pcol, optional in rels:
        cond = '(c."%s" is not null and c."%s" != 0)' % (col, col) if optional else 'c."%s" is not null' % col
        q = ('select c."%s" v, count(*) n from "%s" c where %s and c."%s" not in (select "%s" from "%s" where "%s" is not null) group by c."%s"'
             % (col, child, cond, col, pcol, parent, pcol, col))
        found = rows(con, q)
        nulls = 0 if optional else scalar(con, 'select count(*) from "%s" where "%s" is null' % (child, col))
        if found:
            bad += 1
            add(a, 'ERROR', '%s.%s points at %s rows that do not exist' % (child, col, parent), sum(f['n'] for f in found),
                ['%s=%s (x%d)' % (col, f['v'], f['n']) for f in found])
        if nulls:
            bad += 1
            add(a, 'ERROR', '%s.%s is empty' % (child, col), nulls)
    if not bad:
        ok(a, 'Every link between tables points at a row that exists (%d relations checked)' % len(rels))


def check_graph(con):
    a = 'Route structure'
    stages = {r['ID']: r for r in rows(con, 'select * from stages')}
    locs = {r['ID']: r for r in rows(con, 'select * from locations')}
    asym = []
    for sid, s in stages.items():
        for col, back in (('nextStage', ('priorStage', 'altPriorStage')), ('altNextStage', ('priorStage', 'altPriorStage'))):
            nid = s[col]
            if nid and nid in stages and sid not in (stages[nid][back[0]], stages[nid][back[1]]):
                asym.append('stage %s %s=%s, but stage %s does not point back' % (sid, col, nid, nid))
    if asym:
        add(a, 'INFO', 'Stage next/previous links that are not mirrored', len(asym), asym,
            'Expected where one route variant leads into the next stage (for example the Valcarlos route, 1c, into stage 2); listed so a typo would stand out.')
    else:
        ok(a, 'Stage next/previous links are mirrored')
    refs = Counter(s['stageDisplayReference'] for s in stages.values() if s['stageDisplayReference'])
    dup = [k for k, v in refs.items() if v > 1]
    if dup:
        add(a, 'ERROR', 'Two stages share a display reference', len(dup), dup)
    missing_ref = [sid for sid, s in stages.items() if blank(s['stageDisplayReference'])]
    if missing_ref:
        add(a, 'WARN', 'Stages with no display reference (the pages fall back to the database ID)', len(missing_ref), missing_ref)
    # a stage's paths should chain from its start to its finish
    paths = defaultdict(list)
    for p in rows(con, 'select * from paths order by pathID'):
        paths[p['stageID']].append(p)
    no_paths = [sid for sid in stages if sid not in paths]
    if no_paths:
        add(a, 'ERROR', 'Stages with no paths (no route, chart or distances)', len(no_paths), no_paths)
    broken, ends, dist, time = [], [], [], []
    for sid, ps in paths.items():
        for x, y in zip(ps, ps[1:]):
            if x['destinationLoc'] != y['originLoc']:
                broken.append('stage %s: path %s ends at %s but path %s starts at %s' % (sid, x['pathID'], x['destinationLoc'], y['pathID'], y['originLoc']))
        s = stages.get(sid)
        if s:
            if s['stageStartLocationID'] and ps[0]['originLoc'] != s['stageStartLocationID']:
                ends.append('stage %s starts at %s, first path starts at %s' % (sid, s['stageStartLocationID'], ps[0]['originLoc']))
            if s['stageFinishLocationID'] and ps[-1]['destinationLoc'] != s['stageFinishLocationID']:
                ends.append('stage %s finishes at %s, last path ends at %s' % (sid, s['stageFinishLocationID'], ps[-1]['destinationLoc']))
            total = sum(p['distance_metres'] or 0 for p in ps)
            if s['stageDistanceInMetres'] and total and abs(total - s['stageDistanceInMetres']) > max(200, 0.02 * s['stageDistanceInMetres']):
                dist.append('stage %s: stage says %d m, its paths add up to %d m' % (sid, s['stageDistanceInMetres'], total))
            secs = sum(p['time_seconds'] or 0 for p in ps)
            if s['stageTimeInMinutes'] and secs and abs(secs / 60 - s['stageTimeInMinutes']) > max(10, 0.15 * s['stageTimeInMinutes']):
                time.append('stage %s: stage says %d min, its paths add up to %d min' % (sid, s['stageTimeInMinutes'], round(secs / 60)))
    for found, title, sev in ((broken, 'Paths inside a stage that do not join up', 'ERROR'), (ends, "Stage start/finish places that disagree with the stage's paths", 'WARN'),
                              (dist, 'Stage distance disagrees with the sum of its paths', 'WARN'), (time, 'Stage time disagrees with the sum of its paths', 'WARN')):
        if found:
            add(a, sev, title, len(found), found)
    # towns
    on_route = set()
    for ps in paths.values():
        for p in ps:
            on_route.add(p['originLoc']); on_route.add(p['destinationLoc'])
    stay_locs = {r[0] for r in rows(con, 'select locationID from albergues union select locationID from privateAccommDetail')}
    para_locs = {r[0] for r in rows(con, 'select locationID from paragraphs')}
    hot_locs = {r[0] for r in rows(con, 'select locationId from mapLocationCoords')}
    lonely = [l for l in locs if l not in on_route and l not in stay_locs and l not in para_locs and l not in hot_locs]
    if lonely:
        add(a, 'WARN', 'Towns that nothing refers to (no path, stay, paragraph or map hotspot)', len(lonely), ['%s %s' % (l, locs[l]['locationName']) for l in lonely])
    empty = [l for l in locs if l not in stay_locs and l not in para_locs]
    add(a, 'INFO', 'Towns with no stays and no text (their pages are left out of the sitemap)', len(empty), ['%s %s' % (l, locs[l]['locationName']) for l in empty],
        '%d of %d towns have a stay or text.' % (len(locs) - len(empty), len(locs)))
    jump = []
    for lid, l in locs.items():
        for col in ('nextLoc',):
            n = l[col]
            if n and n in locs and locs[n]['latitude'] is not None and l['latitude'] is not None:
                d = haversine(num(l['latitude']), num(l['longitude']), num(locs[n]['latitude']), num(locs[n]['longitude']))
                if d > 40000:
                    jump.append('%s -> %s: %.0f km apart' % (l['locationName'], locs[n]['locationName'], d / 1000))
    if jump:
        add(a, 'WARN', 'Neighbouring towns that are very far apart (check the order or the coordinates)', len(jump), jump)
    mirror = []
    for lid, l in locs.items():
        n = l['nextLoc']
        if n and n in locs and lid not in (locs[n]['priorLoc'], locs[n]['altPriorLoc']):
            mirror.append('%s next=%s, but %s does not point back' % (l['locationName'], n, locs[n]['locationName']))
    if mirror:
        add(a, 'INFO', 'Town next/previous links that are not mirrored', len(mirror), mirror)


PLACEHOLDER_TEXT = {'null', 'not on booking', 'no website available', 'n/a', 'none', '-'}


def placeholder_town_ids(con):
    """Towns that stand in for 'not yet assigned': named Unassigned/Unknown, or sitting at 0,0."""
    out = set()
    for l in rows(con, 'select ID, locationName, latitude, longitude from locations'):
        if re.match(r'^\s*(unassigned|unknown|tbc|todo|placeholder)\b', l['locationName'] or '', re.I) or (num(l['latitude']) is not None and abs(num(l['latitude'])) < 0.01 and abs(num(l['longitude'])) < 0.01):
            out.add(l['ID'])
    return out


def check_stays(con):
    a = 'Places to stay'
    locs = {r['ID']: r for r in rows(con, 'select * from locations')}
    placeholders = placeholder_town_ids(con)
    kinds = (('albergues', 'albergueName', 'albergueStreetAdress', 'albergueWebsiteURL', 'albergueBookingDotComURL', 'Hostel'),
             ('privateAccommDetail', 'privateAccommName', 'privateAccommStreetAdress', 'privateAccommWebsiteURL', 'privateAccommBookingDotComURL', 'Private'))
    names_seen = defaultdict(list)
    for table, ncol, acol, wcol, bcol, kind in kinds:
        data = rows(con, 'select * from "%s"' % table)
        label = lambda r: '%s %s "%s"' % (kind, r['ID'], r[ncol])
        add(a, 'INFO', '%s: %d rows' % (table, len(data)))
        noname = [r['ID'] for r in data if blank(r[ncol])]
        if noname:
            add(a, 'ERROR', table + ': stays with no name', len(noname), noname)
        sp = [label(r) for r in data if r[ncol] and (r[ncol] != r[ncol].strip() or '  ' in r[ncol])]
        if sp:
            add(a, 'WARN', table + ': names with stray spaces', len(sp), sp)
        for r in data:
            names_seen[(r['locationID'], norm(r[ncol]))].append(label(r))
        # GPS
        nogps = [r for r in data if num(r['gps_lat']) is None or num(r['gps_lng']) is None]
        zero = [r for r in data if num(r['gps_lat']) == 0 or num(r['gps_lng']) == 0]
        outside = [r for r in data if num(r['gps_lat']) not in (None, 0) and num(r['gps_lng']) not in (None, 0) and not in_box(num(r['gps_lat']), num(r['gps_lng']))]
        far, mid = [], []
        for r in data:
            lat, lng = num(r['gps_lat']), num(r['gps_lng'])
            loc = locs.get(r['locationID'])
            if r['locationID'] in placeholders:
                continue
            if in_box(lat, lng) and loc and num(loc['latitude']) is not None:
                d = haversine(lat, lng, num(loc['latitude']), num(loc['longitude']))
                if d > 10000:
                    far.append('%s is %.1f km from %s' % (label(r), d / 1000, loc['locationName']))
                elif d > 3000:
                    mid.append('%s is %.1f km from %s' % (label(r), d / 1000, loc['locationName']))
        add(a, 'INFO', '%s: %d of %d have no GPS position (their Google Maps button is hidden)' % (table, len(nogps), len(data)), len(nogps), ['%s' % label(r) for r in nogps])
        if zero:
            add(a, 'ERROR', table + ': GPS position of zero (0, 0)', len(zero), [label(r) for r in zero])
        parked = [r for r in data if r['locationID'] in placeholders]
        if parked:
            add(a, 'INFO', '%s: %d stays are held under the placeholder town (%s): places off the route, listed on that town\'s own page and in no real town' % (table, len(parked), ', '.join(locs[i]['locationName'] for i in placeholders)),
                len(parked), [label(r) for r in parked])
        if outside:
            add(a, 'ERROR', table + ': GPS position outside the Camino area (swapped or mistyped?)', len(outside), ['%s (%s, %s)' % (label(r), r['gps_lat'], r['gps_lng']) for r in outside])
        if far:
            add(a, 'ERROR', table + ': GPS position more than 10 km from its town', len(far), far)
        if mid:
            add(a, 'WARN', table + ': GPS position 3 to 10 km from its town', len(mid), mid)
        same = Counter((num(r['gps_lat']), num(r['gps_lng'])) for r in data if num(r['gps_lat']) is not None)
        shared = [(k, v) for k, v in same.items() if v > 2]
        if shared:
            add(a, 'WARN', table + ': three or more stays share exactly the same GPS point (placeholder?)', sum(v for k, v in shared), ['%s x%d' % kv for kv in shared])
        # contact details
        bad_mail = [label(r) + ' "%s"' % r['email'] for r in data if not blank(r['email']) and '@' not in str(r['email'])]
        null_text = [label(r) + ' ' + c for r in data for c in r.keys() if isinstance(r[c], str) and r[c].strip().lower() in PLACEHOLDER_TEXT and c not in (wcol, bcol, 'email')]
        real = lambda v: not blank(v) and str(v).strip().lower() not in PLACEHOLDER_TEXT
        bad_web = [label(r) + ' "%s"' % r[wcol] for r in data if real(r[wcol]) and not str(r[wcol]).strip().lower().startswith(('http://', 'https://'))]
        space_web = [label(r) for r in data if real(r[wcol]) and re.search(r'\s', str(r[wcol]).strip())]
        bad_book = [label(r) + ' "%s"' % r[bcol] for r in data if real(r[bcol]) and not str(r[bcol]).strip().lower().startswith(('http://', 'https://'))]
        ph_counts = Counter()
        for r in data:
            for c in (wcol, bcol, 'email'):
                if isinstance(r[c], str) and r[c].strip().lower() in PLACEHOLDER_TEXT:
                    ph_counts['%s = "%s"' % (c, r[c].strip())] += 1
        if ph_counts:
            add(a, 'INFO', '%s: placeholder text used instead of leaving a field empty (the site treats these as "none")' % table, sum(ph_counts.values()), ['%s: %d' % kv for kv in ph_counts.most_common()],
                'If a new page or the app ever prints these fields without the same checks, the words would show.')
        notbooking = [label(r) + ' %s' % r[bcol] for r in data if not blank(r[bcol]) and str(r[bcol]).lower().startswith('http') and 'booking.com' not in str(r[bcol]).lower()]
        for found, title, sev in ((bad_mail, 'e-mail without an @', 'WARN'), (bad_web, 'website that does not start with http(s)://', 'WARN'),
                                  (space_web, 'website address containing a space', 'WARN'), (bad_book, 'Booking.com link that does not start with http(s)://', 'WARN'),
                                  (notbooking, 'Booking.com link that is not on booking.com', 'WARN'), (null_text, 'placeholder text such as "NULL" or "N/A" in another field', 'WARN')):
            if found:
                add(a, sev, '%s: %s' % (table, title), len(found), found)
        urls = Counter(str(r[bcol]).split('?')[0].lower() for r in data if not blank(r[bcol]) and str(r[bcol]).lower().startswith('http'))
        dupurl = [(k, v) for k, v in urls.items() if v > 1]
        if dupurl:
            add(a, 'WARN', table + ': one Booking.com page used by more than one stay', len(dupurl), ['%s x%d' % kv for kv in dupurl])
        # phones: stored as integers, so a leading zero is lost
        badphone, nocc = [], []
        for r in data:
            ph = r['tel1PhoneNumber']
            if ph in (None, ''):
                continue
            digits = re.sub(r'\D', '', str(ph))
            cc = r['tel1CountryCode']
            if cc in (None, ''):
                nocc.append(label(r)); continue
            want = {34: 9, 33: 9, 351: 9, 44: 10}.get(int(cc))
            if want and len(digits) != want:
                badphone.append('%s +%s %s' % (label(r), cc, digits))
        if badphone:
            add(a, 'WARN', table + ': phone number length does not fit its country code', len(badphone), badphone)
        if nocc:
            add(a, 'WARN', table + ': a phone number with no country code', len(nocc), nocc)
        badwa = []
        for r in data:
            wa = r['whatsAppNumber']
            if wa in (None, '', 0):
                continue
            digits = re.sub(r'\D', '', str(wa))
            if not (re.match(r'^(34|33)\d{9}$', digits) or re.match(r'^351\d{9}$', digits) or re.match(r'^44\d{10}$', digits)):
                badwa.append('%s %s' % (label(r), wa))
        if badwa:
            add(a, 'WARN', table + ': WhatsApp number that does not look like country code + number', len(badwa), badwa)
        # prices
        price_cols = [c for c in ('onedPersonRateMin', 'onedPersonRateMax', 'twoPersonRateMin', 'twodPersonRateMax') if c in data[0].keys()]
        neg = [label(r) for r in data if any((num(r[c]) is not None and num(r[c]) < 0) for c in price_cols)]
        zeros = [r for r in data if any(num(r[c]) == 0 for c in price_cols)]
        if zeros:
            add(a, 'INFO', '%s: %d stays store a price of 0 in some price column (the pages read 0 as "no price")' % (table, len(zeros)), len(zeros),
                note='Most are a zero two-person price beside a real single price.')
        inverted = [label(r) for r in data if num(r['onedPersonRateMin']) is not None and num(r['onedPersonRateMax']) is not None and num(r['onedPersonRateMin']) > num(r['onedPersonRateMax'])]
        cap = 120 if table == 'albergues' else 400
        high = ['%s %s' % (label(r), r['onedPersonRateMin']) for r in data if num(r['onedPersonRateMin']) is not None and num(r['onedPersonRateMin']) > cap]
        noprice = [r for r in data if (num(r['onedPersonRateMin']) or 0) <= 0 and (num(r['twoPersonRateMin'] if 'twoPersonRateMin' in r.keys() else None) or 0) <= 0]
        for found, title, sev in ((neg, 'a negative price', 'ERROR'), (inverted, 'lowest single price above the highest', 'WARN'), (high, 'a lowest single price over %d euros' % cap, 'WARN')):
            if found:
                add(a, sev, '%s: %s' % (table, title), len(found), found)
        add(a, 'INFO', '%s: %d of %d show no price on their card (blank or 0)' % (table, len(noprice), len(data)), len(noprice))
        photos = sum(1 for r in data if table == 'albergues' and any(not blank(r['alberguepic%dURL' % i]) for i in range(1, 5)))
        if table == 'albergues':
            add(a, 'INFO', 'albergues: %d have a photo link; 0 means the photo gallery code never runs' % photos)
            beds = [r for r in data if r['numberOfBeds'] is not None]
            badbeds = ['%s %s beds' % (label(r), r['numberOfBeds']) for r in beds if r['numberOfBeds'] <= 0 or r['numberOfBeds'] > 300]
            dorm = ['%s %s dorms for %s beds' % (label(r), r['numberOfDorms'], r['numberOfBeds']) for r in beds if r['numberOfDorms'] and r['numberOfDorms'] > r['numberOfBeds']]
            if badbeds:
                add(a, 'WARN', 'albergues: a bed count of zero or over 300', len(badbeds), badbeds)
            if dorm:
                add(a, 'WARN', 'albergues: more dorms than beds', len(dorm), dorm)
            privrooms = [label(r) for r in data if r['privateRoomsAvailable'] is None]
            add(a, 'INFO', 'albergues: %d have private rooms unknown (NULL)' % len(privrooms), len(privrooms))
    dups = [(k, v) for k, v in names_seen.items() if len(v) > 1]
    if dups:
        add(a, 'WARN', 'Two stays in the same town with the same name', len(dups), [' | '.join(v) for k, v in dups])
    else:
        ok(a, 'No two stays in one town share a name')
    total = sum(scalar(con, 'select count(*) from %s' % t) for t in ('albergues', 'privateAccommDetail'))
    add(a, 'INFO', 'Total places to stay: %d' % total)


def check_text(con):
    a = 'Text'
    pars = rows(con, 'select * from paragraphs')
    types = Counter(p['paragraphType'] for p in pars)
    add(a, 'INFO', 'Paragraph types', len(pars), ['%s: %d' % kv for kv in types.most_common()])
    empty = [p['ID'] for p in pars if blank(p['paragraphText'])]
    if empty:
        add(a, 'ERROR', 'Paragraphs with no text', len(empty), empty)
    html = [p['ID'] for p in pars if re.search(r'<[a-zA-Z/][^>]*>', p['paragraphText'] or '')]
    if html:
        add(a, 'INFO', 'Paragraphs containing HTML tags (the pages escape them, so they would show as text)', len(html), html)
    moji = []
    for table, cols in (('paragraphs', ['paragraphText', 'paragraphTextEs']), ('albergues', ['albergueName', 'albergueStreetAdress', 'rateNotes', 'openingPeriod', 'checkInTimes']),
                        ('privateAccommDetail', ['privateAccommName', 'privateAccommStreetAdress', 'rateNotes']), ('locations', ['locationName']), ('stages', ['stageName'])):
        for r in rows(con, 'select * from "%s"' % table):
            for c in cols:
                v = r[c]
                if isinstance(v, str) and re.search(r'Ã[\x80-\xbf¡-¿]|â€|Â[\xa0-\xbf]|�', v):
                    moji.append('%s %s.%s' % (table, r['ID'], c))
    if moji:
        add(a, 'ERROR', 'Garbled accents (text saved in the wrong encoding)', len(moji), moji)
    else:
        ok(a, 'No garbled accents (mojibake) found in names or text')
    ctrl = []
    for table in ('paragraphs', 'albergues', 'privateAccommDetail', 'locations', 'stages'):
        for r in rows(con, 'select * from "%s"' % table):
            for c in r.keys():
                v = r[c]
                if isinstance(v, str) and re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', v):
                    ctrl.append('%s %s.%s' % (table, r['ID'], c))
    if ctrl:
        add(a, 'WARN', 'Control characters inside text', len(ctrl), ctrl)
    es_missing = [p['ID'] for p in pars if blank(p['paragraphTextEs'])]
    add(a, 'INFO', 'Paragraphs with no Spanish text (paragraphTextEs): %d of %d' % (len(es_missing), len(pars)), len(es_missing),
        note='The website does not use paragraphTextEs, so this only matters to the app.')
    same = [p['ID'] for p in pars if p['paragraphTextEs'] and p['paragraphTextEs'] == p['paragraphText']]
    if same:
        add(a, 'WARN', 'Spanish paragraph identical to the English one (not translated?)', len(same), same)
    dup = Counter((p['locationID'], norm(p['paragraphText'])) for p in pars)
    d = [k for k, v in dup.items() if v > 1]
    if d:
        add(a, 'WARN', 'The same paragraph twice in one town', len(d), ['town %s' % k[0] for k in d])
    locs = rows(con, 'select ID, locationName from locations')
    ws = ['%s "%s"' % (l['ID'], l['locationName']) for l in locs if l['locationName'] != (l['locationName'] or '').strip() or '  ' in (l['locationName'] or '')]
    if ws:
        add(a, 'WARN', 'Town names with stray spaces', len(ws), ws)
    names = defaultdict(list)
    for l in locs:
        names[norm(l['locationName'])].append('%s %s' % (l['ID'], l['locationName']))
    dn = [v for v in names.values() if len(v) > 1]
    if dn:
        add(a, 'INFO', 'Towns whose names match once accents and punctuation are ignored', len(dn), [' | '.join(v) for v in dn],
            'Often legitimate (a town and its albergue stop), listed for a quick look.')
    longs = [('%s %s' % (l['ID'], l['locationName'])) for l in locs if len(l['locationName'] or '') > 60]
    if longs:
        add(a, 'WARN', 'Town names close to the 64-character limit', len(longs), longs)


def check_locations(con):
    a = 'Towns'
    locs = rows(con, 'select * from locations')
    nogps = [l for l in locs if num(l['latitude']) is None or num(l['longitude']) is None]
    if nogps:
        add(a, 'ERROR', 'Towns with no coordinates', len(nogps), ['%s %s' % (l['ID'], l['locationName']) for l in nogps])
    holding = placeholder_town_ids(con)
    out = [l for l in locs if num(l['latitude']) is not None and not in_box(num(l['latitude']), num(l['longitude'])) and l['ID'] not in holding]
    if out:
        add(a, 'ERROR', 'Towns outside the Camino area', len(out), ['%s %s (%s, %s)' % (l['ID'], l['locationName'], l['latitude'], l['longitude']) for l in out])
    if holding:
        add(a, 'INFO', 'Holding town for places off the route (its position is not on the Camino by design): %s' % ', '.join('%s %s' % (l['ID'], l['locationName']) for l in locs if l['ID'] in holding), len(holding))
    pts = Counter((num(l['latitude']), num(l['longitude'])) for l in locs if num(l['latitude']) is not None)
    dup = [k for k, v in pts.items() if v > 1]
    if dup:
        add(a, 'WARN', 'Two towns at exactly the same coordinates', len(dup), [str(k) for k in dup])
    for flag, src, chk in (('hasBarCafe', 'hasBarCafeSource', 'hasBarCafeCheckedAt'), ('hasPharmacy', 'hasPharmacySource', 'hasPharmacyCheckedAt'),
                           ('hasGroceryStore', 'hasGroceryStoreSource', 'hasGroceryStoreCheckedAt'), ('hasAtm', 'hasAtmSource', 'hasAtmCheckedAt')):
        unknown = sum(1 for l in locs if l[flag] is None)
        odd = [l['ID'] for l in locs if l[flag] not in (None, 0, 1)]
        nosrc = [l['ID'] for l in locs if l[flag] is not None and blank(l[src])]
        add(a, 'INFO', '%s: yes %d, no %d, unknown %d' % (flag, sum(1 for l in locs if l[flag] == 1), sum(1 for l in locs if l[flag] == 0), unknown), unknown)
        if odd:
            add(a, 'ERROR', flag + ' holds a value other than 0 or 1', len(odd), odd)
        if nosrc:
            add(a, 'INFO', '%s answered but with no source recorded' % flag, len(nosrc))
    pics = sum(1 for l in locs for i in range(1, 5) if not blank(l['locationPic%dURL' % i]))
    add(a, 'INFO', 'Town photo links stored: %d (the town page shows none)' % pics, pics)


def check_maps(con):
    a = 'Illustrated maps and hotspots'
    stages = rows(con, 'select * from stages order by ID')
    cols = [('stageMap360URL', '360'), ('stageMap400URL', '400'), ('stageMap640URL', '640'), ('stageMap1024URL', '1024'), ('stageMap1280URL', '1280'), ('stageMap1920URL', '1920'), ('stageMapURL', None)]
    for col, width in cols:
        empty = [s['ID'] for s in stages if blank(s[col])]
        if empty:
            add(a, 'ERROR' if col in ('stageMapURL', 'stageMap1024URL', 'stageMap1920URL') else 'WARN', 'Stages with no %s (the pages use %s)' % (col, 'it' if width is None else 'the others'), len(empty), empty)
        bad = [s['ID'] for s in stages if not blank(s[col]) and not str(s[col]).startswith('https://')]
        if bad:
            add(a, 'ERROR', col + ' is not an https link', len(bad), bad)
        if width:
            wrong = ['stage %s %s' % (s['ID'], str(s[col]).split('/upload/')[-1][:60]) for s in stages if not blank(s[col]) and ('/%smaps/' % width) not in str(s[col])]
            if wrong:
                add(a, 'WARN', '%s links whose folder is not %smaps' % (col, width), len(wrong), wrong)
    same = Counter(s['stageMapURL'] for s in stages if not blank(s['stageMapURL']))
    groups = defaultdict(list)
    for s_ in stages:
        if not blank(s_['stageMapURL']):
            groups[s_['stageMapURL']].append(s_['stageDisplayReference'] or str(s_['ID']))
    shared = [v for v in groups.values() if len(v) > 1]
    if shared:
        add(a, 'INFO', 'Route variants that share one map picture (each stage still has its own hotspots)', len(shared), ['/'.join(v) for v in shared])
    which = Counter(('1024' if s['stageMapURL'] == s['stageMap1024URL'] else '1920' if s['stageMapURL'] == s['stageMap1920URL'] else 'other') for s in stages)
    add(a, 'INFO', 'stageMapURL (the picture every device is sent) is the same file as: ' + ', '.join('%s x%d' % kv for kv in which.items()))
    elev = [s['ID'] for s in stages if blank(s['stageElevationChartURL'])]
    add(a, 'INFO', 'stageElevationChartURL is empty for %d of %d stages and no page uses it (the chart is drawn in the browser)' % (len(elev), len(stages)), len(elev))
    # hotspots
    hs = rows(con, 'select * from mapLocationCoords')
    add(a, 'INFO', 'Hotspot rows: %d across %d stages' % (len(hs), len({h['stageId'] for h in hs})))
    paths = defaultdict(set)
    for p in rows(con, 'select stageID, originLoc, destinationLoc from paths'):
        paths[p['stageID']].update((p['originLoc'], p['destinationLoc']))
    names = {l['ID']: l['locationName'] for l in rows(con, 'select ID, locationName from locations')}
    dup = Counter((h['stageId'], h['locationId']) for h in hs)
    d = [k for k, v in dup.items() if v > 1]
    if d:
        add(a, 'WARN', 'A town has two hotspots on the same stage map', len(d), ['stage %s, %s' % (k[0], names.get(k[1])) for k in d])
    notonstage = ['stage %s: %s' % (h['stageId'], names.get(h['locationId'], h['locationId'])) for h in hs if h['stageId'] in paths and h['locationId'] not in paths[h['stageId']]]
    if notonstage:
        add(a, 'INFO', "Hotspots for a place that is not the start or end of any path on that stage (a village beside the route, or a variant's town)", len(notonstage), notonstage)
    nohot = []
    hot = defaultdict(set)
    for h in hs:
        hot[h['stageId']].add(h['locationId'])
    for sid, locs in paths.items():
        miss = [names.get(l) for l in locs if l not in hot[sid]]
        if miss and hot[sid]:
            nohot.append('stage %s: %s' % (sid, ', '.join(m for m in miss if m)))
    if nohot:
        add(a, 'INFO', 'Route towns with no hotspot on a stage map that has hotspots', len(nohot), nohot)
    scales = [('1920', 'TLX1920', 'TLY1920', 'BRX1920', 'BRY1920', 1920), ('1280', 'TLX1280', 'TLY1280', 'BRX1280', 'BRY1280', 1280), ('1024', 'TLX1024', 'TLY1024', 'BRX1024', 'BRY1024', 1024),
              ('640', 'TLX640', 'TLY640', 'BRX640', 'BRY640', 640), ('360', 'TLX360', 'TLY360', 'BRX360', 'BRY360', 360)]
    for label_, a1, a2, a3, a4, width in scales:
        nulls = [h['ID'] for h in hs if any(h[c] is None for c in (a1, a2, a3, a4))]
        if nulls:
            add(a, 'WARN', 'Hotspots with a blank %s-scale rectangle' % label_, len(nulls), nulls)
        deg = [h['ID'] for h in hs if None not in (h[a1], h[a3], h[a2], h[a4]) and (h[a3] <= h[a1] or h[a4] <= h[a2])]
        if deg:
            add(a, 'ERROR', 'Hotspots whose %s-scale rectangle has no width or height (right edge left of the left edge)' % label_, len(deg), ['hotspot %s' % d for d in deg])
        over = ['%s (right edge %s of %s)' % (h['ID'], h[a3], width) for h in hs if h[a3] is not None and h[a3] > width + 2]
        if over:
            add(a, 'ERROR', 'Hotspots that run off the right edge of the %s-wide picture' % label_, len(over), over)
    # which scale do the base columns (topLeftX ...) hold, and do all scales agree?
    base = Counter()
    off = []
    for h in hs:
        if h['topLeftX'] is None:
            base['blank'] += 1; continue
        if h['TLX1920'] is not None and h['topLeftX'] == h['TLX1920'] and h['TLX1920'] != h['TLX1024']:
            base['1920 scale'] += 1
        elif h['TLX1024'] is not None and h['topLeftX'] == h['TLX1024'] and h['TLX1920'] != h['TLX1024']:
            base['1024 scale'] += 1
        elif h['topLeftX'] == h['TLX1920'] == h['TLX1024']:
            base['same in both (x near 0)'] += 1
        else:
            base['matches neither'] += 1
        for label_, a1, a2, a3, a4, width in scales[1:]:
            if None in (h['TLX1920'], h[a1], h['BRX1920'], h[a3]):
                continue
            k = width / 1920.0
            err = max(abs(h[a1] - h['TLX1920'] * k), abs(h[a3] - h['BRX1920'] * k), abs(h[a2] - h['TLY1920'] * k), abs(h[a4] - h['BRY1920'] * k))
            if err > 6:
                off.append((err, 'hotspot %s (stage %s, %s): %s-scale box is %.0f px off the 1920 box scaled down' % (h['ID'], h['stageId'], names.get(h['locationId']), label_, err)))
    add(a, 'INFO', 'The base hotspot columns (topLeftX ...) hold: ' + ', '.join('%s x%d' % kv for kv in base.most_common()),
        note='The website reads these base columns as "x_1920" and the page sets the SVG viewBox from the picture\'s own pixel size, so hotspots are only right while the picture sent is the 1024-wide one. Sending any other width (for instance with srcset) needs a fixed viewBox first.')
    if off:
        off.sort(reverse=True)
        add(a, 'WARN', 'Hotspot rectangles whose scales disagree by more than 6 px', len(off), [o[1] for o in off])
    over = []
    for h in hs:
        for h2 in hs:
            if h['ID'] < h2['ID'] and h['stageId'] == h2['stageId'] and None not in (h['TLX1920'], h2['TLX1920'], h['BRX1920'], h2['BRX1920']):
                ix = min(h['BRX1920'], h2['BRX1920']) - max(h['TLX1920'], h2['TLX1920'])
                iy = min(h['BRY1920'], h2['BRY1920']) - max(h['TLY1920'], h2['TLY1920'])
                if ix > 0 and iy > 0:
                    area = lambda z: max(1, (z['BRX1920'] - z['TLX1920']) * (z['BRY1920'] - z['TLY1920']))
                    if ix * iy > 0.5 * min(area(h), area(h2)):
                        over.append('stage %s: %s and %s overlap' % (h['stageId'], names.get(h['locationId']), names.get(h2['locationId'])))
    if over:
        add(a, 'WARN', 'Hotspots that overlap by more than half (one hides the other)', len(over), over)


def check_route_data(con):
    a = 'Route data (GPS tracks and elevation)'
    paths = rows(con, 'select * from paths order by pathID')
    pids = [p['pathID'] for p in paths]
    ec = dict(rows(con, 'select pathID, count(*) from elevation_points group by pathID'))
    tc = dict(rows(con, 'select pathID, count(*) from track_points group by pathID'))
    add(a, 'INFO', 'Paths %d; elevation points %d; GPS track points %d' % (len(paths), sum(ec.values()), sum(tc.values())))
    noel = [p for p in pids if p not in ec]
    notr = [p for p in pids if p not in tc]
    if noel:
        add(a, 'ERROR', 'Paths with no elevation points (the stage chart and ascent figures break)', len(noel), noel)
    if notr:
        add(a, 'WARN', 'Paths with no GPS track points (the page falls back to the elevation points for its map line)', len(notr), notr)
    # elevation
    bad_seq, bad_dist, outl, jumps, nogps, bad_len = [], [], [], [], [], []
    cur = None
    prev = None
    count = 0
    for r in con.execute('select pathID, sequence, distanceAlongPathMetres d, elevationMetres e, latitude lat, longitude lon from elevation_points order by pathID, sequence'):
        if r['pathID'] != cur:
            cur, prev, count = r['pathID'], None, 0
        if prev is not None:
            if r['sequence'] != prev['sequence'] + 1:
                bad_seq.append('path %s: sequence %s after %s' % (cur, r['sequence'], prev['sequence']))
            if r['d'] is not None and prev['d'] is not None and r['d'] < prev['d'] - 0.001:
                bad_dist.append('path %s: distance goes back at sequence %s' % (cur, r['sequence']))
            if r['e'] is not None and prev['e'] is not None and abs(r['e'] - prev['e']) > 60:
                jumps.append('path %s seq %s: %.0f m then %.0f m' % (cur, r['sequence'], prev['e'], r['e']))
        if r['e'] is None or r['e'] < -5 or r['e'] > 1700:
            outl.append('path %s seq %s: %s m' % (cur, r['sequence'], r['e']))
        if not in_box(r['lat'], r['lon']):
            nogps.append('path %s seq %s: %s, %s' % (cur, r['sequence'], r['lat'], r['lon']))
        prev = r
    for name, found, sev in (('Elevation points out of sequence', bad_seq, 'ERROR'), ('Elevation points whose distance goes backwards', bad_dist, 'ERROR'),
                             ('Elevation outside -5 to 1,700 m (the Camino peaks near 1,500 m)', outl, 'ERROR'), ('Elevation jumps of more than 60 m between neighbouring points', jumps, 'WARN'),
                             ('Elevation points with a missing or out-of-area position', nogps, 'ERROR')):
        if found:
            add(a, sev, name, len(found), found)
    # last elevation distance against the path's distance
    last = {r['pathID']: r['d'] for r in rows(con, 'select pathID, max(distanceAlongPathMetres) d from elevation_points group by pathID')}
    for p in paths:
        if p['distance_metres'] and last.get(p['pathID']) and abs(last[p['pathID']] - p['distance_metres']) > max(150, 0.03 * p['distance_metres']):
            bad_len.append('path %s: paths says %d m, elevation points run to %.0f m' % (p['pathID'], p['distance_metres'], last[p['pathID']]))
    if bad_len:
        add(a, 'WARN', 'Path length disagrees with its elevation points by more than 3%', len(bad_len), bad_len)
    # track points
    big, track_bad, track_len = [], [], defaultdict(float)
    cur, prev = None, None
    for r in con.execute('select track_point_id id, pathID, latitude lat, longitude lon from track_points order by pathID, track_point_id'):
        lat, lon = num(r['lat']), num(r['lon'])
        if not in_box(lat, lon):
            track_bad.append('track point %s (path %s): %s, %s' % (r['id'], r['pathID'], r['lat'], r['lon']))
            prev = None
            continue
        if r['pathID'] != cur:
            cur, prev = r['pathID'], None
        if prev is not None:
            d = haversine(prev[0], prev[1], lat, lon)
            track_len[cur] += d
            if d > 400:
                big.append('path %s: %.0f m gap before track point %s' % (cur, d, r['id']))
        prev = (lat, lon)
    if track_bad:
        add(a, 'ERROR', 'GPS track points with a missing or out-of-area position', len(track_bad), track_bad)
    if big:
        add(a, 'WARN', 'Gaps of more than 400 m between neighbouring GPS track points (a missing stretch draws as a straight line)', len(big), big)
    tl = []
    for p in paths:
        if p['distance_metres'] and track_len.get(p['pathID']) and abs(track_len[p['pathID']] - p['distance_metres']) > max(300, 0.08 * p['distance_metres']):
            tl.append('path %s: %d m on record, GPS track measures %.0f m' % (p['pathID'], p['distance_metres'], track_len[p['pathID']]))
    if tl:
        add(a, 'WARN', 'Path length disagrees with its GPS track by more than 8%', len(tl), tl)
    per = Counter(tc.values())
    add(a, 'INFO', 'GPS track points per path: smallest %d, largest %d (stage pages send these to the browser in full)' % (min(tc.values()), max(tc.values())) if tc else 'No GPS track points')


def check_indexes(con):
    a = 'Speed of the queries the site runs'
    queries = [
        ('town page: stays in a town', 'select * from albergues where locationID = 1'),
        ('town page: private stays in a town', 'select * from privateAccommDetail where locationID = 1'),
        ('town page: paragraphs', 'select * from paragraphs where locationID = 1'),
        ('town page: parent stage', 'select * from mapLocationCoords where locationId = 1'),
        ('a town by ID', 'select * from locations where ID = 1'),
        ('a stage by ID', 'select * from stages where ID = 1'),
        ('stage page: its paths', 'select * from paths where stageID = 1'),
        ('stage page: hotspots', 'select * from mapLocationCoords where stageId = 1'),
        ('stage page: elevation of a path', 'select * from elevation_points where pathID = 1 order by sequence'),
        ('stage page: GPS track of its paths', 'select * from track_points where pathID in (1,2) order by track_point_id'),
    ]
    scans = []
    for label_, q in queries:
        plan = ' / '.join(r['detail'] for r in rows(con, 'explain query plan ' + q))
        if 'SCAN' in plan and 'USING' not in plan:
            scans.append('%s: %s' % (label_, plan))
    sizes = {t: scalar(con, 'select count(*) from "%s"' % t) for t in ('albergues', 'privateAccommDetail', 'paragraphs', 'mapLocationCoords', 'locations', 'stages', 'paths')}
    if scans:
        add(a, 'INFO', 'Queries that read the whole table because the column has no index', len(scans), scans,
            'Harmless at these sizes (largest table: %d rows), but every town page and every stage page does several of them, and a stage page makes 30 to 50 queries.' % max(sizes.values()))
    else:
        ok(a, 'All the site\'s lookups use an index')


# --------------------------------------------------------------------------------------------
def compare_app(web, app):
    a = 'Website and app databases'
    wt, at = set(tables(web)), set(tables(app))
    only_w, only_a = sorted(wt - at), sorted(at - wt)
    if only_w:
        add(a, 'INFO', 'Tables only in the website database', len(only_w), only_w)
    if only_a:
        add(a, 'INFO', 'Tables only in the app database', len(only_a), only_a)
    for t in ('stages', 'locations', 'albergues', 'privateAccommDetail', 'paragraphs', 'mapLocationCoords', 'paths'):
        key = 'pathID' if t == 'paths' else 'ID'
        wc = [c['name'] for c in rows(web, 'pragma table_info("%s")' % t)]
        ac = [c['name'] for c in rows(app, 'pragma table_info("%s")' % t)]
        if wc != ac:
            add(a, 'WARN', '%s: the columns differ (website only: %s; app only: %s)' % (t, sorted(set(wc) - set(ac)), sorted(set(ac) - set(wc))))
        cols = [c for c in wc if c in ac]
        w = {r[key]: r for r in rows(web, 'select * from "%s"' % t)}
        p = {r[key]: r for r in rows(app, 'select * from "%s"' % t)}
        ow, oa = sorted(set(w) - set(p)), sorted(set(p) - set(w))
        changed, kept = [], []
        for k in sorted(set(w) & set(p)):
            diff = [c for c in cols if (w[k][c] != p[k][c]) and not (blank(w[k][c]) and blank(p[k][c]))
                    and not (isinstance(w[k][c], (int, float)) and isinstance(p[k][c], (int, float)) and abs(w[k][c] - p[k][c]) < 1e-9)]
            if t == 'stages':
                # tool/sync_website_database.py keeps these website values on purpose: the app has no alternative-route
                # links of its own, and no elevation chart address (the chart is drawn in the browser)
                by_design = [c for c in diff if c in ('altPriorStage', 'altNextStage') or (c == 'stageElevationChartURL' and blank(p[k][c]))]
                if by_design:
                    kept.append('%s=%s (%s)' % (key, k, ', '.join(by_design)))
                diff = [c for c in diff if c not in by_design]
            if diff:
                changed.append('%s=%s differs in %s' % (key, k, ', '.join(diff)))
        label = lambda r: str(r['ID' if t != 'paths' else 'pathID'])
        if kept:
            add(a, 'INFO', '%s: %d rows differ only where the sync keeps the website\'s value on purpose' % (t, len(kept)), len(kept), kept,
                'Alternative-route links and the elevation chart address. The sync tool does not copy these from the app.')
        if not (ow or oa or changed):
            if not kept:
                ok(a, '%s: identical (%d rows)' % (t, len(w)))
            continue
        if ow:
            add(a, 'INFO' if t == 'mapLocationCoords' else 'WARN', '%s: %d rows only in the website database' % (t, len(ow)), len(ow), ow,
                'The sync tool deliberately keeps website-only hotspot rows.' if t == 'mapLocationCoords' else 'These will not reach the app until they are copied across.')
        if oa:
            add(a, 'WARN', '%s: %d rows only in the app database' % (t, len(oa)), len(oa), oa, 'These are missing from the website.')
        if changed:
            add(a, 'WARN', '%s: %d rows differ between the two databases' % (t, len(changed)), len(changed), changed)
    for t in ('elevation_points', 'track_points'):
        wn, an = scalar(web, 'select count(*) from "%s"' % t), scalar(app, 'select count(*) from "%s"' % t)
        if wn != an:
            add(a, 'WARN', '%s: %d rows in the website, %d in the app' % (t, wn, an))
        else:
            ok(a, '%s: same row count (%d)' % (t, wn))
    # guide fingerprint ingredients: paths and locations only
    for label_, sql_ in (('paths (id, stage, origin, destination)', 'select pathID, stageID, originLoc, destinationLoc from paths order by pathID'), ('locations (id)', 'select ID from locations order by ID')):
        if [tuple(r) for r in rows(web, sql_)] == [tuple(r) for r in rows(app, sql_)]:
            ok(a, 'The plan-code guide fingerprint ingredients agree: ' + label_)
        else:
            add(a, 'ERROR', 'The plan-code guide fingerprint ingredients differ: %s. Plans sent between website and app would be refused.' % label_)
    # stays the planner can send: names must match for the app to accept them
    wst = {(r[0], r[1]): r[2] for r in rows(web, 'select 0, ID, albergueName from albergues union all select 1, ID, privateAccommName from privateAccommDetail')}
    ast = {(r[0], r[1]): r[2] for r in rows(app, 'select 0, ID, albergueName from albergues union all select 1, ID, privateAccommName from privateAccommDetail')}
    missing = sorted(set(wst) - set(ast))
    if missing:
        add(a, 'ERROR', 'Stays the planner can put in a plan that the app does not have (the app refuses unknown stays)', len(missing), ['%s %s "%s"' % ('private' if k[0] else 'hostel', k[1], wst[k]) for k in missing])
    else:
        ok(a, 'Every stay in the website database exists in the app database')


def report(markdown):
    order = {'ERROR': 0, 'WARN': 1, 'INFO': 2, 'OK': 3}
    areas = []
    for f in FINDINGS:
        if f['area'] not in areas:
            areas.append(f['area'])
    out = []
    counts = Counter(f['severity'] for f in FINDINGS)
    out.append('# Database audit\n' if markdown else 'DATABASE AUDIT')
    out.append('%d errors, %d warnings, %d notes, %d checks passed' % (counts['ERROR'], counts['WARN'], counts['INFO'], counts['OK']))
    for area in areas:
        out.append('\n## %s\n' % area if markdown else '\n== %s ==' % area)
        for f in sorted((f for f in FINDINGS if f['area'] == area), key=lambda f: order[f['severity']]):
            head = '%s  %s' % (f['severity'], f['title'])
            if f['count'] is not None and not re.search(r'(?<![\d,.])%d(?![\d,.])' % f['count'], f['title']):
                head += '  [%d]' % f['count']
            out.append(('- **%s**' % head) if markdown else '  ' + head)
            if f['note']:
                out.append(('  %s' % f['note']) if markdown else '      note: ' + f['note'])
            if f['examples']:
                shown = '; '.join(f['examples'])
                more = ' ...' if f['count'] and f['count'] > len(f['examples']) else ''
                out.append(('  e.g. %s%s' % (shown, more)) if markdown else '      e.g. %s%s' % (shown, more))
    return '\n'.join(out) + '\n'


ENGLISH_NAME = re.compile(r"\b(exit|detour|splits?|rejoin|leave|centre|center|fountain|shelter|winery|van|refreshments|crossing|junction|viewpoint|route)\b", re.I)


def check_spanish(con, path):
    """What the Spanish pages still show in English: the catalogue (camino/locale/es.json) is looked up by the English text."""
    a = 'Spanish version'
    if not path or not os.path.exists(path):
        add(a, 'INFO', 'Spanish catalogue not found (looked for %s); this check was skipped' % path)
        return
    data = json.load(open(path, encoding='utf-8'))
    have = set(data.get('ui', {})) | set(data.get('plan', {}))

    def missing(sql):
        seen = {}
        for r in rows(con, sql):
            v = r[0]
            if v is not None and str(v).strip() and re.search('[A-Za-z]{3}', str(v)) and str(v).strip() not in have:
                seen[str(v).strip()] = seen.get(str(v).strip(), 0) + 1
        return seen
    for title, sql in (('Stage names', 'select stageName from stages'),
                       ('Opening periods of albergues', 'select openingPeriod from albergues'),
                       ('Check-in times of albergues', 'select checkInTimes from albergues'),
                       ('Price notes of albergues', 'select rateNotes from albergues'),
                       ('Price notes of private places to stay', 'select rateNotes from privateAccommDetail')):
        gone = missing(sql)
        if gone:
            add(a, 'ERROR' if title == 'Stage names' else 'WARN', '%s with no Spanish, so the Spanish pages show them in English (add them to es.json, "ui" for stage names and "plan" for stay text)' % title,
                len(gone), ['%s (%d)' % (k[:90], v) for k, v in sorted(gone.items(), key=lambda kv: -kv[1])])
        else:
            ok(a, '%s: every value has Spanish' % title)
    names = [r['locationName'].strip() for r in rows(con, 'select locationName from locations') if r['locationName']]
    english = [n for n in names if ENGLISH_NAME.search(n) and n not in have]
    if english:
        add(a, 'WARN', 'Town names that look English and have no Spanish', len(english), english)
    else:
        ok(a, 'Town names that look English all have Spanish')
    try:
        total, with_es = rows(con, "select count(*), sum(paragraphTextEs is not null and trim(paragraphTextEs) <> '') from paragraphs")[0][0:2]
        if total != (with_es or 0):
            add(a, 'WARN', 'Town paragraphs with no Spanish text (the Spanish page shows the English paragraph)', total - (with_es or 0))
        else:
            ok(a, 'Every town paragraph has Spanish text (%d)' % total)
    except sqlite3.Error:
        add(a, 'INFO', 'paragraphs has no paragraphTextEs column')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('website_db')
    ap.add_argument('--app', help='the app database to compare with')
    ap.add_argument('--spanish', help='the Spanish catalogue (default: camino/locale/es.json next to the database)')
    ap.add_argument('--markdown', help='write the report as Markdown to this file')
    ap.add_argument('--json', help='write the findings as JSON to this file')
    args = ap.parse_args()
    web = connect(args.website_db)
    for fn in (check_integrity, check_references, check_graph, check_stays, check_text, check_locations, check_maps, check_route_data, check_indexes):
        fn(web)
    check_spanish(web, args.spanish or os.path.join(os.path.dirname(os.path.abspath(args.website_db)), 'camino', 'locale', 'es.json'))
    if args.app:
        compare_app(web, connect(args.app))
    print(report(False))
    if args.markdown:
        open(args.markdown, 'w', encoding='utf-8').write(report(True))
    if args.json:
        json.dump(FINDINGS, open(args.json, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    return 1 if any(f['severity'] == 'ERROR' for f in FINDINGS) else 0


if __name__ == '__main__':
    sys.exit(main())
