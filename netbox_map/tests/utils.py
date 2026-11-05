from core.models import ObjectType
from dcim.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from users.models import ObjectPermission, User

from ..models import Map

# The smallest valid PNG: one transparent pixel.
PNG_1PX = bytes.fromhex(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082'
)


def make_site(name='Site A'):
    site, _ = Site.objects.get_or_create(name=name, slug=name.lower().replace(' ', '-'))
    return site


def make_device(name='edge-1'):
    manufacturer, _ = Manufacturer.objects.get_or_create(name='Maker', slug='maker')
    device_type, _ = DeviceType.objects.get_or_create(manufacturer=manufacturer, model='Box', slug='box')
    role, _ = DeviceRole.objects.get_or_create(name='Router', slug='router')
    return Device.objects.create(name=name, site=make_site(), device_type=device_type, role=role)


def make_map(name='Campus', **fields):
    map_ = Map(name=name, **fields)
    map_.full_clean()
    map_.save()
    return map_


def make_user(username, **fields):
    return User.objects.create(username=username, **fields)


def grant(user, actions, model):
    """Give `user` NetBox permission for `actions` on `model`."""
    permission = ObjectPermission.objects.create(name=f'{user.username}-{model._meta.model_name}', actions=actions)
    permission.object_types.set([ObjectType.objects.get_for_model(model)])
    permission.users.set([user])
    return permission
