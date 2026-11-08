# camino/templatetags/camino_i18n.py
"""{% t "English text" name=value %} and the |tr filter: the guide's English/Spanish text. See camino/i18n.py."""
import json

from django import template
from django.utils.html import conditional_escape
from django.utils.safestring import mark_safe

from .. import i18n

register = template.Library()


@register.simple_tag
def t(message, **values):
    """The phrase in the language of the page. {placeholders} are filled with the (escaped) values.

    The phrase itself is written by the site's author, so it is trusted and may hold simple HTML such as
    &rarr; or <strong>; only the values are escaped.
    """
    safe_values = {name: conditional_escape(value) for name, value in values.items()}
    return mark_safe(i18n.fill(i18n.lookup(message), message, safe_values))


@register.simple_tag
def t_attr(message, **values):
    """Like {% t %}, for text inside a quoted HTML attribute (a double quote in the text is escaped)."""
    safe_values = {name: conditional_escape(value) for name, value in values.items()}
    text = i18n.fill(i18n.lookup(message), message, safe_values)
    return mark_safe(text.replace('"', '&quot;'))


@register.simple_tag
def tjs(message):
    """The phrase as a JavaScript string literal, for text a page script puts on the screen.

    {placeholders} are left in for the script to fill (see fmt() in the stage page). Safe inside <script>.
    """
    text = json.dumps(i18n.lookup(message), ensure_ascii=False)
    for char, escape in (('<', '\\u003c'), ('>', '\\u003e'), ('&', '\\u0026'), ('\u2028', '\\u2028'), ('\u2029', '\\u2029')):
        text = text.replace(char, escape)
    return mark_safe(text)


@register.filter(name='tr')
def tr_filter(value):
    """Translates a piece of data that has a Spanish form in the catalogue (a stage name, a stay's opening
    period). English pages, and data with no Spanish yet, show the value as it is."""
    if value is None or not i18n.is_spanish():
        return value
    text = str(value).strip()
    return i18n.lookup(text) if text else value
