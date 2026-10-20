# camino/seo.py
"""Helpers that build page titles, descriptions, share tags and schema.org data."""
import json
import re
import unicodedata
from decimal import Decimal

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
    code = (country_code or '+34').strip()
    return code + cleaned.lstrip('0')


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
    if getattr(stay, 'email', None) and '@' in stay.email:
        entry['email'] = stay.email.strip()
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


def stage_seo(stage, origin, canonical):
    km = stage.distance_km
    ref = stage.display_ref
    duration = minutes_text(stage.time_minutes)
    title = compose_title(f'Stage {ref}: {stage.stage_name} ({km} km)' if km else f'Stage {ref}: {stage.stage_name}')
    parts = [f'Camino Francés stage {ref}: {stage.stage_name}.']
    if km:
        parts.append(f'{km} km' + (f', about {duration} walking.' if duration else '.'))
    parts.append('Elevation profile, route map, villages on the way and where to sleep.')
    return {
        'title': title,
        'description': clip(' '.join(parts)),
        'jsonld': json_ld({
            '@context': 'https://schema.org',
            '@graph': [breadcrumb([
                ('Stages', origin + '/'),
                (f'Stage {ref}', canonical),
            ])],
        }),
    }


def location_seo(location, albergues, private_accomm, parent_stage, origin, canonical, stage_url=None):
    albergues = list(albergues)
    private_accomm = list(private_accomm)
    name = location.location_name
    n_alb, n_priv = len(albergues), len(private_accomm)
    if n_alb or n_priv:
        pieces = []
        if n_alb:
            pieces.append(plural(n_alb, 'pilgrim albergue'))
        if n_priv:
            pieces.append(plural(n_priv, 'hotel or guesthouse', 'hotels and guesthouses'))
        description = (
            f'Where to stay in {name} on the Camino Francés: {" and ".join(pieces)}. '
            'Prices, opening dates, facilities and contact details.'
        )
        title = compose_title(f'{name}: albergues and hotels on the Camino Francés')
    else:
        description = f'{name} on the Camino Francés: village services, history and practical tips for pilgrims.'
        title = compose_title(f'{name} on the Camino Francés')

    crumbs = [('Stages', origin + '/')]
    if parent_stage is not None and stage_url:
        crumbs.append((f'Stage {parent_stage.display_ref}', origin + stage_url))
    crumbs.append((name, canonical))

    graph = [breadcrumb(crumbs)]
    graph += [stay_entry(a, 'albergue', name, canonical) for a in albergues]
    graph += [stay_entry(p, 'private', name, canonical) for p in private_accomm]

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
        'title': compose_title('Camino Francés stages and places to stay'),
        'description': clip(DEFAULT_DESCRIPTION),
        'jsonld': json_ld({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            'name': SITE_NAME,
            'url': origin + '/',
            'potentialAction': {
                '@type': 'SearchAction',
                'target': origin + '/search/?q={search_term_string}',
                'query-input': 'required name=search_term_string',
            },
        }),
    }
