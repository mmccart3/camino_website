# camino/models.py
from django.db import models
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

BOOKING_AFFILIATE_PARAMS = {
    'aid': '818289',
    'label': 'affnetcj-15734710_pub-8073556_site-101884570_pname-MM3+Enterprise+Limited_clkid-_cjevent-5b29e765ba1911f180aa00a10a18b8f7',
    'utm_source': 'affnetcj',
    'utm_medium': 'bannerindex',
    'utm_campaign': 'fr',
    'utm_term': 'index-15734710',
}

COUNTRY_CODE_CHOICES = [
    ('+34', '+34 (Spain)'),
    ('+33', '+33 (France)'),
    ('+351', '+351 (Portugal)'),
    ('+44', '+44 (UK)'),
]


def clean_email(value):
    """The e-mail address, or None for blanks and placeholders such as the text 'NULL'."""
    email = str(value or '').strip()
    return email if '@' in email else None


def google_maps_url(latitude, longitude):
    """Google Maps link that drops a pin on the given coordinates, or None.

    Missing, non-numeric, out-of-range and placeholder (0, 0 / tiny) coordinates give None,
    so a card never links to a pin in the Atlantic Ocean.
    """
    try:
        lat, lng = float(latitude), float(longitude)
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    if abs(lat) < 0.001 and abs(lng) < 0.001:
        return None
    return f'https://www.google.com/maps/search/?api=1&query={lat:.6f},{lng:.6f}'


def attach_booking_affiliate(url_string):
    """Validates the URL protocol and appends affiliate tracking parameters."""
    if not url_string:
        return None

    clean = str(url_string).strip()
    if not clean.lower().startswith(('http://', 'https://')):
        return None

    # Parse and merge existing query parameters with affiliate parameters
    parsed = urlparse(clean)
    query_params = parse_qs(parsed.query, keep_blank_values=True)

    # Flatten single-value lists from parse_qs and merge affiliate data
    merged_params = {k: v[0] if isinstance(v, list) and len(v) == 1 else v for k, v in query_params.items()}
    merged_params.update(BOOKING_AFFILIATE_PARAMS)

    new_query = urlencode(merged_params)
    return urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        parsed.params,
        new_query,
        parsed.fragment
    ))

class Path(models.Model):
    path_id = models.IntegerField(db_column='pathID', primary_key=True)
    stage_id = models.IntegerField(db_column='stageID')
    origin_loc = models.IntegerField(db_column='originLoc')
    destination_loc = models.IntegerField(db_column='destinationLoc')
    distance_metres = models.IntegerField(db_column='distance_metres', null=True, blank=True)
    time_seconds = models.IntegerField(db_column='time_seconds', null=True, blank=True)

    class Meta:
        managed = False
        db_table = 'paths'


class ElevationPoint(models.Model):
    # Django requires a surrogate primary key column; use path_id or an explicit composite id
    path = models.ForeignKey(Path, db_column='pathID', on_delete=models.DO_NOTHING, primary_key=True)
    sequence = models.IntegerField()
    distance_along_path_metres = models.FloatField(db_column='distanceAlongPathMetres')
    elevation_metres = models.FloatField(db_column='elevationMetres')
    latitude = models.FloatField()
    longitude = models.FloatField()
    source_sequence = models.IntegerField(db_column='sourceSequence')
    distance_basis = models.TextField(db_column='distanceBasis')
    source_sha256 = models.TextField(db_column='sourceSHA256')

    class Meta:
        managed = False
        db_table = 'elevation_points'
        unique_together = (('path', 'sequence'),)


class LocationFacility(models.Model):
    location_id = models.IntegerField(db_column='locationID', primary_key=True)
    category = models.TextField()
    osm_type = models.TextField(db_column='osmType')
    osm_id = models.BigIntegerField(db_column='osmID')
    name = models.TextField(null=True, blank=True)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    distance_metres = models.FloatField(db_column='distanceMetres', null=True, blank=True)
    source_url = models.TextField(db_column='sourceURL', null=True, blank=True)
    retrieved_at = models.TextField(db_column='retrievedAt', null=True, blank=True)
    tags_json = models.TextField(db_column='tagsJSON', null=True, blank=True)
    decision = models.TextField(null=True, blank=True)
    review_note = models.TextField(db_column='reviewNote', null=True, blank=True)

    class Meta:
        managed = False
        db_table = 'locationFacilities'
        unique_together = (('location_id', 'category', 'osm_type', 'osm_id'),)


class TrackPoint(models.Model):
    track_point_id = models.BigIntegerField(primary_key=True, db_column='track_point_id')
    path_id = models.IntegerField(db_column='pathID')
    latitude = models.DecimalField(max_digits=10, decimal_places=7, null=True, blank=True)
    longitude = models.DecimalField(max_digits=11, decimal_places=7, null=True, blank=True)
    elevation = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    previous_track_point_id = models.BigIntegerField(null=True, blank=True)
    distance_3d_meters = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    slope_angle_degrees = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    weighted_distance = models.DecimalField(max_digits=9, decimal_places=5, null=True, blank=True)
    waypoint = models.SmallIntegerField(null=True, blank=True)
    distance_3d = models.FloatField(db_column='3D-Distance', null=True, blank=True)
    slope = models.FloatField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = 'track_points'
        
class Stage(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    stage_name = models.CharField(db_column='stageName', max_length=255)
    # New column mapping
    stage_display_reference = models.CharField(db_column='stageDisplayReference', max_length=20, null=True, blank=True)
    distance_meters = models.IntegerField(db_column='stageDistanceInMetres', null=True)
    time_minutes = models.IntegerField(db_column='stageTimeInMinutes', null=True)
    elevation_chart_url = models.CharField(db_column='stageElevationChartURL', max_length=255, null=True)
    map_url_1024 = models.CharField(db_column='stageMap1024URL', max_length=255, null=True)
    map_url_1920 = models.CharField(db_column='stageMap1920URL', max_length=255, null=True)
    stage_map_url = models.CharField(db_column='stageMapURL', max_length=255, null=True)
    prior_stage = models.IntegerField(db_column='priorStage', null=True)
    alt_prior_stage = models.IntegerField(db_column='altPriorStage', null=True)
    next_stage = models.IntegerField(db_column='nextStage', null=True)
    alt_next_stage = models.IntegerField(db_column='altNextStage', null=True)

    class Meta:
        managed = False
        db_table = 'stages'

    @property
    def distance_km(self):
        return round(self.distance_meters / 1000, 1) if self.distance_meters else 0

    @property
    def display_ref(self):
        """Returns stageDisplayReference or falls back to the database ID."""
        return self.stage_display_reference if self.stage_display_reference else str(self.id)

class Location(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    location_name = models.CharField(db_column='locationName', max_length=64)
    latitude = models.DecimalField(db_column='latitude', max_digits=8, decimal_places=5, null=True)
    longitude = models.DecimalField(db_column='longitude', max_digits=8, decimal_places=5, null=True)
    pic1_url = models.CharField(db_column='locationPic1URL', max_length=255, null=True)
    pic2_url = models.CharField(db_column='locationPic2URL', max_length=255, null=True)
    prior_loc = models.IntegerField(db_column='priorLoc', null=True)
    next_loc = models.IntegerField(db_column='nextLoc', null=True)
    # Updated Location model attributes
    has_bar_cafe = models.IntegerField(db_column='hasBarCafe', null=True, blank=True)
    has_pharmacy = models.IntegerField(db_column='hasPharmacy', null=True, blank=True)
    has_grocery_store = models.IntegerField(db_column='hasGroceryStore', null=True, blank=True)

    class Meta:
        managed = False
        db_table = 'locations'
    
    def __str__(self):
        return self.location_name


class MapLocationCoord(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    stage_id = models.IntegerField(db_column='stageId')
    location = models.ForeignKey(Location, db_column='locationId', on_delete=models.DO_NOTHING)
    
    # Base columns (which now hold 1920-scale coordinates)
    top_left_x = models.IntegerField(db_column='topLeftX', null=True)
    top_left_y = models.IntegerField(db_column='topLeftY', null=True)
    bottom_right_x = models.IntegerField(db_column='bottomRightX', null=True)
    bottom_right_y = models.IntegerField(db_column='bottomRightY', null=True)

    # Resolution-specific columns
    tlx_1920 = models.IntegerField(db_column='TLX1920', null=True)
    tly_1920 = models.IntegerField(db_column='TLY1920', null=True)
    brx_1920 = models.IntegerField(db_column='BRX1920', null=True)
    bry_1920 = models.IntegerField(db_column='BRY1920', null=True)

    tlx_1024 = models.IntegerField(db_column='TLX1024', null=True)
    tly_1024 = models.IntegerField(db_column='TLY1024', null=True)
    brx_1024 = models.IntegerField(db_column='BRX1024', null=True)
    bry_1024 = models.IntegerField(db_column='BRY1024', null=True)

    class Meta:
        managed = False
        db_table = 'mapLocationCoords'

    # 1920-scale helpers
    @property
    def x_1920(self):
        return self.top_left_x if self.top_left_x is not None else self.tlx_1920

    @property
    def y_1920(self):
        return self.top_left_y if self.top_left_y is not None else self.tly_1920

    @property
    def w_1920(self):
        x1 = self.x_1920
        x2 = self.bottom_right_x if self.bottom_right_x is not None else self.brx_1920
        return (x2 - x1) if (x1 is not None and x2 is not None) else 0

    @property
    def h_1920(self):
        y1 = self.y_1920
        y2 = self.bottom_right_y if self.bottom_right_y is not None else self.bry_1920
        return (y2 - y1) if (y1 is not None and y2 is not None) else 0

class Albergue(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    location = models.ForeignKey(Location, db_column='locationID', on_delete=models.DO_NOTHING, related_name='albergues')
    name = models.CharField(db_column='albergueName', max_length=64)
    address = models.CharField(db_column='albergueStreetAdress', max_length=255, null=True)
    beds = models.IntegerField(db_column='numberOfBeds', null=True)
    dorms = models.IntegerField(
        null=True,
        blank=True,
        db_column='numberOfDorms',
        verbose_name="Number of Dorms"
    )
    rate_1p_min = models.DecimalField(db_column='onedPersonRateMin', max_digits=5, decimal_places=2, null=True)
    rate_1p_max = models.DecimalField(db_column='onedPersonRateMax', max_digits=5, decimal_places=2, null=True)
    rate_notes = models.CharField(db_column='rateNotes', max_length=255, null=True)
    kitchen = models.BooleanField(db_column='kitchenFacilitiesAvailable', default=False)
    washer = models.BooleanField(db_column='washingMachineAvailable', default=False)
    dryer = models.BooleanField(db_column='dryingMachineAvailable', default=False)
    latitude = models.FloatField(null=True, blank=True, db_column='gps_lat')
    longitude = models.FloatField(null=True, blank=True, db_column='gps_lng')
    communal_meal = models.BooleanField(db_column='communalMealAvailable', default=False)
    opening_period = models.CharField(db_column='openingPeriod', max_length=255, null=True)
    check_in_times = models.TextField(db_column='checkInTimes', null=True)
    email = models.CharField(db_column='email', max_length=64, null=True)
    country_code = models.CharField(
        max_length=6,
        choices=COUNTRY_CODE_CHOICES,
        default='+34',
        blank=True,
        null=True,
        db_column='tel1CountryCode'  # adjust if SQLite column is named differently
    )
    phone = models.CharField(db_column='tel1PhoneNumber', max_length=32, null=True)
    whatsapp = models.CharField(db_column='whatsAppNumber', max_length=32, null=True)
    website_url = models.CharField(db_column='albergueWebsiteURL', max_length=255, null=True)
    booking_url = models.CharField(db_column='albergueBookingDotComURL', max_length=255, null=True)
    # Add the photo fields mapped to SQLite column names:
    pic1_url = models.CharField(db_column='alberguepic1URL', max_length=255, null=True, blank=True)
    pic2_url = models.CharField(db_column='alberguepic2URL', max_length=255, null=True, blank=True)
    pic3_url = models.CharField(db_column='alberguepic3URL', max_length=255, null=True, blank=True)
    pic4_url = models.CharField(db_column='alberguepic4URL', max_length=255, null=True, blank=True)
    privateRoomsAvailable = models.BooleanField(
        default=False,
        null=True,
        blank=True,
        db_column='privateRoomsAvailable'
    )

    class Meta:
        managed = False
        db_table = 'albergues'
        
    @property
    def valid_email(self):
        """E-mail address to link to, or None when the record has none."""
        return clean_email(self.email)

    @property
    def google_maps_url(self):
        """Link that opens this accommodation's GPS position in Google Maps, or None."""
        return google_maps_url(self.latitude, self.longitude)

    @property
    def valid_website_url(self):
        """Returns the website URL only if it starts with http:// or https://, else None."""
        if self.website_url:
            url = self.website_url.strip()
            if url.startswith(('http://', 'https://')):
                return url
        return None
    
    @property
    def valid_booking_url(self):
        """Returns the booking URL only if it starts with http:// or https://."""
        if self.booking_url:
            clean = str(self.booking_url).strip().lower()
            if clean.startswith(('http://', 'https://')):
                return attach_booking_affiliate(self.booking_url)
        return None


class PrivateAccomm(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    location = models.ForeignKey(Location, db_column='locationID', on_delete=models.DO_NOTHING, related_name='private_accomm')
    name = models.CharField(db_column='privateAccommName', max_length=64)
    address = models.CharField(db_column='privateAccommStreetAdress', max_length=255, null=True)
    rate_1p_min = models.DecimalField(db_column='onedPersonRateMin', max_digits=5, decimal_places=2, null=True)
    rate_2p_min = models.DecimalField(db_column='twoPersonRateMin', max_digits=5, decimal_places=2, null=True)
    rate_notes = models.CharField(db_column='rateNotes', max_length=255, null=True)
    email = models.CharField(db_column='email', max_length=64, null=True)
    country_code = models.CharField(
        max_length=6,
        choices=COUNTRY_CODE_CHOICES,
        default='+34',
        blank=True,
        null=True,
        db_column='tel1CountryCode'  # adjust if SQLite column is named differently
    )
    phone = models.CharField(db_column='tel1PhoneNumber', max_length=32, null=True)
    whatsapp = models.CharField(db_column='whatsAppNumber', max_length=32, null=True)
    latitude = models.FloatField(null=True, blank=True, db_column='gps_lat')
    longitude = models.FloatField(null=True, blank=True, db_column='gps_lng')
    website_url = models.CharField(db_column='privateAccommWebsiteURL', max_length=255, null=True)
    booking_url = models.CharField(db_column='privateAccommBookingDotComURL', max_length=255, null=True)

    class Meta:
        managed = False
        db_table = 'privateAccommDetail'
        
    @property
    def valid_email(self):
        """E-mail address to link to, or None when the record has none."""
        return clean_email(self.email)

    @property
    def google_maps_url(self):
        """Link that opens this accommodation's GPS position in Google Maps, or None."""
        return google_maps_url(self.latitude, self.longitude)

    @property
    def valid_website_url(self):
        """Returns the website URL only if it starts with http:// or https://, else None."""
        if self.website_url:
            url = self.website_url.strip()
            if url.startswith(('http://', 'https://')):
                return url
        return None
    
    @property
    def valid_booking_url(self):
        """Returns the booking URL only if it starts with http:// or https://."""
        if self.booking_url:
            clean = str(self.booking_url).strip().lower()
            if clean.startswith(('http://', 'https://')):
                return attach_booking_affiliate(self.booking_url)
        return None


class Paragraph(models.Model):
    id = models.IntegerField(db_column='ID', primary_key=True)
    location = models.ForeignKey(Location, db_column='locationID', on_delete=models.DO_NOTHING, related_name='paragraphs')
    type = models.CharField(db_column='paragraphType', max_length=10)
    text = models.TextField(db_column='paragraphText')

    class Meta:
        managed = False
        db_table = 'paragraphs'