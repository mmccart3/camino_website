# data_editor/forms.py
from django import forms
from camino.models import Albergue, PrivateAccomm, Paragraph, Location

COUNTRY_CODE_CHOICES = [
    ('+34', '+34 (Spain)'),
    ('+33', '+33 (France)'),
    ('+351', '+351 (Portugal)'),
    ('+44', '+44 (UK)'),
]

class LocationChoiceField(forms.ModelChoiceField):
    def label_from_instance(self, obj):
        return getattr(obj, 'location_name', f"Location #{obj.pk}")


class BaseEditorForm(forms.ModelForm):
    location = LocationChoiceField(
        queryset=Location.objects.all().order_by('location_name'),
        required=True
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        always_required = {'name', 'location', 'text', 'type'}
        for name, field in self.fields.items():
            if name not in always_required:
                field.required = False

        # Country code styling
        for code_field in ['country_code', 'countryCode', 'phone_country_code', 'tel_country_code']:
            if code_field in self.fields:
                self.fields[code_field].widget = forms.Select(choices=COUNTRY_CODE_CHOICES)
                self.fields[code_field].initial = '+34'

        # Coordinates styling
        coord_field_pairs = [
            ('latitude', '43.163456'), ('lat', '43.163456'), ('gps_lat', '43.163456'),
            ('longitude', '-1.238912'), ('lon', '-1.238912'), ('lng', '-1.238912'), ('gps_long', '-1.238912')
        ]
        for field_name, placeholder in coord_field_pairs:
            if field_name in self.fields:
                self.fields[field_name].widget = forms.NumberInput(attrs={
                    'step': 'any',
                    'placeholder': f"e.g. {placeholder}",
                    'class': 'form-input-coord'
                })

# data_editor/forms.py

class AlbergueForm(BaseEditorForm):
    class Meta:
        model = Albergue
        exclude = ('id',)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        # Style numeric fields (beds, dorms, rates)
        for num_field in ['dorms', 'numberOfDorms', 'beds', 'numberOfBeds']:
            if num_field in self.fields:
                self.fields[num_field].widget = forms.NumberInput(attrs={
                    'min': '0',
                    'placeholder': 'e.g. 3',
                    'style': 'width: 140px;'
                })
                self.fields[num_field].required = False

        if 'dorms' in self.fields:
            self.fields['dorms'].label = "Number of Dorms"
        elif 'numberOfDorms' in self.fields:
            self.fields['numberOfDorms'].label = "Number of Dorms"

        # Boolean facility flags
        boolean_fields = [
            'privateRoomsAvailable', 'kitchen', 'washer', 'communal_meal', 'dryer'
        ]
        for f in boolean_fields:
            if f in self.fields:
                self.fields[f].widget = forms.CheckboxInput(attrs={'class': 'form-checkbox'})
                self.fields[f].required = False

class PrivateAccommForm(BaseEditorForm):
    class Meta:
        model = PrivateAccomm
        exclude = ('id',)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for name, field in self.fields.items():
            if isinstance(field.widget, (forms.CheckboxInput, forms.NullBooleanSelect)) or 'available' in name.lower():
                field.widget = forms.CheckboxInput(attrs={'class': 'form-checkbox'})
                field.required = False


class ParagraphForm(BaseEditorForm):
    class Meta:
        model = Paragraph
        fields = ['location', 'type', 'text']
        widgets = {
            'text': forms.Textarea(attrs={'rows': 6, 'style': 'width: 100%; font-family: sans-serif;'}),
        }