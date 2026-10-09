# camino/views.py
import json
from django.shortcuts import render, get_object_or_404
from .models import Stage, Path, ElevationPoint, MapLocationCoord, Location

def get_stage_groups():
    all_stages = {s.id: s for s in Stage.objects.all()}
    if not all_stages:
        return []

    # 1. Map stages strictly by shared prior_stage and shared next_stage
    prior_groups = {}
    next_groups = {}

    for s in all_stages.values():
        # Treat None, 0, or missing IDs as the common start marker (e.g., Stage 1 & 43)
        prior_key = s.prior_stage if (s.prior_stage and s.prior_stage in all_stages) else 0
        prior_groups.setdefault(prior_key, []).append(s.id)

        # Treat valid next_stage pointers
        if s.next_stage and s.next_stage in all_stages:
            next_groups.setdefault(s.next_stage, []).append(s.id)

    # 2. Build direct alternate links strictly matching your criteria
    alternate_links = {s_id: set() for s_id in all_stages}

    for s_ids in prior_groups.values():
        if len(s_ids) > 1:
            for i in s_ids:
                for j in s_ids:
                    if i != j:
                        alternate_links[i].add(j)

    for s_ids in next_groups.values():
        if len(s_ids) > 1:
            for i in s_ids:
                for j in s_ids:
                    if i != j:
                        alternate_links[i].add(j)

    # Helper function to gather all connected alternates in a cluster
    def get_cluster(stage_id, visited_set):
        cluster = [all_stages[stage_id]]
        visited_set.add(stage_id)
        for neighbor_id in sorted(alternate_links[stage_id]):
            if neighbor_id not in visited_set:
                cluster.extend(get_cluster(neighbor_id, visited_set))
        return cluster

    # 3. Locate the initial stage (prior_stage is None, 0, or not in table)
    start_candidates = prior_groups.get(0, [])
    if start_candidates:
        start_id = min(start_candidates)
    else:
        start_id = min(all_stages.keys())

    grouped_stages = []
    visited = set()
    current_stage = all_stages[start_id]

    # 4. Traverse sequentially along the route
    while current_stage and current_stage.id not in visited:
        cluster = get_cluster(current_stage.id, visited)

        # Main route comes first (routes without 'via', 'option', or 'valcarlos' rank first)
        def sort_key(s):
            name_lower = s.stage_name.lower()
            is_alt = 1 if ('via' in name_lower or 'option' in name_lower or 'valcarlos' in name_lower) else 0
            return (is_alt, s.id)

        cluster.sort(key=sort_key)
        primary = cluster[0]
        alternates = cluster[1:]

        grouped_stages.append({
            'primary': primary,
            'alternates': alternates,
            'has_alternate': len(alternates) > 0
        })

        # Advance to the next stage using the next_stage pointer
        candidate_next = None
        for member in cluster:
            if member.next_stage and member.next_stage in all_stages and member.next_stage not in visited:
                candidate_next = all_stages[member.next_stage]
                break

        # If next_stage is unavailable or already visited, check stages that have this cluster as prior_stage
        if not candidate_next:
            for member in cluster:
                children = [all_stages[cid] for cid in prior_groups.get(member.id, []) if cid not in visited]
                if children:
                    candidate_next = min(children, key=lambda s: s.id)
                    break

        current_stage = candidate_next

    # 5. Append any remaining unlinked stages (if any exist)
    for s_id in sorted(all_stages.keys()):
        if s_id not in visited:
            cluster = get_cluster(s_id, visited)
            grouped_stages.append({
                'primary': cluster[0],
                'alternates': cluster[1:],
                'has_alternate': len(cluster) > 1
            })

    return grouped_stages


def stage_list(request):
    stage_groups = get_stage_groups()
    return render(request, 'camino/stage_list.html', {'stage_groups': stage_groups})

def stage_detail(request, stage_id):
    stage = get_object_or_404(Stage, pk=stage_id)

    # 1. Navigation context
    prior_id = getattr(stage, 'prior_stage', None) or getattr(stage, 'priorStage', None)
    alt_prior_id = getattr(stage, 'alt_prior_stage', None) or getattr(stage, 'altPriorStage', None)
    next_id = getattr(stage, 'next_stage', None) or getattr(stage, 'nextStage', None)
    alt_next_id = getattr(stage, 'alt_next_stage', None) or getattr(stage, 'altNextStage', None)

    prior_stage = Stage.objects.filter(pk=prior_id).first() if prior_id else None
    alt_prior_stage = Stage.objects.filter(pk=alt_prior_id).first() if alt_prior_id else None
    next_stage = Stage.objects.filter(pk=next_id).first() if next_id else None
    alt_next_stage = Stage.objects.filter(pk=alt_next_id).first() if alt_next_id else None

    # 2. Hotspots
    hotspots = list(MapLocationCoord.objects.filter(stage_id=stage.id))

    # 3. Elevation & Waypoint Markers
    chart_distances = []
    chart_elevations = []
    waypoint_markers = []

    try:
        # Fetch paths using stage_id
        stage_paths = list(Path.objects.filter(stage_id=stage.id).order_by('pk'))

        if stage_paths:
            all_continuous_points = []
            accumulated_distance_m = 0.0

            # Collect unique location IDs
            loc_ids = set()
            for p in stage_paths:
                origin_val = getattr(p, 'origin_loc', getattr(p, 'originLoc', None))
                dest_val = getattr(p, 'destination_loc', getattr(p, 'destinationLoc', None))
                if origin_val:
                    loc_ids.add(origin_val)
                if dest_val:
                    loc_ids.add(dest_val)

            # Build location name mapping
            loc_map = {}
            for loc in Location.objects.filter(pk__in=loc_ids):
                loc_name = getattr(loc, 'location_name', getattr(loc, 'locationName', f"Location {loc.pk}"))
                loc_map[loc.pk] = loc_name

            for idx, path_obj in enumerate(stage_paths):
                # Filter points using the path instance (avoids path_id vs pathID lookup bugs)
                pts = list(
                    ElevationPoint.objects.filter(path=path_obj)
                    .order_by('sequence')
                    .values('distance_along_path_metres', 'elevation_metres')
                )

                origin_id = getattr(path_obj, 'origin_loc', getattr(path_obj, 'originLoc', None))
                dest_id = getattr(path_obj, 'destination_loc', getattr(path_obj, 'destinationLoc', None))
                path_dist = getattr(path_obj, 'distance_metres', None)

                if not pts:
                    if path_dist:
                        accumulated_distance_m += path_dist
                    continue

                # Start of stage location
                if idx == 0 and origin_id in loc_map:
                    waypoint_markers.append({
                        'name': loc_map[origin_id],
                        'km': 0.0,
                        'elevation': round(pts[0]['elevation_metres'])
                    })

                for pt in pts:
                    cum_dist = accumulated_distance_m + pt['distance_along_path_metres']
                    all_continuous_points.append({
                        'distance_m': cum_dist,
                        'elevation_m': pt['elevation_metres']
                    })

                # End of segment distance
                seg_end_dist = (
                    accumulated_distance_m + path_dist
                    if path_dist
                    else accumulated_distance_m + pts[-1]['distance_along_path_metres']
                )

                if dest_id in loc_map:
                    waypoint_markers.append({
                        'name': loc_map[dest_id],
                        'km': round(seg_end_dist / 1000.0, 1),
                        'elevation': round(pts[-1]['elevation_metres'])
                    })

                accumulated_distance_m = seg_end_dist

# Downsample to ~160 points
            total_pts = len(all_continuous_points)
            if total_pts > 0:
                step = max(1, total_pts // 160)
                sampled_points = all_continuous_points[::step]
                if all_continuous_points[-1] not in sampled_points:
                    sampled_points.append(all_continuous_points[-1])

                # Pair directly as {x: distance_km, y: elevation_m}
                chart_points = [
                    {
                        'x': round(p['distance_m'] / 1000.0, 2),
                        'y': round(p['elevation_m'])
                    }
                    for p in sampled_points
                ]

                # chart_distances = [round(p['distance_m'] / 1000.0, 1) for p in sampled_points]
                # chart_elevations = [round(p['elevation_m']) for p in sampled_points]

    except Exception as err:
        import traceback
        traceback.print_exc()
        print(f"[Warning] Elevation fetch error on Stage {stage.id}: {err}")

    context = {
        'stage': stage,
        'prior_stage': prior_stage,
        'alt_prior_stage': alt_prior_stage,
        'next_stage': next_stage,
        'alt_next_stage': alt_next_stage,
        'hotspots': hotspots,
        'chart_points_json': json.dumps(chart_points),
        'waypoint_markers_json': json.dumps(waypoint_markers),
        'has_elevation_data': len(chart_points) > 0,
    }
    return render(request, 'camino/stage_detail.html', context)

# camino/views.py

def location_detail(request, location_id):
    location = get_object_or_404(Location, pk=location_id)
    albergues = location.albergues.all()
    private_accomm = location.private_accomm.all()
    paragraphs = location.paragraphs.all()
    
    # Retrieve linked prior and next location objects
    prior_location = None
    if location.prior_loc and location.prior_loc != 0:
        prior_location = Location.objects.filter(pk=location.prior_loc).first()

    next_location = None
    if location.next_loc and location.next_loc != 0:
        next_location = Location.objects.filter(pk=location.next_loc).first()
        
# Find the stage associated with this location without using select_related('stage')
    parent_stage = None
    coord_entry = MapLocationCoord.objects.filter(location_id=location_id).first()
    
    if coord_entry:
        # Check either stage_id or whatever attribute holds the stage integer on the model
        stage_num = getattr(coord_entry, 'stage_id', None) or getattr(coord_entry, 'stage', None)
        
        # If it's already a Stage model instance, use it; otherwise fetch the Stage record
        if isinstance(stage_num, Stage):
            parent_stage = stage_num
        elif stage_num:
            parent_stage = Stage.objects.filter(pk=stage_num).first()

    context = {
'location': location,
        'prior_location': prior_location,
        'next_location': next_location,
        'parent_stage': parent_stage,
        'albergues': albergues,
        'private_accomm': private_accomm,
        'paragraphs': paragraphs,
    }
    return render(request, 'camino/location_detail.html', context)
