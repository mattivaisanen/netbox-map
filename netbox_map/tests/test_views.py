from django.contrib.contenttypes.models import ContentType
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from netbox.plugins import get_plugin_config

from dcim.models import CableBundle, Rack

from ..models import Map, MapMarker, MapShape
from .utils import make_device, make_map, make_site, make_user


class PageTests(TestCase):
    def setUp(self):
        self.user = make_user('admin', is_superuser=True)
        self.client.force_login(self.user)

    def test_pages_load(self):
        map_ = make_map()
        MapMarker.objects.create(map=map_, object=make_device(), x=0, y=0)
        MapMarker.objects.create(map=map_, label='Entrance')
        for name, args in (
            ('map_list', []), ('map', [map_.pk]), ('map_add', []), ('map_edit', [map_.pk]),
            ('mapmarker_list', []), ('mapmarker_add', []), ('mapoverlay_list', []), ('mapoverlay_add', []),
            ('mapshape_list', []),
        ):
            with self.subTest(page=name):
                response = self.client.get(reverse(f'plugins:netbox_map:{name}', args=args))
                self.assertEqual(response.status_code, 200)
        self.assertContains(self.client.get(map_.get_absolute_url()), 'Entrance')

    def test_add_map_from_form(self):
        response = self.client.post(reverse('plugins:netbox_map:map_add'), {'name': 'Hall', 'base_layer': 'image'})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Map.objects.filter(name='Hall', base_layer='image').exists())


class APITests(TestCase):
    def setUp(self):
        self.user = make_user('api', is_superuser=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_create_map_and_marker(self):
        response = self.client.post('/api/plugins/maps/maps/', {'name': 'Yard'}, format='json')
        self.assertEqual(response.status_code, 201, response.content)
        device = make_device()
        response = self.client.post('/api/plugins/maps/markers/', {
            'map': response.json()['id'], 'object_type': 'dcim.device', 'object_id': device.pk, 'x': 5, 'y': 6,
        }, format='json')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()['object']['name'], device.name)


class MapViewTests(TestCase):
    def setUp(self):
        self.user = make_user('viewer', is_superuser=True)
        self.client.force_login(self.user)

    def test_assets_are_served(self):
        response = self.client.get(reverse('plugins:netbox_map:asset', args=['map.js']))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'text/javascript')
        self.assertEqual(self.client.get(reverse('plugins:netbox_map:asset', args=['export.js'])).status_code, 200)
        self.assertEqual(self.client.get(reverse('plugins:netbox_map:asset', args=['secret.py'])).status_code, 404)

    def test_map_page_has_map_and_editor(self):
        map_ = make_map()
        MapMarker.objects.create(map=map_, object=make_device(), x=1, y=2)
        response = self.client.get(map_.get_absolute_url() + '?edit=1')
        self.assertContains(response, 'id="nbm-map-data"')
        self.assertContains(response, 'data-nbm-draw="area"')
        self.assertContains(response, 'export.js')

    def test_show_on_map_falls_back_to_the_rack(self):
        device = make_device()
        device.rack = Rack.objects.create(name='R1', site=device.site)
        device.save()
        map_ = make_map()
        marker = MapMarker.objects.create(map=map_, object=device.rack, x=1, y=2)
        response = self.client.get(device.get_absolute_url())
        self.assertContains(response, 'Show on map')
        self.assertContains(response, f'{map_.get_absolute_url()}?marker={marker.pk}')

    def test_assigned_map_shows_on_site_page(self):
        site = make_site('Site C')
        make_map('Site C plan', scope_type=ContentType.objects.get_for_model(site), scope_id=site.pk)
        self.assertContains(self.client.get(site.get_absolute_url()), 'Site C plan')

    def test_hover_card(self):
        device = make_device()
        rack = Rack.objects.create(name='R9', site=device.site)
        map_ = make_map()
        device_marker = MapMarker.objects.create(map=map_, object=device, x=1, y=2)
        rack_marker = MapMarker.objects.create(map=map_, object=rack, x=3, y=4)
        label = MapMarker.objects.create(map=map_, label='Door', x=5, y=6)
        card = lambda marker: self.client.get(reverse('plugins:netbox_map:marker_card', args=[marker.pk]))
        # Built-in fields: status as a badge, related objects by name.
        response = card(device_marker)
        self.assertContains(response, 'text-bg-green')
        self.assertContains(response, 'Box')
        self.assertNotContains(response, 'nbm-elevation')
        # Racks show their elevation and are drawn square.
        self.assertContains(card(rack_marker), 'nbm-elevation')
        self.assertTrue(self.client.get(reverse('plugins:netbox_map:marker_data', args=[rack_marker.pk])).json()['square'])
        # Configured fields; a name the object doesn't have is left out.
        config = {'netbox_map': {'hover_fields': {'dcim.device': ['serial', 'device_type.manufacturer', 'nonsense']}}}
        with self.settings(PLUGINS_CONFIG=config):
            response = card(device_marker)
        self.assertContains(response, 'Maker')
        self.assertNotContains(response, 'Nonsense')
        self.assertNotContains(response, 'text-bg-green')
        # Labels have no card.
        self.assertEqual(card(label).status_code, 404)

    def test_route_card_and_sidebar_data(self):
        bundle = CableBundle.objects.create(name='Trunk 7', description='Riser')
        parent = make_map('Building')
        map_ = make_map('Floor 2', parent=parent)
        line = MapShape.objects.create(map=map_, kind='line', points=[[0, 0], [1, 1]], object=bundle)
        response = self.client.get(reverse('plugins:netbox_map:shape_card', args=[line.pk]))
        self.assertContains(response, 'Trunk 7')
        self.assertContains(response, 'Riser')
        page = self.client.get(map_.get_absolute_url())
        data = page.context['map_data']
        self.assertEqual([step['label'] for step in data['place']], ['Building'])
        self.assertEqual(data['shapes'][0]['object'], f'dcim.cablebundle:{bundle.pk}')
        # The backgrounds are the configured ones (the defaults unless set locally).
        self.assertEqual(
            [layer['name'] for layer in data['tiles']['layers']],
            [layer['name'] for layer in get_plugin_config('netbox_map', 'base_layers')],
        )
        self.assertContains(page, 'id="nbm-sidebar"')

    def test_maps_grid_is_remembered(self):
        make_map(name='Plant')
        self.client.force_login(self.user)
        response = self.client.get(reverse('plugins:netbox_map:map_list') + '?view=grid')
        self.assertContains(response, 'nbm-map-card')
        # The choice sticks until the user picks the list again.
        self.assertContains(self.client.get(reverse('plugins:netbox_map:map_list')), 'nbm-map-card')
        response = self.client.get(reverse('plugins:netbox_map:map_list') + '?view=list')
        self.assertNotContains(response, 'nbm-map-card')

    def test_world_maps_get_a_picture_in_the_grid(self):
        map_ = make_map(name='Harbour')
        MapMarker.objects.create(map=map_, label='Quay', x=24.95, y=60.16)
        MapMarker.objects.create(map=map_, label='Gate', x=24.96, y=60.17)
        make_map(name='Floor', base_layer='image')
        response = self.client.get(reverse('plugins:netbox_map:map_list') + '?view=grid')
        # Tiles of the first tile background (the vector one is skipped), zoomed in on the markers.
        self.assertContains(response, 'class="nbm-thumb-picture"', count=1)
        self.assertContains(response, 'https://tile.openstreetmap.org/12/')
        self.assertContains(response, 'nbm-thumb-credit')

    def test_marker_data_for_the_editor(self):
        device = make_device()
        marker = MapMarker.objects.create(map=make_map(), object=device, x=1, y=2)
        data = self.client.get(reverse('plugins:netbox_map:marker_data', args=[marker.pk])).json()
        self.assertEqual((data['label'], data['object'], data['status']), (device.name, f'dcim.device:{device.pk}', 'green'))
