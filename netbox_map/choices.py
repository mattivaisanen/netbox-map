from django.utils.translation import gettext_lazy as _

from utilities.choices import ChoiceSet


class BaseLayerChoices(ChoiceSet):
    """What a map is drawn on."""
    WORLD = 'world'
    IMAGE = 'image'

    CHOICES = (
        (WORLD, _('World map')),
        (IMAGE, _('Image only')),
    )


class ShapeKindChoices(ChoiceSet):
    """The kinds of shape that can be drawn on a map."""
    LINE = 'line'
    AREA = 'area'
    CIRCLE = 'circle'

    CHOICES = (
        (LINE, _('Line')),
        (AREA, _('Area')),
        (CIRCLE, _('Circle')),
    )
