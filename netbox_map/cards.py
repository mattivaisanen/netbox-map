"""
The card shown when the mouse rests on a marker: the object's name, its
type and a few of its fields, laid out like the attribute panels on NetBox's
own object pages. Lines drawn as a cable's or circuit's route get the
same card. Which fields show is set per object type with the
`hover_fields` setting. Racks also show their front elevation and the
devices in them.
"""
from django.core.exceptions import FieldDoesNotExist
from django.db import models
from django.db.models import F
from django.urls import reverse
from django.utils.http import urlencode

from dcim.models import Device
from netbox.plugins import get_plugin_config

PLUGIN = 'netbox_map'

# Fields shown when `hover_fields` doesn't name the object's type.
DEFAULT_HOVER_FIELDS = {
    'dcim.device': ['status', 'role', 'device_type', 'primary_ip', 'rack', 'position'],
    'dcim.rack': ['status', 'role', 'location', 'u_height'],
    'dcim.site': ['status', 'region', 'facility'],
    'dcim.location': ['status', 'site', 'parent'],
    'dcim.powerpanel': ['site', 'location'],
    'circuits.circuit': ['status', 'provider', 'type'],
    'netbox_map.map': ['base_layer', 'description'],
    # Lines drawn as routes.
    'dcim.cable': ['status', 'type', 'a_terminations', 'b_terminations', 'length'],
    'dcim.cablebundle': ['description'],
}
OTHER_FIELDS = ['status', 'description']

# Size of the rack elevation drawn on a rack's card, in pixels.
ELEVATION_SIZE = {'unit_width': 160, 'unit_height': 12, 'legend_width': 24, 'include_images': 'false'}


def hover_fields(type_label):
    """The field names to show for objects of type 'app.model'."""
    configured = get_plugin_config(PLUGIN, 'hover_fields') or {}
    if type_label in configured:
        return configured[type_label]
    return DEFAULT_HOVER_FIELDS.get(type_label, OTHER_FIELDS)


def _verbose_name(model, name):
    try:
        return str(model._meta.get_field(name).verbose_name)
    except FieldDoesNotExist:
        return name.replace('_', ' ')


def field_row(obj, path):
    """
    One row of the card for `path`: a field name, a path through related
    objects ('device_type.manufacturer') or a custom field ('cf.name').
    Returns None for a name the object doesn't have, so a typo in the
    setting leaves the row out instead of breaking the card.
    """
    if path.startswith('cf.'):
        name = path[3:]
        if not hasattr(obj, 'cf') or name not in obj.cf:
            return None
        return {'label': name.replace('_', ' '), 'text': obj.cf.get(name)}

    owner, value = obj, obj
    parts = path.split('.')
    for part in parts:
        if value is None:
            break
        if not hasattr(value, part):
            return None
        owner, value = value, getattr(value, part)
    name = parts[-1]
    label = _verbose_name(type(owner), name) if isinstance(owner, models.Model) else name.replace('_', ' ')
    row = {'label': label, 'text': value}

    # Choice fields show their label, and as a colored badge when they have colors (status).
    display = getattr(owner, f'get_{name}_display', None) if value is not None else None
    if display is not None:
        row['text'] = display()
        color = getattr(owner, f'get_{name}_color', None)
        row['color'] = color() if color else None
    elif isinstance(value, models.Model):
        row['text'] = str(value)
        row['url'] = value.get_absolute_url() if hasattr(value, 'get_absolute_url') else None
    elif isinstance(value, models.Manager):
        return None
    elif name == 'length' and value is not None and getattr(owner, 'length_unit', None):
        # A cable's length with its unit: "12 Meters".
        row['text'] = f'{value:g} {owner.get_length_unit_display()}'
    elif isinstance(value, (list, tuple)):
        # Such as a cable's terminations.
        row['text'] = ', '.join(_describe(item) for item in value)
    return row


def _describe(item):
    # A cable end reads better with its device: "sw-1 Gi0/1".
    device = getattr(item, 'device', None)
    return f'{device} {item}' if device is not None else str(item)


def card_context(obj, object_type, user):
    """What the card template needs for `obj`, a marker's object or a line's route."""
    type_label = f'{object_type.app_label}.{object_type.model}'
    rows = [row for row in (field_row(obj, path) for path in hover_fields(type_label)) if row is not None]
    context = {'name': str(obj), 'url': obj.get_absolute_url(), 'type': str(object_type.name).title(), 'rows': rows}
    if type_label == 'dcim.rack':
        # Racks: the elevation beside the details, and the devices in the rack.
        if get_plugin_config(PLUGIN, 'rack_elevation'):
            context['elevation_url'] = (
                reverse('dcim-api:rack-elevation', kwargs={'pk': obj.pk})
                + '?' + urlencode({'face': 'front', 'render': 'svg', **ELEVATION_SIZE})
            )
        context['devices'] = Device.objects.restrict(user, 'view').filter(rack=obj).order_by(
            F('position').desc(nulls_last=True), 'name',
        )
    return context
