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