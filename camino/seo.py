# camino/seo.py
"""Helpers that build page titles, descriptions, share tags and schema.org data."""
import json
import re
import unicodedata
from decimal import Decimal

from django.urls import reverse

from .i18n import decimal, lookup, tr

SITE_NAME = 'Saint Jean to Santiago'
TITLE_SUFFIX = ' | ' + SITE_NAME
MAX_TITLE = 65
MAX_DESCRIPTION = 158

DEFAULT_TITLE = 'Camino Francés stages, maps and places to stay'
DEFAULT_DESCRIPTION = (
    'A free offline-friendly guide to the Camino Francés from Saint-Jean-Pied-de-Port '
    'to Santiago: stage maps, elevation profiles, and albergues, hotels and guesthouses '
    'in every town, with prices, opening dates and contact details.'
)


def site_origin(request):
    """Public origin such as https://example.com. Set SITE_URL in production."""
    from django.conf import settings
    return settings.SITE_URL or f'{request.scheme}://{request.get_host()}'


def compose_title(main):
    """Adds the site name when it fits, otherwise returns the main title alone."""
    main = (main or DEFAULT_TITLE).strip()
    if len(main) + len(TITLE_SUFFIX) <= MAX_TITLE:
        return main + TITLE_SUFFIX
    return main


def clip(text, limit=MAX_DESCRIPTION):
    """Shortens text at a word boundary so it fits a search result snippet."""
    text = re.sub(r'\s+', ' ', text or '').strip()
    if len(text) <= limit:
        return text
    cut = text[:limit - 1].rsplit(' ', 1)[0].rstrip(' ,;:.-')
    return cut + '…'


def plural(count, singular, plural_form=None):
    word = singular if count == 1 else (plural_form or singular + 's')
    return f'{count} {word}'


def normalise(text):
    """Lower-case, accent-free text for forgiving search: 'Logroño' -> 'logrono'."""
    decomposed = unicodedata.normalize('NFD', text or '')
    stripped = ''.join(ch for ch in decomposed if unicodedata.category(ch) != 'Mn')
    return re.sub(r'\s+', ' ', stripped.lower()).strip()


def default_title():
    return tr(DEFAULT_TITLE)


def default_description():
    return tr(DEFAULT_DESCRIPTION)


def minutes_text(minutes):
    if not minutes or minutes <= 0:
        return ''
    hours, mins = divmod(int(minutes), 60)
    if hours and mins:
        return f'{hours} h {mins} min'
    return f'{hours} h' if hours else f'{mins} min'


def json_ld(data):
    """Serialises schema.org data safely for a <script type="application/ld+json"> tag."""
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    return text.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def money(value):
    if value in (None, ''):
        return None
    try:
        number = Decimal(str(value))
    except Exception:
        return None
    if number <= 0:
        return None
    if number == number.to_integral_value():
        return f'€{int(number)}'
    return f'€{number:.2f}'


def price_range(minimum, maximum=None):
    low, high = money(minimum), money(maximum)
    if low and high and low != high:
        return f'{low}–{high}'
    return low or high


def telephone(country_code, number):
    """Returns an international phone number string, or None."""
    if not number:
        return None
    cleaned = re.sub(r'[^\d+]', '', str(number))
    if not cleaned:
        return None
    if cleaned.startswith('+'):
        return cleaned
    if cleaned.startswith('00'):
        return '+' + cleaned[2:]
    # The database may hold the code as a number (34) or text ('+34').
    digits = re.sub(r'\D', '', str(country_code or '34')) or '34'
    return '+' + digits + cleaned.lstrip('0')


def breadcrumb(items):
    """items: list of (name, absolute_url)."""
    return {
        '@type': 'BreadcrumbList',
        'itemListElement': [
            {'@type': 'ListItem', 'position': i, 'name': name, 'item': url}
            for i, (name, url) in enumerate(items, start=1)
        ],
    }


def stay_entry(stay, kind, location_name, url):
    """schema.org entry for one albergue ('Hostel') or private stay ('LodgingBusiness')."""
    entry = {
        '@type': 'Hostel' if kind == 'albergue' else 'LodgingBusiness',
        'name': stay.name,
        'url': url,
    }
    address = {'@type': 'PostalAddress', 'addressLocality': location_name}
    if getattr(stay, 'address', None):
        address['streetAddress'] = stay.address
    entry['address'] = address
    phone = telephone(getattr(stay, 'country_code', None), getattr(stay, 'phone', None))
    if phone:
        entry['telephone'] = phone
    email = str(getattr(stay, 'email', None) or '').strip()
    if '@' in email:
        entry['email'] = email
    if getattr(stay, 'latitude', None) and getattr(stay, 'longitude', None):
        entry['geo'] = {
            '@type': 'GeoCoordinates',
            'latitude': float(stay.latitude),
            'longitude': float(stay.longitude),
        }
    if kind == 'albergue':
        price = price_range(stay.rate_1p_min, stay.rate_1p_max)
    else:
        price = price_range(stay.rate_1p_min, getattr(stay, 'rate_2p_min', None))
    if price:
        entry['priceRange'] = price
    website = getattr(stay, 'valid_website_url', None)
    if website:
        entry['sameAs'] = website
    photo = getattr(stay, 'pic1_url', None)
    if photo and str(photo).startswith('http'):
        entry['image'] = photo
    return entry


# A picture is offered to link previews (WhatsApp, Facebook, X) only when its shape suits them: those cards are
# about twice as wide as they are tall and crop anything else. Width divided by height must be inside this range.
SHARE_IMAGE_RATIO = (1.0, 2.6)


def stage_share_image(stage_map):
    """The stage's illustrated map as the page's link-preview picture, or {} to use the site's default one.

    stage_map is what stage_maps.describe() returns. The map is used only when its address is https, its
    size is known (so the preview tags can state it) and its shape is in SHARE_IMAGE_RATIO. A very tall map
    (the 1,794-pixel Roncesvalles stage) or a thin strip (197 pixels high) would be cropped to nothing useful.
    """
    stage_map = stage_map or {}
    url = str(stage_map.get('src') or '').strip()
    width, height = stage_map.get('width'), stage_map.get('height')
    if not (url.lower().startswith('https://') and width and height):
        return {}
    if not SHARE_IMAGE_RATIO[0] <= width / height <= SHARE_IMAGE_RATIO[1]:
        return {}
    return {'image': url, 'image_width': int(width), 'image_height': int(height)}


def stage_description(ref, name, km, duration, elevation=None):
    """The search-result snippet for a stage: distance, time, climb and descent, then what the page holds.

    The fullest version that fits MAX_DESCRIPTION is used. When the stage name is long, the closing sentence
    is shortened first, then dropped, then the walking time is cut down to the bare distance, so that the
    climb is kept for as long as it can fit. Only when nothing with the climb fits is the climb left out.
    """
    intro = tr('Camino Francés stage {ref}: {name}.', ref=ref, name=name)
    distance = ''
    if km:
        distance = (
            tr('{km} km, about {duration} walking.', km=decimal(km), duration=duration) if duration
            else tr('{km} km.', km=decimal(km))
        )
    climb = ''
    if elevation and (elevation.get('ascent_m') or elevation.get('descent_m')):
        climb = tr('Climbs {up} m, descends {down} m.', up=elevation.get('ascent_m') or 0,
                   down=elevation.get('descent_m') or 0)
    long_tail = tr('Elevation profile, route map, villages on the way and where to sleep.')
    short_tail = tr('Elevation profile, map and places to stay.')
    base = [part for part in (intro, distance) if part]
    fact_sets = [base]
    if climb:
        bare_distance = tr('{km} km.', km=decimal(km)) if km else ''
        fact_sets = [
            [part for part in (intro, distance, climb) if part],
            [part for part in (intro, bare_distance, climb) if part],
            base,
        ]
    for facts in fact_sets:
        for tail in (long_tail, short_tail, ''):
            text = ' '.join(facts + ([tail] if tail else []))
            if len(text) <= MAX_DESCRIPTION:
                return text
    return clip(' '.join(base))


def stage_seo(stage, origin, canonical, elevation=None, stage_map=None):
    km = stage.distance_km
    ref = stage.display_ref
    duration = minutes_text(stage.time_minutes)
    name = lookup(stage.stage_name)   # the stage's name in the language of the page
    title = compose_title(
        tr('Stage {ref}: {name} ({km} km)', ref=ref, name=name, km=decimal(km)) if km
        else tr('Stage {ref}: {name}', ref=ref, name=name)
    )
    return {
        'title': title,
        'description': stage_description(ref, name, km, duration, elevation),
        **stage_share_image(stage_map),
        'jsonld': json_ld({
            '@context': 'https://schema.org',
            '@graph': [breadcrumb([
                (tr('Stages'), origin + reverse('stage_list')),
                (tr('Stage {ref}', ref=ref), canonical),
            ])],
        }),
    }


def plan_seo(origin):
    return {
        'title': compose_title(tr('Plan your Camino Francés itinerary')),
        'description': clip(tr(
            'Plan your Camino Francés day by day: choose stages, rest days and places to stay, '
            'see distances and walking times, then send the itinerary to the free app.'
        )),
        'jsonld': json_ld({
            '@context': 'https://schema.org',
            '@graph': [breadcrumb([
                (tr('Stages'), origin + reverse('stage_list')),
                (tr('Plan your Camino'), origin + reverse('plan')),
            ])],
        }),
    }


def location_seo(location, albergues, private_accomm, parent_stage, origin, canonical, stage_url=None):
    albergues = list(albergues)
    private_accomm = list(private_accomm)
    name = location.display_name
    n_alb, n_priv = len(albergues), len(private_accomm)
    if n_alb or n_priv:
        pieces = []
        if n_alb:
            pieces.append(tr('{n} pilgrim albergue', n=n_alb) if n_alb == 1 else tr('{n} pilgrim albergues', n=n_alb))
        if n_priv:
            pieces.append(
                tr('{n} hotel or guesthouse', n=n_priv) if n_priv == 1 else tr('{n} hotels and guesthouses', n=n_priv)
            )
        description = (
            tr('Where to stay in {name} on the Camino Francés: {pieces}.', name=name, pieces=tr(' and ').join(pieces))
            + ' ' + tr('Prices, opening dates, facilities and contact details.')
        )
        title = compose_title(tr('{name}: albergues and hotels on the Camino Francés', name=name))
    else:
        description = tr('{name} on the Camino Francés: village services, history and practical tips for pilgrims.', name=name)
        title = compose_title(tr('{name} on the Camino Francés', name=name))

    if getattr(location, 'is_placeholder', False):
        # A holding place for stays that are off the route: the page works, but search engines skip it and
        # it carries no structured data.
        return {'title': title, 'description': clip(description), 'noindex': True}

    crumbs = [(tr('Stages'), origin + reverse('stage_list'))]
    if parent_stage is not None and stage_url:
        crumbs.append((tr('Stage {ref}', ref=parent_stage.display_ref), origin + stage_url))
    crumbs.append((name, canonical))

    graph = [breadcrumb(crumbs)]
    # Search-engine data must never break the page: skip any entry with unexpected data.
    for kind, stays in (('albergue', albergues), ('private', private_accomm)):
        for stay in stays:
            try:
                graph.append(stay_entry(stay, kind, name, canonical))
            except Exception:
                continue

    image = None
    for a in albergues:
        pic = getattr(a, 'pic1_url', None)
        if pic and str(pic).startswith('http'):
            image = pic
            break
    return {
        'title': title,
        'description': clip(description),
        'image': image,
        'jsonld': json_ld({'@context': 'https://schema.org', '@graph': graph}),
    }


def home_seo(origin):
    return {
        'title': compose_title(tr('Camino Francés stages and places to stay')),
        'description': clip(default_description()),
        'jsonld': json_ld({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            'name': SITE_NAME,
            'url': origin + reverse('stage_list'),
            'inLanguage': 'es' if tr('Stages') != 'Stages' else 'en',
            'potentialAction': {
                '@type': 'SearchAction',
                'target': origin + reverse('search') + '?q={search_term_string}',
                'query-input': 'required name=search_term_string',
            },
        }),
    }
