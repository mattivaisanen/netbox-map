"""
Checks and reads overlay images.

Overlays are PNG, JPEG, GIF, WebP or SVG files. Raster images are read with
Pillow (NetBox installs it). SVG files can carry scripts that would run in
NetBox's own address if someone opened the file directly, so an SVG with a
script, an event handler, a script link, embedded HTML or a DOCTYPE is
refused. The file is parsed first, so the check sees the text after any
encoding (UTF-16, ...) and character references (`&#58;`) are resolved.
Overlays are also served with a sandboxing header (views.OverlayImageView),
which stops scripts even if one gets past this check.
"""
import os
import re
import xml.etree.ElementTree as ElementTree
from xml.parsers import expat

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _

RASTER_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
SVG_EXTENSION = '.svg'
ALLOWED_EXTENSIONS = RASTER_EXTENSIONS + (SVG_EXTENSION,)

# For the file picker, so it only offers images the plugin takes.
ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg'

# Elements that can run code or pull in HTML (compared without namespace).
UNSAFE_ELEMENTS = {'script', 'foreignobject', 'iframe', 'embed', 'object', 'handler', 'listener'}

# Link schemes that run code. Browsers ignore whitespace and control
# characters inside the scheme, so those are removed before comparing.
UNSAFE_SCHEME = re.compile(r'^(javascript|vbscript|data:text/html|data:application/xhtml)', re.IGNORECASE)
IGNORED_IN_SCHEME = re.compile(r'[\x00-\x20]+')

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
        if not is_safe_svg(_read(upload)):
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


def _local(name):
    """A tag or attribute name without its {namespace}, in lower case."""
    return name.rsplit('}', 1)[-1].lower()


def _reject_doctype(data):
    """
    Raises ValueError if the file has a DOCTYPE. A DOCTYPE can declare
    entities that hide markup from the checks below, and SVG needs none.
    """
    def refuse(*args):
        raise ValueError('DOCTYPE')

    parser = expat.ParserCreate()
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.Parse(data, True)


def is_safe_svg(data):
    """False for an SVG that could run code when opened, or that can't be parsed."""
    try:
        _reject_doctype(data)
        root = ElementTree.fromstring(data)
    except (ValueError, expat.ExpatError, ElementTree.ParseError):
        return False
    for element in root.iter():
        if not isinstance(element.tag, str) or _local(element.tag) in UNSAFE_ELEMENTS:
            return False
        for name, value in element.attrib.items():
            if _local(name).startswith('on'):
                return False
            if UNSAFE_SCHEME.match(IGNORED_IN_SCHEME.sub('', value)):
                return False
        # Style sheets can hold links too: url(javascript:...).
        if _local(element.tag) == 'style' and 'javascript' in IGNORED_IN_SCHEME.sub('', element.text or '').lower():
            return False
    return True


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
