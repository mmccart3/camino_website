# camino/views.py
import json
import logging
import traceback
from datetime import date
from xml.sax.saxutils import escape

from django.conf import settings
from django.db import connection
from django.db.models import Count
from django.http import Http404, HttpResponse, HttpResponseServerError, JsonResponse
from django.shortcuts import render, get_object_or_404, redirect
from django.templatetags.static import static
from django.urls import reverse
from django.utils import translation

from . import gpx, i18n, planner, seo, stage_maps
from .i18n import tr
from .models import (
    Stage, Path, ElevationPoint, MapLocationCoord, Location,
    Albergue, PrivateAccomm, TrackPoint, BOOKING_AFFILIATE_PARAMS,
    my_maps_viewer_url, weather_search_url, weather_place_name,
)

logger = logging.getLogger(__name__)

# camino/views.py

def get_stage_groups():
    all_stages = {s.id: s for s in Stage.objects.all()}
    if not all_stages:
        return []

    prior_groups = {}
    next_groups = {}

    for s in all_stages.values():
        prior_key = s.prior_stage if (s.prior_stage and s.prior_stage in all_stages) else 0
        prior_groups.setdefault(prior_key, []).append(s.id)

        if s.next_stage and s.next_stage in all_stages:
            next_groups.setdefault(s.next_stage, []).append(s.id)

    alternate_links = {s_id: set() for s_id in all_stages}

    for s_ids in prior_groups.values():
        if len(s_ids) > 1:
            for i in s_ids:
                for j in s_ids:
                    if i != j:
                        alternate_links[i].add(j)

    for s_ids in next_groups.values():
        if len(s_ids) > 1:
            for i in s_ids:
                for j in s_ids:
                    if i != j:
                        alternate_links[i].add(j)

    def get_cluster(stage_id, visited_set):
        cluster = [all_stages[stage_id]]
        visited_set.add(stage_id)
        for neighbor_id in sorted(alternate_links[stage_id]):
            if neighbor_id not in visited_set:
                cluster.extend(get_cluster(neighbor_id, visited_set))
        return cluster

    start_candidates = prior_groups.get(0, [])
    start_id = min(start_candidates) if start_candidates else min(all_stages.keys())

    grouped_stages = []
    visited = set()
    current_stage = all_stages[start_id]
    section_index = 1

    def classify_variant(stage):
        name_lower = stage.stage_name.lower()
        if 'valcarlos' in name_lower or 'low' in name_lower or 'winter' in name_lower:
            return {'label': tr('Low-Valley / Winter Variant'), 'badge_class': 'badge-valley', 'icon': '🌦️'}
        elif 'napoleon' in name_lower or 'high' in name_lower or 'mountain' in name_lower:
            return {'label': tr('Mountain Route / High Pass'), 'badge_class': 'badge-mountain', 'icon': '⛰️'}
        elif 'via' in name_lower or 'option' in name_lower or 'alt' in name_lower:
            return {'label': tr('Alternative Variant'), 'badge_class': 'badge-alt', 'icon': '🔀'}
        return {'label': tr('Main Camino Route'), 'badge_class': 'badge-main', 'icon': '🚶'}

    while current_stage and current_stage.id not in visited:
        cluster = get_cluster(current_stage.id, visited)

        def sort_key(s):
            name_lower = s.stage_name.lower()
            is_alt = 1 if any(k in name_lower for k in ['via', 'option', 'valcarlos', 'alt']) else 0
            return (is_alt, s.id)

        cluster.sort(key=sort_key)

        for s in cluster:
            s.variant_meta = classify_variant(s)

        primary = cluster[0]
        alternates = cluster[1:]

        grouped_stages.append({
            'section_index': section_index,
            'primary': primary,
            'alternates': alternates,
            'all_variants': cluster,
            'variant_count': len(cluster),
            'has_alternate': len(alternates) > 0
        })
        section_index += 1

        candidate_next = None
        for member in cluster:
            if member.next_stage and member.next_stage in all_stages and member.next_stage not in visited:
                candidate_next = all_stages[member.next_stage]
                break

        if not candidate_next:
            for member in cluster:
                children = [all_stages[cid] for cid in prior_groups.get(member.id, []) if cid not in visited]
                if children:
                    candidate_next = min(children, key=lambda s: s.id)
                    break

        current_stage = candidate_next

    for s_id in sorted(all_stages.keys()):
        if s_id not in visited:
            cluster = get_cluster(s_id, visited)
            for s in cluster:
                s.variant_meta = classify_variant(s)
            grouped_stages.append({
                'section_index': section_index,
                'primary': cluster[0],
                'alternates': cluster[1:],
                'all_variants': cluster,
                'variant_count': len(cluster),
                'has_alternate': len(cluster) > 1
            })
            section_index += 1

    return grouped_stages

def towns_with_counts():
    """Every location with the number of places to stay, A to Z."""
    towns = list(
        Location.objects.annotate(
            n_albergues=Count('albergues', distinct=True),
            n_private=Count('private_accomm', distinct=True),
        ).order_by('location_name')
    )
    for town in towns:
        town.stays = (town.n_albergues or 0) + (town.n_private or 0)
    if i18n.is_spanish():
        # A few markers are named in Spanish (Exit to Huarte is Desvío a Huarte), so the A to Z order follows what is shown.
        towns.sort(key=lambda town: seo.normalise(town.display_name))
    return towns


def search_text(town):
    """What a search is matched against: the name shown, and the English name too when they differ."""
    shown = seo.normalise(town.display_name)
    english = seo.normalise(town.location_name)
    return shown if shown == english else shown + ' ' + english


def town_index_payload(towns):
    """Small JSON-friendly list used by the in-page town search (works offline)."""
    return [
        {
            'id': t.id,
            'name': t.display_name,
            'norm': search_text(t),
            'url': reverse('location_detail', args=[t.id]),
            'stays': t.stays,
        }
        for t in towns
    ]


def stage_list(request):
    stage_groups = get_stage_groups()
    context = {
        'stage_groups': stage_groups,
        'town_index': town_index_payload(towns_with_counts()),
        'seo': seo.home_seo(seo.site_origin(request)),
    }
    return render(request, 'camino/stage_list.html', context)


def towns(request):
    items = towns_with_counts()
    groups = {}
    for town in items:
        town.norm = search_text(town)
        letter = (town.norm[:1] or '#').upper()
        groups.setdefault(letter, []).append(town)
    context = {
        'groups': sorted(groups.items()),
        'town_count': len(items),
        'seo': {
            'title': seo.compose_title(tr('All Camino Francés towns and villages')),
            'description': seo.clip(tr(
                'Find any of the {n} towns and villages on the Camino Francés and see '
                'where pilgrims can sleep, eat and shop.', n=len(items)
            )),
        },
    }
    return render(request, 'camino/towns.html', context)


def plan_sections():
    """The guide's own grouping of stages and route variants, as the planner wants it."""
    return [
        {
            'n': group['section_index'],
            'stages': [s.id for s in group['all_variants']],
            'variants': {
                s.id: planner.VARIANT_KEYS.get(s.variant_meta['badge_class'], 'main')
                for s in group['all_variants']
            },
        }
        for group in get_stage_groups()
    ]


def plan(request):
    """The itinerary planner. The guide data is embedded in the page, so it also works offline."""
    body = planner.get_planner_json(connection, plan_sections)
    # Stop the JSON from ever closing the script tag early.
    safe = body.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    context = {'plan_json': safe, 'seo': seo.plan_seo(seo.site_origin(request))}
    return render(request, 'camino/plan.html', context)


def plan_stays(request):
    """Prices, beds, facilities and contact links for the places to stay, for the planner's stay picker.

    Kept apart from the planner page so the page stays light: the planner asks for this the first
    time it needs it, and the service worker keeps a copy for use offline.
    """
    body = planner.get_stay_details_json(connection, BOOKING_AFFILIATE_PARAMS)
    response = HttpResponse(body, content_type='application/json; charset=utf-8')
    response['Cache-Control'] = 'public, max-age=3600'
    return response


STAY_RESULT_LIMIT = 40


def stay_results(needle):
    """Places to stay whose name holds the search text: albergues first, then private places, each A to Z.

    Each result links to its card on the town's page (the card's id is stay-a<id> or stay-p<id>).
    """
    found = []
    for model, kind, prefix in ((Albergue, 'Albergue', 'a'), (PrivateAccomm, 'Private Room', 'p')):
        for stay in model.objects.select_related('location').order_by('name'):
            name = seo.normalise(stay.name)
            # A holding place such as "Unassigned" keeps stays that are off the route: they are not offered.
            if needle in name and not stay.location.is_placeholder:
                found.append((0 if name.startswith(needle) else 1, name, {
                    'name': str(stay.name).strip(),
                    'kind': kind,
                    'town': stay.location.display_name,
                    'url': reverse('location_detail', args=[stay.location_id]) + '#stay-%s%d' % (prefix, stay.id),
                }))
    found.sort(key=lambda row: (row[0], row[1]))
    return [row[2] for row in found]


def search(request):
    query = request.GET.get('q', '').strip()[:80]
    town_results, stage_results, stays, more_stays = [], [], [], 0
    if query:
        needle = seo.normalise(query)
        for town in towns_with_counts():
            name = search_text(town)
            if needle in name:
                town_results.append((0 if name.startswith(needle) else 1, name, town))
        town_results = [t for _, _, t in sorted(town_results, key=lambda row: (row[0], row[1]))]
        stage_results = [
            s for s in Stage.objects.order_by('id') if needle in seo.normalise(s.stage_name)
        ]
        if len(town_results) == 1 and not stage_results:
            return redirect('location_detail', location_id=town_results[0].id)
        # One letter would match hundreds of names, so places to stay are searched from two letters up.
        stays = stay_results(needle) if len(needle) >= 2 else []
        if len(stays) == 1 and not town_results and not stage_results:
            return redirect(stays[0]['url'])
        more_stays = max(0, len(stays) - STAY_RESULT_LIMIT)
        stays = stays[:STAY_RESULT_LIMIT]
    context = {
        'query': query,
        'town_results': town_results,
        'stage_results': stage_results,
        'stay_results': stays,
        'more_stays': more_stays,
        'seo': {
            'title': seo.compose_title(tr('Search: {query}', query=query) if query else tr('Search the guide')),
            'description': tr('Search towns, stages and places to stay on the Camino Francés.'),
            'noindex': True,
        },
    }
    return render(request, 'camino/search_results.html', context)


def offline(request):
    return render(request, 'camino/offline.html', {
        'seo': {'title': seo.compose_title(tr("You're offline")), 'noindex': True},
    })


def offline_pack(request):
    return render(request, 'camino/offline_pack.html', {
        'seo': {
            'title': seo.compose_title(tr('Save the guide for offline use')),
            'description': tr('Download every stage and town page to your phone so the guide works without a signal.'),
        },
    })


def offline_pack_json(request):
    """Lists everything the offline pack should save. Fetched by the pack page.

    ?lang=es lists the Spanish pages (under /es/) instead of the English ones.
    """
    stages = list(Stage.objects.order_by('id'))
    with translation.override('es' if request.GET.get('lang') == 'es' else 'en'):
        page_urls = [reverse('stage_list'), reverse('towns'), reverse('offline_pack'), reverse('offline')]
        page_urls += [reverse('stage_detail', args=[s.id]) for s in stages]
        page_urls += [
            reverse('location_detail', args=[pk])
            for pk in Location.objects.order_by('id').values_list('id', flat=True)
        ]
    images = []
    for stage in stages:
        url = stage.stage_map_url or stage.map_url_1920 or stage.map_url_1024
        if url and url.startswith('http') and url not in images:
            images.append(url)
    response = JsonResponse({
        'version': settings.APP_VERSION,
        'cache': 'camino-pack',
        'pages': page_urls,
        'images': images,
    })
    response['Cache-Control'] = 'no-store'
    return response


def manifest(request):
    home = reverse('stage_list')   # '/' in English, '/es/' in Spanish
    data = {
        'id': home,
        'name': tr('Saint Jean to Santiago: Camino Francés guide'),
        'short_name': tr('Camino Guide'),
        'description': tr('Stages, maps, elevation profiles and places to stay on the Camino Francés.'),
        'start_url': home,
        'scope': '/',
        'display': 'standalone',
        'background_color': '#00336d',
        'theme_color': '#1e3a8a',
        'lang': i18n.current_language(),
        'categories': ['travel', 'navigation'],
        'icons': [
            {'src': static('camino/img/icon-192.png'), 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': static('camino/img/icon-512.png'), 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': static('camino/img/icon-maskable-512.png'), 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
        'shortcuts': [
            {'name': tr('Find a town'), 'url': reverse('towns')},
            {'name': tr('Save for offline'), 'url': reverse('offline_pack')},
        ],
    }
    response = JsonResponse(data, content_type='application/manifest+json')
    response['Cache-Control'] = 'public, max-age=3600'
    return response


def service_worker(request):
    """Serves sw.js with the release version and core file list filled in.

    The version changes whenever APP_VERSION changes, which is what makes browsers
    install the new worker and clear the old caches.
    """
    path = settings.BASE_DIR / 'camino' / 'static' / 'camino' / 'js' / 'sw.js'
    source = path.read_text(encoding='utf-8')
    with translation.override('es'):
        spanish_pages = [reverse('stage_list'), reverse('towns'), reverse('plan'), reverse('offline'), reverse('offline_pack')]
    precache = [
        '/',
        reverse('towns'),
        reverse('plan'),
        reverse('plan_stays'),
        reverse('offline'),
        reverse('offline_pack'),
    ] + spanish_pages + [
        static('camino/js/i18n.js'),
        static('camino/js/i18n-es.js'),
        static('camino/js/i18n-es-plan.js'),
        static('camino/js/pwa.js'),
        static('camino/js/search.js'),
        static('camino/js/offline-pack.js'),
        static('camino/js/plan-core.js'),
        static('camino/js/qr.js'),
        static('camino/js/plan-share.js'),
        static('camino/js/plan-message.js'),
        static('camino/js/stage-pace.js'),   # the pace slider on a stage page (not only the planner) works offline
        static('camino/js/plan.js'),
        static('camino/css/plan.css'),
        static('camino/chart.umd.min.js'),
        static('camino/fonts/Fiesta.ttf'),
        static('camino/img/icon-96.png'),
        static('camino/img/favicon-48.png'),
        static('camino/img/whatsapp-logo-green.svg'),
        static('camino/img/google-maps-pin.png'),
        settings.LEAFLET_CSS_URL,
        settings.LEAFLET_JS_URL,
    ] + settings.LEAFLET_IMAGE_URLS
    source = source.replace('__VERSION__', settings.APP_VERSION)
    source = source.replace('__PRECACHE__', json.dumps(precache))
    response = HttpResponse(source, content_type='application/javascript; charset=utf-8')
    response['Cache-Control'] = 'no-cache'
    response['Service-Worker-Allowed'] = '/'
    return response


def robots_txt(request):
    origin = seo.site_origin(request)
    body = (
        'User-agent: *\n'
        'Allow: /\n'
        'Disallow: /search/\n'
        'Disallow: /es/search/\n'
        'Disallow: /offline-pack.json\n'
        'Disallow: /plan/stays.json\n'
        'Disallow: /*.gpx$\n'
        f'Sitemap: {origin}/sitemap.xml\n'
    )
    return HttpResponse(body, content_type='text/plain; charset=utf-8')


# The columns that record the day a place's facilities (café, pharmacy, grocery, cash machine) were last checked.
FACILITY_CHECK_COLUMNS = ('hasBarCafeCheckedAt', 'hasPharmacyCheckedAt', 'hasGroceryStoreCheckedAt', 'hasAtmCheckedAt')


def location_check_dates():
    """{location id: 'YYYY-MM-DD'}: the latest day any of a place's facilities was checked.

    These are real dates from the guide's data, so a place page's <lastmod> in the sitemap moves only when its
    facts were checked again, not every time the site is deployed. Places that have no check date are left out
    (the sitemap then gives no <lastmod> for them), and so is anything that is not a date. If the columns are
    missing from the database the sitemap simply has no dates.
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT ID, ' + ', '.join(FACILITY_CHECK_COLUMNS) + ' FROM locations')
            rows = cursor.fetchall()
    except Exception:
        return {}
    dates = {}
    for location_id, *checked in rows:
        days = []
        for value in checked:
            day = str(value or '').strip()[:10]   # '2026-09-16T10:07:42+00:00' and '2026-10-20' both give the day
            try:
                date.fromisoformat(day)
            except ValueError:
                continue
            days.append(day)
        if days:
            dates[location_id] = max(days)
    return dates


def sitemap_xml(request):
    origin = seo.site_origin(request)
    routes = [('stage_list', []), ('towns', []), ('plan', []), ('offline_pack', [])]
    routes += [('stage_detail', [s.id]) for s in Stage.objects.order_by('id')]
    towns_qs = Location.objects.annotate(
        n_albergues=Count('albergues', distinct=True),
        n_private=Count('private_accomm', distinct=True),
        n_paragraphs=Count('paragraphs', distinct=True),
    ).order_by('id')
    # Holding places such as "Unassigned" are not listed: their pages ask search engines to skip them.
    routes += [
        ('location_detail', [t.id])
        for t in towns_qs
        if (t.n_albergues or 0) + (t.n_private or 0) + (t.n_paragraphs or 0) > 0 and not t.is_placeholder
    ]
    checked = location_check_dates()
    # Every page is listed in both languages, each entry pointing at the other language (hreflang).
    rows = []
    for name, args in routes:
        with translation.override('en'):
            english = origin + reverse(name, args=args)
        with translation.override('es'):
            spanish = origin + reverse(name, args=args)
        links = (
            f'<xhtml:link rel="alternate" hreflang="en" href="{escape(english)}"/>'
            f'<xhtml:link rel="alternate" hreflang="es" href="{escape(spanish)}"/>'
            f'<xhtml:link rel="alternate" hreflang="x-default" href="{escape(english)}"/>'
        )
        # Only place pages have a date (when their facilities were checked); <lastmod> comes right after <loc>.
        day = checked.get(args[0]) if name == 'location_detail' else None
        lastmod = f'<lastmod>{day}</lastmod>' if day else ''
        rows.append(f'<url><loc>{escape(english)}</loc>{lastmod}{links}</url>')
        rows.append(f'<url><loc>{escape(spanish)}</loc>{lastmod}{links}</url>')
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">' + ''.join(rows) + '</urlset>'
    )
    return HttpResponse(xml, content_type='application/xml; charset=utf-8')


# camino/views.py

def stage_detail(request, stage_id):
    # 1. Fetch Stage model instance first
    stage = get_object_or_404(Stage, pk=stage_id)

    # 2. Prior & Next Navigation links
    prior_id = getattr(stage, 'prior_stage', None)
    alt_prior_id = getattr(stage, 'alt_prior_stage', None)
    next_id = getattr(stage, 'next_stage', None)
    alt_next_id = getattr(stage, 'alt_next_stage', None)

    prior_stage = Stage.objects.filter(pk=prior_id).first() if prior_id else None
    alt_prior_stage = Stage.objects.filter(pk=alt_prior_id).first() if alt_prior_id else None
    next_stage = Stage.objects.filter(pk=next_id).first() if next_id else None
    alt_next_stage = Stage.objects.filter(pk=alt_next_id).first() if alt_next_id else None

    # 3. Illustrated map hotspots
    hotspots = list(MapLocationCoord.objects.filter(stage_id=stage.id).select_related('location'))

    # 4. Process Path, Elevation, Timeline & GPS coordinates
    chart_points = []
    waypoint_markers = []
    stage_locations = []
    elevation_stats = None
    gps_track = []
    map_waypoints = []
    locations_dict = {}

    try:
        stage_paths = list(Path.objects.filter(stage_id=stage.id).order_by('pk'))

        if stage_paths:
            all_continuous_points = []
            accumulated_distance_m = 0.0
            accumulated_seconds = 0

            # Gather all locations along paths for this stage
            loc_ids = set()
            stage_path_ids = []
            for p in stage_paths:
                stage_path_ids.append(p.pk)
                if p.origin_loc:
                    loc_ids.add(p.origin_loc)
                if p.destination_loc:
                    loc_ids.add(p.destination_loc)

            locations_dict = {loc.pk: loc for loc in Location.objects.filter(pk__in=loc_ids)}
            albergue_loc_ids = set(Albergue.objects.filter(location_id__in=loc_ids).values_list('location_id', flat=True))
            private_loc_ids = set(PrivateAccomm.objects.filter(location_id__in=loc_ids).values_list('location_id', flat=True))

            seen_locations = set()

            def make_location_entry(loc_id, dist_m, secs):
                loc = locations_dict.get(loc_id)
                if not loc:
                    return None

                hours = int(secs // 3600)
                minutes = int((secs % 3600) // 60)
                if hours > 0:
                    time_str = (
                        tr('{hours} hr {minutes} min', hours=hours, minutes=minutes) if minutes > 0
                        else tr('{hours} hr', hours=hours)
                    )
                else:
                    time_str = tr('{minutes} min', minutes=minutes) if minutes > 0 else tr('0 min')

                return {
                    'id': loc.pk,
                    'name': loc.display_name or tr('Location {id}', id=loc.pk),
                    'distance_km': round(dist_m / 1000.0, 1),
                    'time_formatted': time_str,
                    'seconds': int(secs),   # at the guide's pace; the pace slider scales this
                    'has_stay': (loc.pk in albergue_loc_ids) or (loc.pk in private_loc_ids),
                    'has_bar': bool(loc.has_bar_cafe),
                    'has_pharmacy': bool(loc.has_pharmacy),
                    'has_grocery': bool(loc.has_grocery_store),
                }

            total_ascent_m = 0.0
            total_descent_m = 0.0
            prev_elev = None

            for idx, path_obj in enumerate(stage_paths):
                pts = list(
                    ElevationPoint.objects.filter(path=path_obj)
                    .order_by('sequence')
                    .values('distance_along_path_metres', 'elevation_metres')
                )

                origin_id = path_obj.origin_loc
                dest_id = path_obj.destination_loc
                path_dist = path_obj.distance_metres or 0
                path_secs = path_obj.time_seconds or (path_dist / 1.16)

                if idx == 0 and origin_id in locations_dict and origin_id not in seen_locations:
                    seen_locations.add(origin_id)
                    entry = make_location_entry(origin_id, 0.0, 0)
                    if entry:
                        stage_locations.append(entry)
                    if pts:
                        waypoint_markers.append({
                            'location_id': origin_id,
                            'name': entry['name'],
                            'km': 0.0,
                            'elevation': round(pts[0]['elevation_metres'])
                        })

                for pt in pts:
                    elev = pt['elevation_metres']
                    if prev_elev is not None:
                        diff = elev - prev_elev
                        if diff > 0:
                            total_ascent_m += diff
                        else:
                            total_descent_m += abs(diff)
                    prev_elev = elev

                    all_continuous_points.append({
                        'distance_m': accumulated_distance_m + pt['distance_along_path_metres'],
                        'elevation_m': elev
                    })

                seg_end_dist = (
                    accumulated_distance_m + path_dist
                    if path_dist
                    else accumulated_distance_m + (pts[-1]['distance_along_path_metres'] if pts else 0)
                )
                accumulated_seconds += path_secs

                if dest_id in locations_dict and dest_id not in seen_locations:
                    seen_locations.add(dest_id)
                    entry = make_location_entry(dest_id, seg_end_dist, accumulated_seconds)
                    if entry:
                        stage_locations.append(entry)
                    if pts:
                        waypoint_markers.append({
                            'location_id': dest_id,
                            'name': entry['name'],
                            'km': round(seg_end_dist / 1000.0, 1),
                            'elevation': round(pts[-1]['elevation_metres'])
                        })

                accumulated_distance_m = seg_end_dist

            # Calculate Elevation Stats
            if all_continuous_points:
                highest_pt = max(all_continuous_points, key=lambda p: p['elevation_m'])
                lowest_pt = min(all_continuous_points, key=lambda p: p['elevation_m'])
                total_km = round(all_continuous_points[-1]['distance_m'] / 1000.0, 1)

                gain_per_km = total_ascent_m / total_km if total_km > 0 else 0
                if total_ascent_m > 750 or gain_per_km > 35:
                    difficulty_label = tr("Strenuous Mountain Pass")
                    difficulty_badge = "badge-strenuous"
                    difficulty_icon = "⛰️"
                elif total_ascent_m > 400 or total_descent_m > 500:
                    difficulty_label = tr("Moderate / Rolling Hills")
                    difficulty_badge = "badge-moderate"
                    difficulty_icon = "🥾"
                elif total_descent_m > 400 and total_ascent_m < 200:
                    difficulty_label = tr("Continuous Descent")
                    difficulty_badge = "badge-descent"
                    difficulty_icon = "📉"
                else:
                    difficulty_label = tr("Mild / Relatively Flat")
                    difficulty_badge = "badge-easy"
                    difficulty_icon = "🌱"

                elevation_stats = {
                    'ascent_m': int(round(total_ascent_m)),
                    'descent_m': int(round(total_descent_m)),
                    'highest_m': int(round(highest_pt['elevation_m'])),
                    'highest_km': round(highest_pt['distance_m'] / 1000.0, 1),
                    'lowest_m': int(round(lowest_pt['elevation_m'])),
                    'lowest_km': round(lowest_pt['distance_m'] / 1000.0, 1),
                    'difficulty_label': difficulty_label,
                    'difficulty_badge': difficulty_badge,
                    'difficulty_icon': difficulty_icon,
                }

                # Downsample points for chart
                total_pts = len(all_continuous_points)
                step = max(1, total_pts // 160)
                sampled_points = all_continuous_points[::step]
                if all_continuous_points[-1] not in sampled_points:
                    sampled_points.append(all_continuous_points[-1])

                chart_points = [
                    {
                        'x': round(p['distance_m'] / 1000.0, 2),
                        'y': round(p['elevation_m'])
                    }
                    for p in sampled_points
                ]

            # 5. Extract GPS track coordinates for the interactive Leaflet map
            track_pts = list(
                TrackPoint.objects.filter(path_id__in=stage_path_ids)
                .order_by('track_point_id')
                .values('latitude', 'longitude')
            )
            if track_pts:
                gps_track = [
                    [float(pt['latitude']), float(pt['longitude'])]
                    for pt in track_pts
                    if pt['latitude'] is not None and pt['longitude'] is not None
                ]
            else:
                elev_pts = list(
                    ElevationPoint.objects.filter(path_id__in=stage_path_ids)
                    .order_by('sequence')
                    .values('latitude', 'longitude')
                )
                gps_track = [
                    [float(pt['latitude']), float(pt['longitude'])]
                    for pt in elev_pts
                    if pt['latitude'] is not None and pt['longitude'] is not None
                ]

            # Build waypoint coordinates for Leaflet markers
            for loc in stage_locations:
                loc_obj = locations_dict.get(loc['id'])
                if loc_obj and loc_obj.latitude and loc_obj.longitude:
                    map_waypoints.append({
                        'id': loc['id'],
                        'name': loc['name'],
                        'lat': float(loc_obj.latitude),
                        'lng': float(loc_obj.longitude),
                        'km': loc['distance_km'],
                    })

    except Exception as err:
        traceback.print_exc()
        print(f"[Warning] Error assembling stage data for Stage {stage.id}: {err}")

    # The stage's weighted distance, from the planner's cached figures: the page works out the time at any pace the way the
    # app does. Without it (a build problem) the page scales the stored minutes instead.
    try:
        stage_weighted = planner.get_stage_weights(connection, plan_sections).get(stage.id)
    except Exception:
        logger.warning('Could not get the weighted distance of stage %s', stage.id, exc_info=True)
        stage_weighted = None

    # Two links that leave the site, for the day before the walk: the forecast where the stage ends, and the route on
    # the published Google map (centred between the stage's two ends). Nothing is sent until a link is followed.
    language = 'es' if i18n.is_spanish() else 'en'
    stage_links = {}
    if map_waypoints:
        first, last = map_waypoints[0], map_waypoints[-1]
        stage_links = {
            'end_name': last['name'],
            'weather_url': weather_search_url(last['name'], language),
            'route_map_url': my_maps_viewer_url(
                (first['lat'] + last['lat']) / 2, (first['lng'] + last['lng']) / 2, language),
        }

    context = {
        'stage': stage,
        'prior_stage': prior_stage,
        'alt_prior_stage': alt_prior_stage,
        'next_stage': next_stage,
        'alt_next_stage': alt_next_stage,
        'hotspots': hotspots,
        'stage_map': stage_maps.describe(stage),
        'hotspot_grid_width': stage_maps.HOTSPOT_GRID_WIDTH,
        'stage_locations': stage_locations,
        'elevation_stats': elevation_stats,
        'chart_points_json': json.dumps(chart_points),
        'waypoint_markers_json': json.dumps(waypoint_markers),
        'has_elevation_data': len(chart_points) > 0,   # also what the GPX download is made from
        'gps_track_json': json.dumps(gps_track),
        'map_waypoints_json': json.dumps(map_waypoints),
        'has_gps_track': len(gps_track) > 0,
        'pace': {'default': planner.DEFAULT_PACE, 'min': planner.PACE_MIN, 'max': planner.PACE_MAX,
                 'step': planner.PACE_STEP, 'flat': planner.FLAT_SLOPE_EFFECT},
        'stage_weighted': stage_weighted,
        'stage_links': stage_links,
    }
    origin = seo.site_origin(request)
    context['seo'] = seo.stage_seo(
        stage, origin, origin + request.path, elevation=elevation_stats, stage_map=context['stage_map']
    )
    return render(request, 'camino/stage_detail.html', context)


def stage_gpx(request, stage_id):
    """The stage's route as a GPX download, for GPS apps (Organic Maps, Komoot, Gaia GPS and the like).

    The line is the guide's stored route with the height of every point, and the places along the stage are
    waypoints. The stage and place names are in the language of the page the link was on (/es/ gives Spanish).
    """
    stage = get_object_or_404(Stage, pk=stage_id)
    with connection.cursor() as cursor:
        route = gpx.load_route(cursor, stage.id)
    if len(route['points']) < 2:
        raise Http404('This stage has no route recorded.')
    locations = Location.objects.in_bulk(route['place_ids'])
    places = [
        (locations[pk].display_name, locations[pk].latitude, locations[pk].longitude)
        for pk in route['place_ids']
        if pk in locations and not locations[pk].is_placeholder
    ]
    name = tr('Stage {display_ref}: {stage_name}', display_ref=stage.display_ref, stage_name=i18n.lookup(str(stage.stage_name).strip()))
    body = gpx.build_gpx(
        name, route['points'], places,
        page_url=seo.site_origin(request) + reverse('stage_detail', args=[stage.id]),
    )
    response = HttpResponse(body, content_type='application/gpx+xml; charset=utf-8')
    response['Content-Disposition'] = f'attachment; filename="{gpx.filename(stage.display_ref, stage.id)}"'
    response['Cache-Control'] = 'public, max-age=3600'
    return response


def location_detail(request, location_id):
    location = get_object_or_404(Location, pk=location_id)
    albergues = location.albergues.all()
    private_accomm = location.private_accomm.all()
    paragraphs = location.paragraphs.order_by('id')

    prior_location = None
    if location.prior_loc and location.prior_loc != 0:
        prior_location = Location.objects.filter(pk=location.prior_loc).first()

    next_location = None
    if location.next_loc and location.next_loc != 0:
        next_location = Location.objects.filter(pk=location.next_loc).first()

    parent_stage = None
    coord_entry = MapLocationCoord.objects.filter(location_id=location_id).first()
    if coord_entry and coord_entry.stage_id:
        parent_stage = Stage.objects.filter(pk=coord_entry.stage_id).first()

    context = {
        'location': location,
        'prior_location': prior_location,
        'next_location': next_location,
        'parent_stage': parent_stage,
        'albergues': albergues,
        'private_accomm': private_accomm,
        'paragraphs': paragraphs,
    }
    origin = seo.site_origin(request)
    stage_url = reverse('stage_detail', args=[parent_stage.id]) if parent_stage else None
    context['seo'] = seo.location_seo(
        location, albergues, private_accomm, parent_stage, origin, origin + request.path, stage_url
    )
    context['stay_count'] = len(albergues) + len(private_accomm)
    # A link that leaves the site: a web search for this place's forecast. Only the place's name is sent.
    context['weather_url'] = weather_search_url(weather_place_name(location), 'es' if i18n.is_spanish() else 'en')
    return render(request, 'camino/location_detail.html', context)


def not_found(request, exception=None):
    """Friendly 404 page that search engines are told not to index."""
    context = {'seo': {'title': seo.compose_title(tr('Page not found')), 'noindex': True}}
    return render(request, 'camino/404.html', context, status=404)


def server_error(request):
    """Plain 500 page. It uses no templates or database so it cannot fail itself."""
    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="robots" content="noindex"><title>Something went wrong</title></head>'
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;color:#1e293b">'
        '<h1>Something went wrong</h1>'
        '<p>Sorry, the guide hit a problem. Please try again in a moment.</p>'
        '<p><a href="/" style="color:#1e3a8a">Back to the stages</a></p></body></html>'
    )
    return HttpResponseServerError(html)
