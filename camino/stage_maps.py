# camino/stage_maps.py
"""Illustrated stage maps: which file to send to which screen, and how tall each map is.

The map pictures live on Cloudinary in several widths. All widths of one map have the same shape, and
the hotspot rectangles in the database (mapLocationCoords, the plain topLeftX... columns) are measured
on the 1024-pixel-wide picture. So the page now draws the hotspots on a fixed 1024-wide grid, whatever
width of picture the browser chooses, and a phone can be sent a smaller file.

Only the 360, 640 and 1024 widths are offered. Some stages have a different, newer drawing at 1280 and
1920 pixels, so mixing those in would show a different map on different screens.
"""

# The widths offered to browsers, smallest first. 1024 is the file the guide has always sent.
WIDTHS = (360, 640, 1024)

# The width the hotspot rectangles are measured on.
HOTSPOT_GRID_WIDTH = 1024

# Tells the browser how wide the picture is on screen. The two small figures are deliberately a little
# under the real width (about 330-450 on a phone, 450-740 on a small tablet): the browser multiplies them
# by the screen's pixel density, so an ordinary phone (2x) is sent the 640 picture, a very sharp one (3x)
# the 1024, and only a desktop-sized window asks for the full 1024. Raise them for crisper maps, lower
# them to save more mobile data.
SIZES_ATTRIBUTE = '(max-width: 480px) 320px, (max-width: 900px) 512px, 1024px'

# Height in pixels of each map's 1024-wide picture. They were measured on 8 November 2026. The key is
# the end of the picture's address, after "/upload/", so a map that is replaced by a new upload (which
# changes that address) is simply not found here and the page works out its shape after loading, as
# before.
HEIGHT_AT_1024 = {
    'v1699797012/caminoAppImages/maps/1024maps/sjpp2roncesvallesX_ubv8vi.jpg': 1794,
    'v1699797015/caminoAppImages/maps/1024maps/roncesvalles2zubiri90_nqyuwm.jpg': 617,
    'v1699797012/caminoAppImages/maps/1024maps/zubiri2pamplona_xtpyfr.jpg': 1132,
    'v1699797015/caminoAppImages/maps/1024maps/pamplona2puentelareina_aijyo8.jpg': 1074,
    'v1699797015/caminoAppImages/maps/1024maps/puentelareina2estella_nekqlf.jpg': 236,
    'v1699797013/caminoAppImages/maps/1024maps/estella2losarcos_bahxko.jpg': 868,
    'v1699797014/caminoAppImages/maps/1024maps/losarcos2logrono_oecfwo.jpg': 614,
    'v1699797014/caminoAppImages/maps/1024maps/logrono2najera_ty2eje.jpg': 364,
    'v1699797014/caminoAppImages/maps/1024maps/najera2santodomingo_nxajvm.jpg': 245,
    'v1699797015/caminoAppImages/maps/1024maps/santodomingo2belorado_gbluxn.jpg': 260,
    'v1699797011/caminoAppImages/maps/1024maps/belorado2sanjuan_xxfqhd.jpg': 339,
    'v1699797015/caminoAppImages/maps/1024maps/sanjuan2burgos_pkhf3m.jpg': 372,
    'v1699797012/caminoAppImages/maps/1024maps/burgos2hornillos_l6ua4d.jpg': 197,
    'v1699797013/caminoAppImages/maps/1024maps/hornillos2castrojeriz_iiszie.jpg': 350,
    'v1699797012/caminoAppImages/maps/1024maps/castrojeriz2fromista_u60uzm.jpg': 212,
    'v1699797013/caminoAppImages/maps/1024maps/fromista2carrion_e39xwt.jpg': 536,
    'v1699797012/caminoAppImages/maps/1024maps/carrion2terradillos_foiinr.jpg': 244,
    'v1699797011/caminoAppImages/maps/1024maps/terradillos2bercianos_y1pshs.jpg': 444,
    'v1699797011/caminoAppImages/maps/1024maps/bercianos2mansillas_vxgpxj.jpg': 604,
    'v1699797014/caminoAppImages/maps/1024maps/mansilla2leon_xqm3hh.jpg': 864,
    'v1699797014/caminoAppImages/maps/1024maps/leon2sanmartin_wa1ryj.jpg': 672,
    'v1699797015/caminoAppImages/maps/1024maps/sanmartin2astorga_tl0vv9.jpg': 294,
    'v1699797012/caminoAppImages/maps/1024maps/astorga2rabanal_ovviao.jpg': 214,
    'v1699797015/caminoAppImages/maps/1024maps/rabanal2elacebo_fbyy0q.jpg': 244,
    'v1699797013/caminoAppImages/maps/1024maps/elacebo2ponferrada_w3afhf.jpg': 573,
    'v1699797015/caminoAppImages/maps/1024maps/ponferrada2villafranca_hsak4x.jpg': 451,
    'v1699797011/caminoAppImages/maps/1024maps/villafranca2lafaba_nz8ksb.jpg': 580,
    'v1699797013/caminoAppImages/maps/1024maps/lafaba2triacastela_ak88xn.jpg': 458,
    'v1699797011/caminoAppImages/maps/1024maps/triacastela2sarria_empgwh.jpg': 605,
    'v1699797015/caminoAppImages/maps/1024maps/sarria2portomarin_lgbcka.jpg': 317,
    'v1699797014/caminoAppImages/maps/1024maps/palasderei2arzua_hy43rs.jpg': 461,
    'v1699797012/caminoAppImages/maps/1024maps/arzua2pedrouzo_qdbtor.jpg': 435,
    'v1699797014/caminoAppImages/maps/1024maps/pedrouzo2santiago_unwpzt.jpg': 369,
    'v1699797015/caminoAppImages/maps/1024maps/portomarin2palasderei_yayy97.jpg': 411,
}


def _is_web_address(url):
    return bool(url) and str(url).strip().lower().startswith(('http://', 'https://'))


def height_at_1024(url):
    """Height of the 1024-wide picture at this address, or None if it was not measured."""
    if not _is_web_address(url):
        return None
    tail = str(url).strip().split('/upload/', 1)
    return HEIGHT_AT_1024.get(tail[1]) if len(tail) == 2 else None


def describe(stage):
    """Everything the stage page needs to show a stage's illustrated map.

    Returns a dict with:
      src      the address used by browsers that ignore srcset, and the offline fallback
      srcset   "url 360w, url 640w, url 1024w", or '' when the three widths are not all there
      sizes    the sizes attribute (only when srcset is set)
      width, height   the shape of the 1024 picture (None when unknown)
      grid_height     the same height, for the hotspot grid (None when unknown)
    """
    full = stage.stage_map_url or stage.map_url_1920 or stage.map_url_1024
    large = stage.map_url_1024
    small = {360: getattr(stage, 'map_url_360', None), 640: getattr(stage, 'map_url_640', None)}
    candidates = [(small[360], 360), (small[640], 640), (large, 1024)]
    # The three widths are only mixed when the 1024 file is the very picture used as the main one, and
    # all three addresses are real. Otherwise the plain picture is sent, exactly as before.
    mixable = (
        _is_web_address(full) and _is_web_address(large) and str(full).strip() == str(large).strip()
        and all(_is_web_address(url) for url, _width in candidates)
    )
    height = height_at_1024(large if mixable else full)
    return {
        'src': full,
        'srcset': ', '.join(f'{str(url).strip()} {width}w' for url, width in candidates) if mixable else '',
        'sizes': SIZES_ATTRIBUTE if mixable else '',
        'width': HOTSPOT_GRID_WIDTH if height else None,
        'height': height,
        'grid_height': height,
    }
