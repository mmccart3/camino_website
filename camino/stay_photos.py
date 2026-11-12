# camino/stay_photos.py
"""Photos of a place to stay: up to three, and most places have none.

The guide's albergue table has photo columns (alberguepic1URL to alberguepic4URL). Each holds either

  * a file name, such as  a4412-1.webp : a picture kept in the site at camino/static/camino/img/stays/.
    tool/add_stay_photo.py makes these (and a small copy, a4412-1-s.webp, for the card) from any photo; or
  * a full https address of a picture kept somewhere else.

Anything else, and a file name whose file is not there, is ignored, so a typing slip in the database shows no
picture rather than a broken one. There is no Django in here, so it can be tested on its own.
"""
import re
from pathlib import Path

MAX_PHOTOS = 3
FOLDER = 'camino/img/stays'                                   # under the static folder
PHOTO_DIR = Path(__file__).resolve().parent / 'static' / 'camino' / 'img' / 'stays'
SMALL_SUFFIX = '-s'

# A file name only: letters, digits, dot, dash and underscore, so it can never point outside the folder.
_FILE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(webp|jpe?g|png)$', re.IGNORECASE)
_WEB_ADDRESS = re.compile(r'^https://[^\s"\'<>]+$')


def small_name(file_name):
    """The name of the small copy of a picture: a4412-1.webp -> a4412-1-s.webp"""
    stem, _dot, _ext = file_name.rpartition('.')
    return f'{stem}{SMALL_SUFFIX}.webp'


def photos(values, static_url='/static/', photo_dir=None):
    """[{'small': address for the card, 'full': address of the large picture}], at most MAX_PHOTOS.

    values      the photo columns of one place, in order; empty ones are skipped
    static_url  the site's STATIC_URL
    photo_dir   where the picture files are (for tests); the site's own folder when left out
    """
    folder = Path(photo_dir) if photo_dir is not None else PHOTO_DIR
    base = static_url.rstrip('/') + '/' + FOLDER + '/'
    found = []
    for value in values:
        text = str(value or '').strip()
        if not text:
            continue
        if _WEB_ADDRESS.match(text):
            found.append({'small': text, 'full': text})
        elif _FILE_NAME.match(text) and (folder / text).is_file():
            small = small_name(text)
            found.append({'small': base + (small if (folder / small).is_file() else text), 'full': base + text})
        if len(found) == MAX_PHOTOS:
            break
    return found
