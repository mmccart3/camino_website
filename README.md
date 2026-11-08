# Camino de Santiago Accommodation & Route Guide

An interactive, mobile-optimized guide for pilgrims walking the Camino de Santiago (Camino Francés). The application provides stage-by-stage route information, interactive visual maps with clickable town hotspots, elevation profiles, and detailed accommodation directories covering municipal/parochial albergues and private B&Bs/hotels.

---

## Features

* **Sequential Stage & Route Pairing:** Automatically orders stages from Saint-Jean-Pied-de-Port to Santiago de Compostela. Alternate route options (such as the Valcarlos variant or the Samos monastery detour) are grouped and displayed side by side with the main route.
* **Interactive Responsive Maps:** Stage overview maps feature an adaptive SVG coordinate overlay with clickable town/village bounding boxes that scale across mobile, tablet, and desktop viewports. The browser is offered three sizes of each map (360, 640 and 1024 pixels wide) and picks one by screen width and sharpness, so a phone does not download the desktop picture; the hotspots are measured on the 1024 picture and scale to whichever one is shown.
* **English and Spanish:** every page is available in English (plain addresses) and in Spanish (under `/es/`), with a language link in the menu and footer.
* **Elevation Profiles & Stage Stats:** Each stage includes distance (km), estimated walking time, and elevation charts to help plan daily ascents and descents.
* **Comprehensive Accommodation Directory:**
  * **Pilgrim Albergues:** Bed counts, seasonal opening periods, check-in windows, pricing, and amenity badges (kitchen, laundry, communal meals).
  * **Private Accommodations & B&Bs:** Single/double room rates, addresses, and property notes.
  * **One-Tap Direct Actions:** Direct telephone links (`tel:`), instant WhatsApp chat launch (`https://wa.me/`), direct email links (`mailto:`), official websites, and direct Booking.com affiliate links.
* **Practical Advice & History:** Curated notes for each town detailing local history, pilgrim Mass schedules, ATM availability, detours, and grocery points.

---

## Architecture & Tech Stack

* **Backend Framework:** Django (Python 3)
* **Database:** SQLite3 (`camino.sqlite`) using unmanaged Django ORM models (`managed = False`) to query the pre-populated relational schema.
* **Frontend:** Server-side rendered HTML5 with semantic CSS (no heavy JavaScript frameworks, ensuring fast loading over weak cellular connections along the trail).
* **Overlay Layer:** Inline dynamic SVG synchronized to the natural pixel dimensions of the stage maps.
* **Production Static Asset Handling:** WhiteNoise with Gunicorn WSGI server.

---

## Database Structure Overview

The underlying `camino.sqlite` database powers the application via the following key tables:

* `stages`: Stage names, distances, times, elevation charts, and responsive image URLs.
* `locations`: Waypoint coordinates, town names, and sequential route pointers.
* `mapLocationCoords`: Bounding box pixel coordinates (`topLeftX`, `topLeftY`, `bottomRightX`, `bottomRightY`) used to project town hotspots onto the stage maps.
* `albergues`: Details on dorm-style and pilgrim hostels, amenities, and contact info.
* `privateAccommDetail`: Details on private rooms, guesthouses, and hotels.
* `paragraphs`: Historical background, warnings, Mass times, and navigational tips.

---

## Updating the data

The website only reads `camino.sqlite`. It has no login, admin or editing pages, so data is changed in the database itself with [DBeaver Community Edition](https://dbeaver.io/) (New Database Connection, SQLite, choose the file).

1. **The app's database is the master copy**: `assets/database/camino.sqlite` in the `camino_app` project. Take a copy of the file, then make your edits there in DBeaver and commit them (leave auto-commit on, or press Commit).
2. **Disconnect** the connection in DBeaver so the file is not locked.
3. **Copy the changes into the website** with the sync script in the app project (standard-library Python, nothing to install):
   `python tool/sync_website_database.py --app assets/database/camino.sqlite --website <this project>/camino.sqlite --out <new file> --report-dir docs/website_sync`
   It builds a new file and a report of every row it changed or dropped. Read the report, then copy the new file over `camino.sqlite` here.
4. Run `python manage.py test camino`, commit `camino.sqlite` and push.
5. Optional check: `python tool/audit_database.py camino.sqlite --app <camino_app>/assets/database/camino.sqlite` (standard-library Python, read-only). It lists broken links between tables, impossible GPS positions, duplicates, placeholder towns, route-data problems and differences between the two databases, ranked as errors, warnings and notes. `--markdown report.md` saves the report.

Edits made directly in this project's `camino.sqlite` are replaced the next time the sync runs, unless the same edit is also made in the app database. The file still holds some unused Django tables (`auth_*`, `django_*`); they are harmless and the sync leaves them alone.

## Getting Started Locally

### Prerequisites

* Python 3.10+
* Git

### Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/your-username/camino-accommodation-guide.git](https://github.com/your-username/camino-accommodation-guide.git)
   cd camino-accommodation-guide

---

## Offline use, installing and search engines

* **Install / offline:** `/manifest.webmanifest` and `/sw.js` are generated by Django (`camino/views.py`). The service worker file is `camino/static/camino/js/sw.js`; its cache names include `APP_VERSION`, so **bump `APP_VERSION` for every release that changes templates, JavaScript or CSS**. Visitors then see an "A new version of the guide is available" prompt. Pages are fetched from the network first (so prices and opening times are current) and fall back to the saved copy after 4 seconds or when offline.
* **Save for offline:** `/offline-pack/` downloads every stage and town page (and optionally the stage map pictures) into the browser. The list comes from `/offline-pack.json`.
* **Map tiles** are only saved for areas the visitor has already looked at (no bulk tile downloads).
* **SEO:** titles, descriptions, canonical links, share previews and schema.org data are built in `camino/seo.py`. `/robots.txt` and `/sitemap.xml` are generated from the database.
* **Set `SITE_URL`** (for example `https://www.example.com`) in production so canonical links, share previews and the sitemap use your public address.
* **Search:** the home page suggests towns as you type (works offline); `/towns/` lists every town; `/search/?q=` is the no-JavaScript fallback.
* **Tests:** `python manage.py test camino` (the live-data test classes read the real `camino.sqlite`, read-only) and `node --test camino/jstests/*.test.js`.

---

## Environment variables and security

| Variable | Where | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | Production (required) | Long random string. The app refuses to start without it when `DEBUG` is not `True`. |
| `SITE_URL` | Production | Public address, e.g. `https://saintjeantosantiago.com`. |
| `DEBUG` | Your computer only | Set `$env:DEBUG = "True"` locally to serve static files. Never set it on Railway. |
| `ALLOWED_HOSTS` | Optional | Comma-separated hosts. Defaults to the live domain, `www.`, and `*.up.railway.app`. |
| `HSTS_SECONDS` | Optional | Defaults to 3600. Raise to 31536000 once HTTPS is confirmed everywhere. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Local, for `sync_albergue_photos` | Photo upload credentials. Never commit them. |

Production serves HTTPS only (HTTP is redirected) and uses secure cookies. The site has no login, admin or editing pages at all; it only reads the database.

Generate a key with: `python -c "import secrets; print(secrets.token_urlsafe(64))"`

For local development, copy `.env.example` to `.env` (git-ignored). Settings read it automatically, so `python manage.py runserver` works without setting environment variables. Production uses Railway's variables instead, and uses a different `SECRET_KEY`.

## English and Spanish

Every page exists in English at its plain address and in Spanish under `/es/` (`/es/plan/`, `/es/stage/3/`, `/es/location/20/`). The plain address is always English, whatever language the browser asks for; the language link in the menu and footer goes to the same page in the other language, and every page carries `hreflang` links (and the sitemap lists both) so search engines show the right one. `/es/search/` is not indexed. The installed app, the offline pack and the offline pages follow the language of the page they were installed from.

* **Text:** nothing is compiled. English is written in the templates (`{% t "Text" %}`, `{% t_attr %}` inside an attribute, `{% tjs %}` for text a page script shows) and in the code (`tr('Text {x}', x=1)`); the Spanish is in `camino/locale/es.json`, a plain list of `"English text": "Texto en español"` pairs. A phrase with no Spanish is shown in English, so a new English phrase never breaks a page. Keep the `{placeholders}` the same in both. The file has three parts: `ui` (pages and stage names), `js` (scripts on every page) and `plan` (the planner, plus the Spanish for the stays' opening periods, check-in times and price notes and for the few route markers named in English, such as "Exit to Huarte").
* **After editing `es.json`** run `python tool/build_spanish_js.py` and commit the two files it writes (`camino/static/camino/js/i18n-es.js` and `i18n-es-plan.js`); a test fails when they are out of date. `python manage.py test camino` also fails if a phrase in a template, in the Python or in a script has no Spanish.
* **Data:** the Spanish text of each town paragraph is `paragraphs.paragraphTextEs` (machine-translated in the app's database; have a Spanish speaker review it). Stage names come from the app's translations. When the database gets a new opening period, check-in time, price note or English-named marker, the Spanish pages show it in English until it is added to `es.json`; `python tool/audit_database.py camino.sqlite` lists them under "Spanish version".
* **Numbers and dates** follow the language: 12,5 km in Spanish, 12.5 km in English. In templates and scripts that put a number into markup (SVG sizes, JSON), the number is written without the Spanish comma (`{% localize off %}`).
* **Tests:** `camino/test_i18n.py` (helpers, catalogue completeness, the generated files, the pages in both languages) and `camino/jstests/i18n.test.js`.

## Itinerary planner

`/plan/` lets a visitor build an itinerary (walking days, rest days, travel days, places to stay) and download a
file that the Saint Jean to Santiago app opens with Settings, Backup and restore, Restore backup. Nothing
is sent to the server: the plan is kept in the visitor's browser.

A walking day is added by choosing where to stop: the page lists the towns ahead (anywhere with a place
to stay, or a guidebook stage start or finish), nearest first, with the distance and time. A day can end
in between the guidebook's stage ends. Where there are several routes to a town (for example the Napoleon
and Valcarlos routes out of Saint Jean) the visitor picks one. A day that happens to match a guidebook stage
is saved as that stage. The page works out each day the way the app does, so the file opens with the same
figures.

A day can be changed afterwards: "Change where it ends" on a walking day lists the towns from that day's start.
The place to stay is cleared if the end moves. When a day no longer starts where the one before ended and a
route exists, its warning has a "Start this day from ..." button. The send card says where the plan goes and how
far short of Santiago it stops. There is no separate "finish" step: the file can be downloaded at any time.

A rest day takes its place from where the day before ended, except as the first day of a plan, which has no day
before it and asks where it is (`at` in the plan state; a town on the Camino or any place). "Rest somewhere else"
on a later rest day adds the journey in front of it. A travel day can be ticked "Same day as the day before" (walk, then bus): it then shares that
day's date and later days do not move. The pair is one numbered day in parts, "Day 3 – part 1" and
"Day 3 – part 2" (`dayLabel` and `dayRef` in `plan-core.js`), and "Add a day after" always goes after the last
part. The app currently flags the shared date as a problem and numbers the journey as its own day; see
`docs/same_day_travel_brief.md` in the app project.

A stay can carry a booking reference, a contact and notes; a travel day can say how it is made (flight, train, bus,
taxi, ferry, other), when it leaves and arrives, and carry a ticket reference and notes. The file has them all
(`stay.reference/contact/notes`; `route.departureMinutes` and `route.travel` for a travel day, which today's app
drops on restore). A plan code has the stay reference and every travel detail, but not a stay's contact or notes.

The list of places to stay shows what the guide knows about each: a price, beds and facilities on one line, and a
Details button with the address, opening dates, check-in times and links to call, WhatsApp, email, the website and
Booking.com (with the site's affiliate details, added by `bookingLink` in `plan-core.js` the way the town pages do
it). A chosen place shows the same line and links on its day. These come from `/plan/stays.json`
(`planner.build_stay_details`, about 270 KB), which the page loads the first time it needs it, not with the page; the
service worker saves it when it installs and answers from that copy offline. Without it the picker shows names only.
Nothing in it changes the guide fingerprint, so plans and plan codes made earlier still open.

A chosen place that has a WhatsApp number or an email address also has an "Ask for a bed" button. It opens a short
form (arrival date, which is that day's date when the plan has dates; nights; people; bed or private room, offered
only for an albergue the guide records as having private rooms; and an optional name) and writes the message the phone
app writes: polite, in the owner's language (Spanish, or French where `lg` is `fr` in `/plan/stays.json`, which
`planner.owner_language` works out with the app's own rules), asking for the price and for a reply in English, with an
English "What this says". The visitor can edit it, then send it from their own WhatsApp or email program (the buttons
are plain `wa.me` and `mailto:` links) or copy it. Nothing is sent by the page. The wording and its tests are the app's
(`plan-message.js`, `jstests/plan-message.test.js`; the source is `lib/services/booking_message.dart` in the app
project, so change the two together). The name and the number of people are remembered in this browser only.

Each walking day shows its climb and descent ("1,534 m up, 768 m down"), the summary adds the totals, the list of towns
ahead shows the climb to each, and a walking day over 30 km is marked "Long day" (`LONG_DAY_METRES` in `plan-core.js`).
The figures are worked out the way the stage pages work them out: every step up along the guide's elevation points is
climb, every other step is descent, laid end to end across a day's paths. The page data carries four more numbers per
path (climb, descent, first and last height, from `elevation_points`; `planner.climb_of`) and the page adds up whatever
chain of paths the visitor chooses, counting the step between one path's last height and the next one's first. A test
checks all 44 stages against the stage-page method. They do not go in the plan file or the plan code and do not change
the guide fingerprint. Note that the app's walking-day screen measures the climb from the track points, which come out
about 7% lower, so the two will not agree to the metre.

The "Keep your plan" card is about not losing a plan. The plan being worked on is saved in this browser after every
change (`camino-plan-v1`, with the time of the last save). "Save in this browser" also keeps named copies
(`camino-plans-v1`, up to 20; saving under a name that is already taken asks whether to replace it or keep both) and
asks the browser to keep them (`navigator.storage.persist()`, only when the visitor presses the button). The list
says plainly that a browser may clear what it keeps (Safari after a week without a visit) and points to the file.
"Save a copy..." writes the same itinerary file as "Download itinerary file", through the browser's save dialog
where it has one (Chrome and Edge, so the visitor can choose a folder their cloud drive keeps in step) and as a download
elsewhere. "Open a plan file..." reads such a file, or a backup made by the app, back in (`readFile` in `plan-core.js`):
each plan in it can be chosen, days whose routes this guide does not have are left out and said so, a place to stay
the guide does not know keeps its name as the visitor's own choice, dates are made to follow on from the first day, and a
file made for a different edition of the guide is refused. Opening replaces the plan on the page and offers Undo. What
the file cannot say is lost: a same-day journey in a plan with no dates comes back as a day of its own. There is no account,
no server storage and no Google Drive link on purpose: the plan has booking references in it and the page sends nothing anywhere.

The "Print or save as PDF" card makes a clean sheet with the browser's own print window (so "Save as PDF" is the
PDF; there is no PDF library). `buildPrint` in `plan.js` fills `#plan-print`, a table of the days built from the same
layout as the page; it is hidden on screen, and a print stylesheet (the end of `plan.css`) hides everything else, so
Ctrl+P prints the same sheet (`beforeprint`). The visitor chooses whether to show dates, places to stay, and booking
references, contacts and notes (off unless ticked, because paper gets seen), and whether each day is in full (time,
climb, where to stay) or a short line. The choices are remembered in this browser (`camino-plan-print-v1`). The
column heads repeat on each page and a day is never split across two.

The card at the foot of the plan always offers the next day ("Day 10"), which reads oddly once a plan is finished. "My
plan is complete" puts that card away and shows "Your plan is complete" with an "Add another day" button in its place.
The mark is `done: true` on the plan state (`Plan.setDone`; `clean` keeps it only for a plan with days), so it is saved
with the working plan and with saved copies. It is not in the file or the plan code, which carry the plan and nothing
more; a plan opened from a file or a link is shown as complete, since it was made elsewhere. A day added at the end
(`insertDay`) takes the mark off; a day put in the middle, or any other change, leaves it. The add card comes back by
itself while a day is being put in the middle or changed (`renderDone` in `plan.js`).

A plan can be shared as a QR code or a link ("Share as QR code" on the send card). The code holds the choices
(stage numbers, routes, places to stay, dates, pace, and any booking references and travel details) in a few hundred
bytes, never distances or times, and goes in
the link's fragment (`/plan/#p=...`), which a browser never sends to the server. Opening such a link shows a card
("A plan has been shared with you") and opens nothing until the visitor says so; an existing plan can be put back
with Undo. A code made for a different edition of the guide, or damaged, is refused with a plain message. A code is version 1
unless the plan needs version 2 (a rest day first, a reference, a travel detail), so plain plans still open in an
app that only reads version 1, which says "newer version" for the rest. The layout
is `docs/itinerary_qr_code_spec.md` in the app project, with test vectors. `plan-share.js` makes and reads the
code, `qr.js` draws it (a small QR generator written for the site, because no library could be fetched; checked by
decoding its output with OpenCV, `python camino/jstests/qr_decode_check.py`).

- `camino/planner.py` works out each stage's distance and walking time from the track points, using the
  same arithmetic as the app, and builds the data embedded in the page, including a graph of how the
  paths join (`routes`, with each path's climb and descent) so the page can build a day between any two towns. `camino/test_planner.py` checks
  it against the stored stage distances and times, and that walking every stage through the graph gives
  the same figures.
- `camino/static/camino/js/plan-core.js` holds the planner's rules and the file builder;
  `plan.js` draws the page. Tests for the rules, the plan code and the QR generator: `node --test`
  (Node 18 or newer).
- The file format is described in the app project's `docs/itinerary_exchange_format.md`.
- Change the guide data (stages, paths, track points) and the page picks it up when the database file
  changes. Remember to run the app's sync script first, so the website and the app agree.
