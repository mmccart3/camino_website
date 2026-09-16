# Camino de Santiago Accommodation & Route Guide

An interactive, mobile-optimized guide for pilgrims walking the Camino de Santiago (Camino Francés). The application provides stage-by-stage route information, interactive visual maps with clickable town hotspots, elevation profiles, and detailed accommodation directories covering municipal/parochial albergues and private B&Bs/hotels.

---

## Features

* **Sequential Stage & Route Pairing:** Automatically orders stages from Saint-Jean-Pied-de-Port to Santiago de Compostela. Alternate route options (such as the Valcarlos variant or the Samos monastery detour) are grouped and displayed side by side with the main route.
* **Interactive Responsive Maps:** Stage overview maps feature an adaptive SVG coordinate overlay with clickable town/village bounding boxes that scale across mobile, tablet, and desktop viewports.
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

## Getting Started Locally

### Prerequisites

* Python 3.10+
* Git

### Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/your-username/camino-accommodation-guide.git](https://github.com/your-username/camino-accommodation-guide.git)
   cd camino-accommodation-guide
