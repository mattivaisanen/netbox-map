import os

from django import template
from django.urls import reverse

from .. import NetBoxMapConfig
from ..assets import FOLDER

register = template.Library()


@register.simple_tag
def map_asset(name):
    """
    Address of one of the map's assets. The plugin version and the file's
    modification time are added, so browsers load a changed file at once
    instead of using their cached copy.
    """
    changed = int(os.path.getmtime(os.path.join(FOLDER, name)))
    return f"{reverse('plugins:netbox_map:asset', args=[name])}?v={NetBoxMapConfig.version}.{changed}"
