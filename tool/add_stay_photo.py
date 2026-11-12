#!/usr/bin/env python3
"""Prepares a photo of an albergue for the website.

    python tool/add_stay_photo.py 4412 1 "C:\\Users\\me\\Pictures\\ospitalia.jpg"
    python tool/add_stay_photo.py 4412 2 dorm.png --database C:\\Users\\me\\src\\camino_app\\assets\\database\\camino.sqlite
    python tool/add_stay_photo.py 4412 1 --remove --database ...        # take a photo away again

The three things on the line are the albergue's ID, which photo it is (1, 2 or 3) and the picture file (JPEG, PNG,
WebP or anything else Pillow reads). The tool

  * turns the picture the right way up and removes what the camera wrote into it (place, date, phone model);
  * saves a large copy, at most 1400 pixels wide, as   camino/static/camino/img/stays/a<ID>-<n>.webp
    and a small copy for the card, 480 by 320,   as    camino/static/camino/img/stays/a<ID>-<n>-s.webp
  * tells you what to put in the albergue's photo column (alberguepic1URL, 2 or 3): the file name, a4412-1.webp.
    With --database it writes that into the database for you. The app's database is the master, so give that one,
    then run the usual sync to the website. --database can be given more than once.

Then commit the two new files with the website. A place shows its photos only when both the file and the column are
there, so the order in which they arrive does not matter.

Needs Pillow:  pip install Pillow   (only for this tool; the website itself does not use it).
"""
import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHOTO_DIR = ROOT / 'camino' / 'static' / 'camino' / 'img' / 'stays'
LARGE_WIDTH = 1400
SMALL_SIZE = (480, 320)
POSITIONS = (1, 2, 3)


def names(albergue_id, position):
    stem = f'a{int(albergue_id)}-{int(position)}'
    return f'{stem}.webp', f'{stem}-s.webp'


def make_copies(source, albergue_id, position, photo_dir=PHOTO_DIR):
    """Writes the large and the small copy and returns their paths."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise SystemExit('This tool needs Pillow. Install it with:  pip install Pillow')
    large_name, small_name = names(albergue_id, position)
    photo_dir = Path(photo_dir)
    photo_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as opened:
        picture = ImageOps.exif_transpose(opened).convert('RGB')   # upright; a new picture, so nothing the camera wrote comes along
    if min(picture.size) < 200:
        raise SystemExit(f'{source} is only {picture.size[0]} by {picture.size[1]} pixels: too small to show.')
    large = picture.copy()
    if large.width > LARGE_WIDTH:
        large = large.resize((LARGE_WIDTH, round(large.height * LARGE_WIDTH / large.width)), Image.LANCZOS)
    small = ImageOps.fit(picture, SMALL_SIZE, Image.LANCZOS, centering=(0.5, 0.5))   # cropped to the card's shape
    large.save(photo_dir / large_name, 'WEBP', quality=80, method=6)
    small.save(photo_dir / small_name, 'WEBP', quality=72, method=6)
    return photo_dir / large_name, photo_dir / small_name


def albergue_name(database, albergue_id):
    """The albergue's name, or None when the database has no albergue with that ID."""
    con = sqlite3.connect(database)
    try:
        row = con.execute('SELECT albergueName FROM albergues WHERE ID = ?', (int(albergue_id),)).fetchone()
        return row[0] if row else None
    finally:
        con.close()


def set_column(database, albergue_id, position, value):
    """Writes the photo column of one albergue. Returns the albergue's name."""
    column = f'alberguepic{int(position)}URL'
    con = sqlite3.connect(database)
    try:
        row = con.execute('SELECT albergueName FROM albergues WHERE ID = ?', (int(albergue_id),)).fetchone()
        if row is None:
            raise SystemExit(f'{database}: there is no albergue with ID {albergue_id}. Nothing was changed in it.')
        con.execute(f'UPDATE albergues SET "{column}" = ? WHERE ID = ?', (value, int(albergue_id)))
        con.commit()
        return row[0]
    finally:
        con.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Prepare a photo of an albergue for the website.')
    parser.add_argument('albergue_id', type=int, help="the albergue's ID in the albergues table")
    parser.add_argument('position', type=int, choices=POSITIONS, help='which photo: 1, 2 or 3')
    parser.add_argument('picture', nargs='?', help='the picture file')
    parser.add_argument('--database', action='append', default=[], help='a camino.sqlite to write the file name into')
    parser.add_argument('--remove', action='store_true', help='delete this photo instead of adding one')
    args = parser.parse_args(argv)
    large_name, small_name = names(args.albergue_id, args.position)
    column = f'alberguepic{args.position}URL'

    for database in args.database:
        if not Path(database).is_file():
            raise SystemExit(f'{database} was not found. Nothing was changed.')
        if albergue_name(database, args.albergue_id) is None:
            raise SystemExit(f'{database}: there is no albergue with ID {args.albergue_id}. Nothing was changed.')

    if args.remove:
        for name in (large_name, small_name):
            (PHOTO_DIR / name).unlink(missing_ok=True)
        for database in args.database:
            set_column(database, args.albergue_id, args.position, None)
            print(f'Cleared {column} of albergue {args.albergue_id} in {database}')
        print(f'Removed {large_name} and {small_name}.')
        if not args.database:
            print(f'Now empty the column {column} of albergue {args.albergue_id} in the app database.')
        return 0

    if not args.picture:
        parser.error('give the picture file (or --remove)')
    if not Path(args.picture).is_file():
        raise SystemExit(f'{args.picture} was not found.')
    large, small = make_copies(args.picture, args.albergue_id, args.position)
    print(f'Saved {large.relative_to(ROOT)} ({large.stat().st_size // 1024} KB) and '
          f'{small.relative_to(ROOT)} ({small.stat().st_size // 1024} KB).')
    for database in args.database:
        name = set_column(database, args.albergue_id, args.position, large_name)
        print(f'Set {column} of "{name}" (ID {args.albergue_id}) to {large_name} in {database}')
    if not args.database:
        print(f'Now put   {large_name}   in the column {column} of albergue {args.albergue_id} in the app database,')
        print('and sync the website database as usual.')
    print('Commit the two new files with the website.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
