# data_editor/views.py
from django.shortcuts import render, get_object_or_404, redirect
from django.contrib import messages
from django.db.models import Max
from camino.models import Albergue, PrivateAccomm, Paragraph, Location
from .forms import AlbergueForm, PrivateAccommForm, ParagraphForm
from .security import local_only

@local_only
def editor_dashboard(request):
    tab = request.GET.get('tab', 'albergues')
    query = request.GET.get('q', '').strip()
    loc_id = request.GET.get('location', '')

    locations = Location.objects.order_by('location_name')

    items = []
    if tab == 'albergues':
        qs = Albergue.objects.select_related('location')
        if query:
            qs = qs.filter(name__icontains=query)
        if loc_id:
            qs = qs.filter(location_id=loc_id)
        items = qs.order_by('location__location_name', 'name')

    elif tab == 'private':
        qs = PrivateAccomm.objects.select_related('location')
        if query:
            qs = qs.filter(name__icontains=query)
        if loc_id:
            qs = qs.filter(location_id=loc_id)
        items = qs.order_by('location__location_name', 'name')

    elif tab == 'paragraphs':
        qs = Paragraph.objects.select_related('location')
        if query:
            qs = qs.filter(text__icontains=query)
        if loc_id:
            qs = qs.filter(location_id=loc_id)
        items = qs.order_by('location__location_name', 'id')

    context = {
        'tab': tab,
        'query': query,
        'selected_location': int(loc_id) if loc_id.isdigit() else None,
        'locations': locations,
        'items': items,
    }
    return render(request, 'data_editor/dashboard.html', context)


# data_editor/views.py

@local_only
def create_item(request, model_name):
    models_map = {
        'albergue': (Albergue, AlbergueForm, 'albergues'),
        'private': (PrivateAccomm, PrivateAccommForm, 'private'),
        'paragraph': (Paragraph, ParagraphForm, 'paragraphs'),
    }

    if model_name not in models_map:
        return redirect('editor_dashboard')

    model_class, form_class, redirect_tab = models_map[model_name]

    if request.method == 'POST':
        form = form_class(request.POST)
        if form.is_valid():
            instance = form.save(commit=False)
            
            # If the database table does not autoincrement ID, assign next integer
            if not instance.pk:
                max_id = model_class.objects.aggregate(Max('id'))['id__max'] or 0
                instance.id = max_id + 1
            
            instance.save()
            messages.success(request, f"Created {model_name} #{instance.id} successfully.")
            return redirect(f"/editor/?tab={redirect_tab}")
    else:
        initial = {}
        loc_id = request.GET.get('location')
        if loc_id and loc_id.isdigit():
            initial['location'] = loc_id
        form = form_class(initial=initial)

    return render(request, 'data_editor/edit_form.html', {
        'form': form,
        'model_name': model_name,
        'is_create': True,
        'redirect_tab': redirect_tab,
    })


@local_only
def edit_item(request, model_name, pk):
    models_map = {
        'albergue': (Albergue, AlbergueForm, 'albergues'),
        'private': (PrivateAccomm, PrivateAccommForm, 'private'),
        'paragraph': (Paragraph, ParagraphForm, 'paragraphs'),
    }

    if model_name not in models_map:
        return redirect('editor_dashboard')

    model_class, form_class, redirect_tab = models_map[model_name]
# 1. Fetch exact instance
    instance = get_object_or_404(model_class, pk=pk)

    if request.method == 'POST':
        form = form_class(request.POST, instance=instance)
        if form.is_valid():
            obj = form.save(commit=False)
            
            # Ensure Django strictly performs an UPDATE on the existing row
            obj.pk = pk
            obj._state.adding = False
            
            obj.save()
            messages.success(request, f"Updated {model_name} #{pk} successfully.")
            return redirect(f"/editor/?tab={redirect_tab}")
        else:
            print("Form errors:", form.errors)
    else:
        form = form_class(instance=instance)

    return render(request, 'data_editor/edit_form.html', {
        'form': form,
        'model_name': model_name,
        'instance': instance,
        'is_create': False,
        'redirect_tab': redirect_tab,
    })