# camino/views.py
from django.shortcuts import render, get_object_or_404
from .models import Stage, Location, MapLocationCoord

def get_stage_groups():
    all_stages = {s.id: s for s in Stage.objects.all()}
    if not all_stages:
        return []

    # Map each stage ID to all stages that follow it (primary or alternate)
    children_map = {}
    for stage in all_stages.values():
        priors = [p for p in (stage.prior_stage, stage.alt_prior_stage) if p]
        for p in priors:
            children_map.setdefault(p, []).append(stage.id)

    # Locate route start stage (no prior stage, or priorStage is 0 / not in DB)
    start_stage = None
    for stage in all_stages.values():
        if not stage.prior_stage or stage.prior_stage == 0 or stage.prior_stage not in all_stages:
            start_stage = stage
            break

    if not start_stage:
        start_stage = min(all_stages.values(), key=lambda s: s.id)

    grouped_stages = []
    visited = set()
    current_id = start_stage.id

    while current_id and current_id in all_stages and current_id not in visited:
        current_stage = all_stages[current_id]
        visited.add(current_stage.id)

        # Collect alternates paired with this stage (via explicit links or shared priorStage)
        alternates = []
        
        # 1. Check if an alternate stage branches off here directly
        if current_stage.alt_next_stage and current_stage.alt_next_stage in all_stages:
            alt = all_stages[current_stage.alt_next_stage]
            if alt.id not in visited:
                alternates.append(alt)
                visited.add(alt.id)

        # 2. Check sibling stages that share the same priorStage
        if current_stage.prior_stage:
            siblings = children_map.get(current_stage.prior_stage, [])
            for sib_id in siblings:
                if sib_id != current_stage.id and sib_id not in visited:
                    sib = all_stages[sib_id]
                    alternates.append(sib)
                    visited.add(sib.id)

        # Append as a grouped bundle
        grouped_stages.append({
            'primary': current_stage,
            'alternates': alternates,
            'has_alternate': len(alternates) > 0
        })

        # Advance along the primary mainline
        next_id = current_stage.next_stage
        
        # Fallback to the next unvisited sequential child if next_stage is missing
        if not next_id or next_id in visited:
            remaining_children = [cid for cid in children_map.get(current_stage.id, []) if cid not in visited]
            next_id = remaining_children[0] if remaining_children else None

        current_id = next_id

    # Append any remaining unlinked stages (if any exist)
    for s in all_stages.values():
        if s.id not in visited:
            grouped_stages.append({
                'primary': s,
                'alternates': [],
                'has_alternate': False
            })
            visited.add(s.id)

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
