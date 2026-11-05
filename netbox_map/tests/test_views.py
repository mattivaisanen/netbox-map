from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient


from ..models import Map, MapMarker
from .utils import make_device, make_map, make_user


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
            ('mapshape_list', []), ('mapshape_add', []),
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
