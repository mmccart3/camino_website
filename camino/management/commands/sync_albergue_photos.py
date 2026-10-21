import os
import re
import urllib.parse
import requests
from bs4 import BeautifulSoup
from django.core.management.base import BaseCommand, CommandError
import cloudinary
import cloudinary.uploader
from camino.models import Albergue

def configure_cloudinary():
    """Reads the Cloudinary credentials from environment variables (never store them in code).

    PowerShell example:
        $env:CLOUDINARY_CLOUD_NAME = "your-cloud-name"
        $env:CLOUDINARY_API_KEY = "..."
        $env:CLOUDINARY_API_SECRET = "..."
    """
    names = ('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET')
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise CommandError('Set these environment variables first: ' + ', '.join(missing))
    cloudinary.config(
        cloud_name=os.environ['CLOUDINARY_CLOUD_NAME'],
        api_key=os.environ['CLOUDINARY_API_KEY'],
        api_secret=os.environ['CLOUDINARY_API_SECRET'],
        secure=True,
    )

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def extract_candidate_images(url):
    """
    Scrapes candidate images from the albergue's homepage.
    Guaranteed to return a dict with keys: 'exterior', 'bunk', 'bathroom', 'general'.
    """
    candidates = {"exterior": None, "bunk": None, "bathroom": None, "general": []}
    
    if not url or not url.startswith(("http://", "https://")):
        return candidates

    try:
        resp = requests.get(url, headers=HEADERS, timeout=12, verify=False)
        if resp.status_code != 200 or not resp.content:
            return candidates

        soup = BeautifulSoup(resp.content, "html.parser")
        images = soup.find_all("img")

        for img in images:
            raw_src = (
                img.get("data-src")
                or img.get("data-lazy-src")
                or img.get("data-original")
                or img.get("src")
            )

            # Check srcset if src is empty or inline data URI
            if (not raw_src or raw_src.startswith("data:")) and img.get("srcset"):
                srcset_parts = img.get("srcset").split(",")
                if srcset_parts:
                    raw_src = srcset_parts[-1].strip().split(" ")[0]

            if not raw_src:
                continue

            raw_src = raw_src.strip()

            # Discard data URIs
            if raw_src.startswith("data:"):
                continue

            full_url = urllib.parse.urljoin(url, raw_src)

            if not full_url.startswith(("http://", "https://")):
                continue

            url_lower = full_url.lower()
            
            # Discard icons, avatars, flags, and SVGs
            if any(term in url_lower for term in [".svg", "logo", "icon", "avatar", "flag", "blank.", "spacer.", "pixel."]):
                continue

            # Must resemble a valid bitmap image or media upload path
            if not any(ext in url_lower for ext in [".jpg", ".jpeg", ".png", ".webp"]) and not ("wp-content/uploads" in url_lower or "images" in url_lower):
                continue

            alt_and_src = f"{img.get('alt', '')} {img.get('title', '')} {full_url}".lower()

            if not candidates["bunk"] and any(k in alt_and_src for k in ["bunk", "litera", "dorm", "habitacion", "room", "cama"]):
                candidates["bunk"] = full_url
            elif not candidates["bathroom"] and any(k in alt_and_src for k in ["bath", "bano", "baño", "ducha", "shower", "aseo"]):
                candidates["bathroom"] = full_url
            elif not candidates["exterior"] and any(k in alt_and_src for k in ["exterior", "fachada", "albergue", "building", "entrada", "house"]):
                candidates["exterior"] = full_url
            else:
                if len(candidates["general"]) < 5 and full_url not in candidates["general"]:
                    candidates["general"].append(full_url)

    except Exception as e:
        print(f"  [Scrape Error] {url}: {e}")
        return candidates

    return candidates


class Command(BaseCommand):
    help = "Scans albergue websites for exterior, bunk bed, and bathroom photos and uploads them to Cloudinary."

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=10, help="Number of albergues to process in this run")
        parser.add_argument('--stage', type=int, default=None, help="Process albergues in a specific stage only")
        parser.add_argument('--reset', action='store_true', help="Clear all existing albergue photo links before running")

    def handle(self, *args, **options):
        configure_cloudinary()

        # If --reset is passed, wipe all photo fields in the database first
        if options['reset']:
            self.stdout.write(self.style.WARNING("Resetting all existing albergue photo URLs in the database..."))
            Albergue.objects.all().update(
                pic1_url=None,
                pic2_url=None,
                pic3_url=None,
                pic4_url=None
            )
            self.stdout.write(self.style.SUCCESS("All albergue photo records cleared."))

        qs = Albergue.objects.filter(
            pic1_url__isnull=True
        ).exclude(
            website_url__in=["", "no website available", "NULL", None]
        ).order_by('id')  # Ensures it strictly starts from the first albergue

        if options['limit']:
            qs = qs[:options['limit']]

        for albergue in qs:
            target_url = albergue.website_url  # Use website_url
            self.stdout.write(f"\nProcessing [{albergue.id}] {albergue.name} -> {target_url}")

            candidates = extract_candidate_images(target_url)

            selected_urls = []
            for category in ["exterior", "bunk", "bathroom"]:
                if candidates[category]:
                    selected_urls.append(candidates[category])

            for fallback in candidates["general"]:
                if len(selected_urls) >= 3:
                    break
                if fallback not in selected_urls:
                    selected_urls.append(fallback)

            if not selected_urls:
                self.stdout.write(self.style.WARNING("  No usable image candidates found."))
                continue

            cloudinary_urls = []
            for idx, img_url in enumerate(selected_urls, start=1):
                # Verify URL format before attempting upload
                if not img_url.startswith(("http://", "https://")):
                    continue

                try:
                    self.stdout.write(f"  Uploading photo {idx}: {img_url[:60]}...")
                    upload_res = cloudinary.uploader.upload(
                        img_url,
                        folder="caminoAppImages/albergues/",
                        public_id=f"albergue_{albergue.id}_pic{idx}",
                        overwrite=True,
                        transformation=[
                            {"width": 1200, "height": 800, "crop": "limit"},
                            {"quality": "auto", "fetch_format": "auto"}
                        ]
                    )
                    cloudinary_urls.append(upload_res.get("secure_url"))
                except Exception as upload_err:
                    self.stdout.write(self.style.ERROR(f"  Cloudinary upload failed: {upload_err}"))

            # Assign to the model's Python attributes:
            if len(cloudinary_urls) >= 1:
                albergue.pic1_url = cloudinary_urls[0]
            if len(cloudinary_urls) >= 2:
                albergue.pic2_url = cloudinary_urls[1]
            if len(cloudinary_urls) >= 3:
                albergue.pic3_url = cloudinary_urls[2]

            albergue.save()
            self.stdout.write(self.style.SUCCESS(f"  Updated {albergue.name} with {len(cloudinary_urls)} Cloudinary photos."))
