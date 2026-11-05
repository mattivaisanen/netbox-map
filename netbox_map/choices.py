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
    # A point that cables run through, such as a manhole, cable well or pole.
    JUNCTION = 'junction'

    CHOICES = (
        (LINE, _('Line')),
        (AREA, _('Area')),
        (CIRCLE, _('Circle')),
        (JUNCTION, _('Junction')),
    )


class ShapeLevelChoices(ChoiceSet):
    """
    How high a shape lies. A line is drawn dashed where it runs under an
    area or circle on a higher level, like a cable under a street.
    """
    BELOW = -1
    GROUND = 0
    ABOVE = 1

    CHOICES = (
        (BELOW, _('Below ground')),
        (GROUND, _('Ground')),
        (ABOVE, _('Above ground')),
    )
