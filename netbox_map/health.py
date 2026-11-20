"""
Device health dots: a small colored dot on device markers, telling at a
glance how fresh a value on the device is, such as when it last answered.

The value is read from the field named by the `device_health` setting: a
custom field ('cf.last_seen') or a path through the device's attributes.
A number is an age in the setting's unit; a date or time is turned into
its age from now. The age is then matched against the setting's levels to
pick a color. Nothing is written anywhere and no other plugin is needed:
whatever fills the field (a monitoring job, a script, a person) drives the dot.
"""
import math
from datetime import date, datetime

from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from netbox.plugins import get_plugin_config

PLUGIN = 'netbox_map'

# Seconds in each unit a numeric value can be given in.
UNITS = {'seconds': 1, 'minutes': 60, 'hours': 3600, 'days': 86400}

# Used for any key the `device_health` setting leaves out.
DEFAULTS = {
    'field': '',
    'label': '',
    'unit': 'minutes',
    # [up to this age, color]: the first level the age fits in gives the color.
    'levels': [[5, '4caf50'], [15, 'ff9800']],
    # Older than every level.
    'over': 'f44336',
    # No value, or one that can't be read. Empty: no dot.
    'missing': '9e9e9e',
}


def _color(value):
    """'#rrggbb' from a hex color setting, or None when it isn't one."""
    value = str(value or '').strip().lstrip('#').lower()
    if len(value) == 6 and all(c in '0123456789abcdef' for c in value):
        return f'#{value}'
    return None


def settings():
    """The `device_health` setting with defaults filled in, or None when no field is set."""
    config = {**DEFAULTS, **(get_plugin_config(PLUGIN, 'device_health') or {})}
    field = str(config['field'] or '').strip()
    if not field:
        return None
    levels = []
    for level in config['levels'] or []:
        try:
            limit, color = float(level[0]), _color(level[1])
        except (TypeError, ValueError, IndexError):
            continue
        if color:
            levels.append((limit, color))
    return {
        'field': field,
        'label': config['label'] or field.split('.')[-1].replace('_', ' ').capitalize(),
        'unit': config['unit'] if config['unit'] in UNITS else DEFAULTS['unit'],
        'levels': sorted(levels),
        'over': _color(config['over']),
        'missing': _color(config['missing']),
    }


def read_value(obj, field):
    """
    The value at `field` on `obj`. Custom fields are read from the stored
    data directly, so this costs no database query. Returns None for a
    name the object doesn't have.
    """
    if field.startswith('cf.'):
        return (getattr(obj, 'custom_field_data', None) or {}).get(field[3:])
    value = obj
    for part in field.split('.'):
        try:
            value = getattr(value, part)
        except Exception:  # A missing attribute or a missing related object.
            return None
        if value is None:
            return None
    return value


def age_in_seconds(value, unit):
    """How old `value` is, in seconds, or None when it isn't a number, date or time."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        try:
            value = float(text)
        except ValueError:
            value = parse_datetime(text) or parse_date(text)
    if isinstance(value, (int, float)):
        return value * UNITS[unit] if math.isfinite(value) else None
    if isinstance(value, datetime):
        if timezone.is_naive(value):
            value = timezone.make_aware(value)
        return (timezone.now() - value).total_seconds()
    if isinstance(value, date):
        return (timezone.localdate() - value).days * 86400
    return None


def describe_age(seconds):
    """A short age for the dot's tooltip: '45 s ago', '12 min ago', '3 h ago', '2 d ago'."""
    seconds = max(seconds, 0)
    for size, suffix in ((86400, 'd'), (3600, 'h'), (60, 'min')):
        if seconds >= size:
            return f'{int(seconds // size)} {suffix} ago'
    return f'{int(seconds)} s ago'


def device_health(obj, config):
    """
    The dot for one device: {'color': '#rrggbb', 'title': 'Last seen: 12 min ago'},
    or None when no dot is shown. `config` is from settings().
    """
    seconds = age_in_seconds(read_value(obj, config['field']), config['unit'])
    if seconds is None:
        color, text = config['missing'], 'no value'
    else:
        limit_seconds = UNITS[config['unit']]
        color = next((c for limit, c in config['levels'] if seconds <= limit * limit_seconds), config['over'])
        text = describe_age(seconds)
    if not color:
        return None
    return {'color': color, 'title': f"{config['label']}: {text}"}
