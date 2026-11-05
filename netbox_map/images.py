"""
Checks and reads overlay images.

Overlays are PNG, JPEG, GIF, WebP or SVG files. Raster images are read with
Pillow (NetBox installs it). SVG files can carry scripts that would run in
NetBox's own address if someone opened the file directly, so an SVG with a
script, an event handler, a javascript: link or embedded HTML is refused.
"""
import os
import re
import xml.etree.ElementTree as ElementTree

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _

RASTER_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
SVG_EXTENSION = '.svg'
ALLOWED_EXTENSIONS = RASTER_EXTENSIONS + (SVG_EXTENSION,)

# For the file picker, so it only offers images the plugin takes.
ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg'

# Anything in an SVG that can run code or pull in HTML.
UNSAFE_SVG = re.compile(
    rb'<\s*script|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|\son[a-z]+\s*=|javascript\s*:',
    re.IGNORECASE,
)

# Used when an SVG gives no usable size.
DEFAULT_SVG_SIZE = (1000, 1000)


def is_svg(name):
    return os.path.splitext(name or '')[1].lower() == SVG_EXTENSION


def validate_image(upload):
    """Refuse files that are not an image type the plugin takes, or an unsafe SVG."""
    extension = os.path.splitext(upload.name or '')[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValidationError(_('Use a PNG, JPEG, GIF, WebP or SVG image.'))
    if extension == SVG_EXTENSION:
        if UNSAFE_SVG.search(_read(upload)):
            raise ValidationError(_('This SVG contains scripts or embedded HTML, which are not allowed.'))
    else:
        image_size(upload)  # Raises if Pillow can't read it


def image_size(upload):
    """The image's (width, height) in pixels."""
    if is_svg(upload.name):
        return _svg_size(_read(upload))
    from PIL import Image, UnidentifiedImageError

    try:
        upload.seek(0)
        with Image.open(upload) as image:
            size = image.size
    except (UnidentifiedImageError, OSError):
        raise ValidationError(_('The file is not a readable image.'))
    finally:
        upload.seek(0)
    return size


def _read(upload):
    upload.seek(0)
    data = upload.read()
    upload.seek(0)
    return data


def _number(value):
    """A length such as '1200', '1200px' or '1200.5' as a whole number, or None."""
    match = re.match(r'\s*([0-9.]+)\s*(px)?\s*$', value or '')
    return round(float(match.group(1))) if match else None


def _svg_size(data):
    """Size of an SVG from its width and height, or its viewBox."""
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError:
        raise ValidationError(_('The file is not a readable SVG image.'))
    width, height = _number(root.get('width')), _number(root.get('height'))
    if width and height:
        return width, height
    view_box = (root.get('viewBox') or '').replace(',', ' ').split()
    if len(view_box) == 4:
        try:
            width, height = round(float(view_box[2])), round(float(view_box[3]))
        except ValueError:
            width = height = 0
        if width > 0 and height > 0:
            return width, height
    return DEFAULT_SVG_SIZE
