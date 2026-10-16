# data_editor/admin.py
from django.contrib import admin
from camino.models import Albergue, PrivateAccomm, Paragraph

@admin.register(Albergue)
class AlbergueAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'location', 'phone', 'whatsapp', 'privateRoomsAvailable', 'has_booking_link')
    list_filter = ('location', 'privateRoomsAvailable')
    list_editable = ('privateRoomsAvailable',)
    search_fields = ('name', 'phone', 'whatsapp')

    def has_booking_link(self, obj):
        return bool(obj.booking_url)
    has_booking_link.boolean = True


@admin.register(PrivateAccomm)
class PrivateAccommAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'location', 'phone', 'whatsapp')
    list_filter = ('location',)
    search_fields = ('name', 'phone', 'whatsapp')

@admin.register(Paragraph)
class ParagraphAdmin(admin.ModelAdmin):
    list_display = ('id', 'location', 'type', 'preview_text')
    list_filter = ('location', 'type')
    search_fields = ('text', 'type')
    ordering = ('location', 'id')

    def preview_text(self, obj):
        text = getattr(obj, 'text', '') or ''
        return text[:80] + ('...' if len(text) > 80 else '')
    preview_text.short_description = 'Text Preview'
    
    def get_list_display(self, request):
        """Dynamically detect present fields so admin never crashes."""
        field_names = [f.name for f in Paragraph._meta.fields]
        display = ['id']
        
        # Look for location field
        for candidate in ['location', 'location_id']:
            if candidate in field_names:
                display.append(candidate)
                break

        # Look for sequence field
        for candidate in ['paragraph_sequence', 'paragraphSequence', 'sequence', 'seq']:
            if candidate in field_names:
                display.append(candidate)
                break

        # Always include the text preview
        display.append('preview_text')
        return display

    def get_search_fields(self, request):
        field_names = [f.name for f in Paragraph._meta.fields]
        for candidate in ['paragraph_text', 'paragraphText', 'text', 'content']:
            if candidate in field_names:
                return (candidate,)
        return ('id',)

    def preview_text(self, obj):
        for candidate in ['paragraph_text', 'paragraphText', 'text', 'content']:
            val = getattr(obj, candidate, None)
            if val:
                return str(val)[:80] + ('...' if len(str(val)) > 80 else '')
        return '-'
    preview_text.short_description = 'Content Preview'