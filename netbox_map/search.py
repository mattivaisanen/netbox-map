from netbox.search import SearchIndex

from .models import Map


class MapIndex(SearchIndex):
    model = Map
    fields = (
        ('name', 100),
        ('description', 500),
        ('comments', 5000),
    )
    display_attrs = ('parent', 'base_layer', 'description')


indexes = (MapIndex,)
