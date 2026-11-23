import re
from datetime import timedelta
from pathlib import Path

from django.contrib.contenttypes.models import ContentType
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from dcim.models import CableBundle, Device, Rack
from netbox.plugins import get_plugin_config

from ..models import Map, MapMarker, MapOverlay, MapShape
from ..strings import TEXTS
from ..tables import MapOverlayTable
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
        response = self.client.post('/api/plugins/map/maps/', {'name': 'Yard'}, format='json')
        self.assertEqual(response.status_code, 201, response.content)
        device = make_device()
        response = self.client.post('/api/plugins/map/markers/', {
            'map': response.json()['id'], 'object_type': 'dcim.device', 'object_id': device.pk, 'x': 5, 'y': 6,
        }, format='json')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()['object']['name'], device.name)

    def test_marker_object_type_limited(self):
        map_ = make_map()
        response = self.client.post('/api/plugins/map/markers/', {
            'map': map_.pk, 'object_type': 'netbox_map.mapshape', 'object_id': 1, 'x': 0, 'y': 0,
        }, format='json')
        self.assertEqual(response.status_code, 400, response.content)


class ScriptTextTests(TestCase):
    def test_every_script_text_can_be_translated(self):
        assets = Path(__file__).resolve().parent.parent / 'assets'
        for name in ('map.js', 'export.js'):
            # Join texts split over lines ('a ' +\n 'b') first.
            script = re.sub(r"'\s*\+\s*\n\s*'", '', (assets / name).read_text())
            for text in re.findall(r"\bt\((?:[^'()]*\? )?'((?:[^'\\]|\\.)*)'", script):
                with self.subTest(script=name, text=text):
                    self.assertIn(text, TEXTS)


class OverlayImageTests(TestCase):
    def test_served_sandboxed_to_users_who_may_see_it(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>'
        overlay = MapOverlay(map=make_map(), name='Plan', image=SimpleUploadedFile('plan.svg', svg))
        overlay.full_clean()
        overlay.save()
        self.client.force_login(make_user('viewer', is_superuser=True))
        response = self.client.get(overlay.image_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/svg+xml')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        self.assertIn('sandbox', response['Content-Security-Policy'])
        self.assertEqual(b''.join(response.streaming_content), svg)
        # Pages link the view, not the media file.
        table = MapOverlayTable(MapOverlay.objects.all())
        self.assertIn(overlay.image_url, table.rows[0].get_cell('image'))
        self.assertContains(self.client.get(overlay.map.get_absolute_url()), overlay.image_url)

        self.client.force_login(make_user('nobody'))
        self.assertEqual(self.client.get(overlay.image_url).status_code, 404)


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

    @override_settings(LOGIN_REQUIRED=False, EXEMPT_VIEW_PERMISSIONS=['*'])
    def test_hover_card_for_anonymous_viewers_when_login_is_not_required(self):
        marker = MapMarker.objects.create(map=make_map(), object=make_device(), x=1, y=2)
        self.client.logout()
        response = self.client.get(reverse('plugins:netbox_map:marker_card', args=[marker.pk]))
        self.assertEqual(response.status_code, 200)

    def test_hover_card(self):
        device = make_device()
        rack = Rack.objects.create(name='R9', site=device.site)
        map_ = make_map()
        device_marker = MapMarker.objects.create(map=map_, object=device, x=1, y=2)
        rack_marker = MapMarker.objects.create(map=map_, object=rack, x=3, y=4)
        label = MapMarker.objects.create(map=map_, label='Door', x=5, y=6)

        def card(marker):
            return self.client.get(reverse('plugins:netbox_map:marker_card', args=[marker.pk]))

        # Built-in fields: status as a badge, related objects by name.
        response = card(device_marker)
        self.assertContains(response, 'text-bg-green')
        self.assertContains(response, 'Box')
        self.assertNotContains(response, 'nbm-elevation')
        # Racks show their elevation and are drawn square.
        self.assertContains(card(rack_marker), 'nbm-elevation')
        data = self.client.get(reverse('plugins:netbox_map:marker_data', args=[rack_marker.pk])).json()
        self.assertTrue(data['square'])
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

    def test_grid_pictures_show_the_start_view_with_areas_only(self):
        map_ = make_map(name='Harbour', rotation=30)
        MapMarker.objects.create(map=map_, label='Quay', x=24.90, y=60.10)
        MapShape.objects.create(map=map_, kind='area', points=[[24.95, 60.15], [24.96, 60.15], [24.96, 60.16]])
        MapShape.objects.create(map=map_, kind='line', points=[[24.95, 60.15], [25.00, 60.20]])
        response = self.client.get(reverse('plugins:netbox_map:map_list') + '?view=grid')
        self.assertContains(response, f'data-nbm-thumb="{map_.pk}"')
        data = response.context['thumbnail_data']
        picture = data['maps'][map_.pk]
        # Turned like the map; the area is drawn, the marker and line only widen the view.
        self.assertEqual(picture['rotation'], 30)
        self.assertEqual([shape['kind'] for shape in picture['shapes']], ['area'])
        self.assertEqual(picture['extent'], [[60.10, 24.90], [60.20, 25.00]])
        # Only tile backgrounds: the vector one needs WebGL.
        self.assertTrue(data['backgrounds'])
        self.assertTrue(all(layer.get('url') for layer in data['backgrounds']))

    def test_marker_data_for_the_editor(self):
        device = make_device()
        marker = MapMarker.objects.create(map=make_map(), object=device, x=1, y=2)
        data = self.client.get(reverse('plugins:netbox_map:marker_data', args=[marker.pk])).json()
        self.assertEqual(
            (data['label'], data['object'], data['status']), (device.name, f'dcim.device:{device.pk}', 'green'),
        )

    def test_device_health_dot(self):
        device = make_device()
        marker = MapMarker.objects.create(map=make_map(), object=device, x=1, y=2)
        url = reverse('plugins:netbox_map:marker_data', args=[marker.pk])
        # Off until a field is set.
        self.assertIsNone(self.client.get(url).json()['health'])

        def dot(value, **health):
            data = {'last_seen': value} if value is not None else {}
            Device.objects.filter(pk=device.pk).update(custom_field_data=data)
            config = {'netbox_map': {'device_health': {'field': 'cf.last_seen', **health}}}
            with self.settings(PLUGINS_CONFIG=config):
                return self.client.get(url).json()['health']

        # Minutes since the device was last seen, against the default levels (5, 15).
        self.assertEqual(dot(2), {'color': '#4caf50', 'title': 'Last seen: 2 min ago'})
        self.assertEqual(dot('10')['color'], '#ff9800')
        self.assertEqual(dot(60)['color'], '#f44336')
        # A time is turned into its age; own levels and unit.
        recent = (timezone.now() - timedelta(seconds=30)).isoformat()
        self.assertEqual(dot(recent, levels=[[1, '00ff00']], unit='hours')['color'], '#00ff00')
        # No value: grey, or no dot at all.
        self.assertEqual(dot(None)['title'], 'Last seen: no value')
        self.assertIsNone(dot(None, missing=''))
