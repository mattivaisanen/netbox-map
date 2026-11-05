from django import template
from django.urls import reverse

from .. import NetBoxMapConfig

register = template.Library()


@register.simple_tag
def map_asset(name):
    """Address of one of the map's assets, with the plugin version so browsers reload it after an upgrade."""
    return f"{reverse('plugins:netbox_map:asset', args=[name])}?v={NetBoxMapConfig.version}"
