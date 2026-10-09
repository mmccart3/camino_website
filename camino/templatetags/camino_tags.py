# camino/templatetags/camino_tags.py
from django import template
from urllib.parse import urlparse

register = template.Library()

PARTNER_QUERY = (
    "aid=818289&label=affnetcj-15734710_pub-8073556_site-101884570_"
    "pname-MM3+Enterprise+Limited_clkid-_cjevent-5b29e765ba1911f180aa00a10a18b8f7"
    "&utm_source=affnetcj&utm_medium=bannerindex&utm_campaign=fr&utm_term=index-15734710"
)

@register.filter
def partner_booking_url(url):
    if not url or url == "not on Booking" or url == "NULL":
        return ""
    
    # Strip any existing query strings (such as ?aid=1627093)
    parsed = urlparse(url)
    clean_base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    
    # Append the new affiliate partner string
    return f"{clean_base}?{PARTNER_QUERY}"

@register.filter
def format_duration(minutes):
    """
    Converts minutes (int) into a human-readable duration, e.g.:
    330 -> "5 hrs 30 mins"
    60  -> "1 hr"
    45  -> "45 mins"
    """
    if minutes is None or minutes == "":
        return "--"
    
    try:
        total_mins = int(minutes)
    except (ValueError, TypeError):
        return minutes

    if total_mins <= 0:
        return "--"

    hours = total_mins // 60
    remaining_mins = total_mins % 60

    parts = []
    if hours > 0:
        parts.append(f"{hours} hr" if hours == 1 else f"{hours} hrs")
    if remaining_mins > 0:
        parts.append(f"{remaining_mins} min" if remaining_mins == 1 else f"{remaining_mins} mins")

    return " ".join(parts) if parts else "0 mins"