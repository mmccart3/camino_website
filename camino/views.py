# camino/views.py
from django.shortcuts import render, get_object_or_404
from .models import Stage, Location, MapLocationCoord

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
    hotspots = MapLocationCoord.objects.filter(stage_id=stage_id).select_related('location')
    return render(request, 'camino/stage_detail.html', {'stage': stage, 'hotspots': hotspots})

def location_detail(request, location_id):
    location = get_object_or_404(Location, pk=location_id)
    albergues = location.albergues.all()
    private_accomm = location.private_accomm.all()
    paragraphs = location.paragraphs.all()
    
    context = {
        'location': location,
        'albergues': albergues,
        'private_accomm': private_accomm,
        'paragraphs': paragraphs,
    }
    return render(request, 'camino/location_detail.html', context)
