from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from dcim.models import CableBundle

from ..choices import ShapeKindChoices
from ..forms import MapShapeForm
from ..models import Map, MapMarker, MapOverlay, MapShape
from .utils import PNG_1PX, make_device, make_map, make_site


class MapTests(TestCase):
    def test_parent_cannot_loop(self):
        building = make_map('Building')
        floor = make_map('Floor 1', parent=building)
        building.parent = floor
        with self.assertRaises(ValidationError):
            building.full_clean()

    def test_scope_must_be_a_location_type(self):
        device = make_device()
        map_ = Map(name='Wrong', scope_type=ContentType.objects.get_for_model(device), scope_id=device.pk)
        with self.assertRaises(ValidationError):
            map_.full_clean()

    def test_deleting_the_scope_keeps_the_map(self):
        site = make_site('Site B')
        map_ = make_map('Site B plan', scope_type=ContentType.objects.get_for_model(site), scope_id=site.pk)
        site.delete()
        map_.refresh_from_db()
        self.assertIsNone(map_.scope_id)


class MapViewSettingsTests(TestCase):
    def test_start_view_all_or_none(self):
        make_map('Whole', default_x=24.9, default_y=60.2, default_zoom=12)
        with self.assertRaises(ValidationError):
            make_map('Partial', default_x=24.9)

    def test_layer_offsets_are_checked(self):
        map_ = make_map()
        map_.layer_offsets = {'Satellite': [1.5, -0.25]}
        map_.full_clean()
        for offsets in ({'Satellite': [1]}, {'Satellite': [5000, 0]}, ['Satellite']):
            map_.layer_offsets = offsets
            with self.subTest(offsets=offsets), self.assertRaises(ValidationError):
                map_.full_clean()

    def test_rotation_is_limited(self):
        make_map('Turned', rotation=-45)
        with self.assertRaises(ValidationError):
            make_map('Too far', rotation=400)


class MarkerTests(TestCase):
    def test_object_or_label_required(self):
        with self.assertRaises(ValidationError):
            MapMarker(map=make_map()).full_clean()
        MapMarker(map=make_map('Other'), label='Entrance').full_clean()

    def test_moved_labels_are_checked(self):
        map_ = make_map()
        marker = MapMarker(map=map_, label='Entrance', label_offset=[12, -8])
        marker.full_clean()
        area = MapShape(map=map_, kind='area', points=[[0, 0], [1, 0], [1, 1]], label='Yard', label_position=[0.5, 0.5])
        area.full_clean()
        for bad in ([1], ['a', 'b'], [True, 0], {'x': 1}):
            marker.label_offset, area.label_position = bad, bad
            with self.subTest(value=bad), self.assertRaises(ValidationError):
                marker.full_clean()
            with self.subTest(value=bad), self.assertRaises(ValidationError):
                area.full_clean()

    def test_same_object_once_per_map_but_on_many_maps(self):
        device = make_device()
        first, second = make_map('First'), make_map('Second')
        MapMarker.objects.create(map=first, object=device)
        MapMarker(map=second, object=device).full_clean()
        with self.assertRaises(ValidationError):
            MapMarker(map=first, object=device).full_clean()

    def test_map_cannot_link_to_itself(self):
        map_ = make_map()
        with self.assertRaises(ValidationError):
            MapMarker(map=map_, object=map_).full_clean()

    def test_link_to_other_map(self):
        floor = make_map('Floor')
        marker = MapMarker.objects.create(map=make_map(), object=floor, x=1, y=2)
        self.assertTrue(marker.is_map_link)

    def test_deleted_object_leaves_every_map(self):
        device = make_device()
        MapMarker.objects.create(map=make_map('First'), object=device)
        MapMarker.objects.create(map=make_map('Second'), object=device)
        device.delete()
        self.assertFalse(MapMarker.objects.exists())


class ShapeTests(TestCase):
    def test_points_are_checked(self):
        map_ = make_map()
        MapShape(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [1.5, 2]]).full_clean()
        for kind, points, radius in (
            (ShapeKindChoices.LINE, [[0, 0]], None),            # too few points
            (ShapeKindChoices.AREA, [[0, 0], [1, 1], 'x'], None),  # not a pair
            (ShapeKindChoices.CIRCLE, [[0, 0]], None),          # no radius
            (ShapeKindChoices.LINE, [[0, 0], [1, 1]], 5),       # radius on a line
        ):
            with self.subTest(kind=kind, points=points), self.assertRaises(ValidationError):
                MapShape(map=map_, kind=kind, points=points, radius=radius).full_clean()

    def test_link_to_another_map_only(self):
        map_ = make_map()
        area = MapShape(map=map_, kind=ShapeKindChoices.AREA, points=[[0, 0], [1, 0], [1, 1]], link=make_map('Floor'))
        area.full_clean()
        area.link = map_
        with self.assertRaises(ValidationError):
            area.full_clean()

    def test_line_as_route(self):
        map_ = make_map()
        bundle = CableBundle.objects.create(name='Trunk 9')
        line = MapShape(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [1, 1]], object=bundle)
        line.full_clean()
        line.save()
        # Only lines are routes.
        area = MapShape(map=map_, kind=ShapeKindChoices.AREA, points=[[0, 0], [1, 0], [1, 1]], object=bundle)
        with self.assertRaises(ValidationError):
            area.full_clean()
        # Not every object can have a route.
        line.object = map_
        with self.assertRaises(ValidationError):
            line.full_clean()
        # Deleting the bundle keeps the drawn line, without its bundle.
        bundle.delete()
        line.refresh_from_db()
        self.assertIsNone(line.object_id)

    def test_line_ends_follow_their_marker(self):
        map_ = make_map()
        marker = MapMarker.objects.create(map=map_, label='Well', x=0, y=0)
        line = MapShape(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [5, 5]],
                        ends={'start': {'marker': marker.pk}})
        line.full_clean()
        line.save()
        marker.x, marker.y = 2, 3
        marker.save()
        line.refresh_from_db()
        self.assertEqual(line.points, [[2, 3], [5, 5]])
        # Ends are checked, and only lines have them.
        for kind, ends in ((ShapeKindChoices.LINE, {'middle': {'marker': 1}}),
                           (ShapeKindChoices.AREA, {'start': {'marker': marker.pk}})):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                MapShape(map=map_, kind=kind, points=[[0, 0], [1, 0], [1, 1]], ends=ends).full_clean()

    def test_lines_run_through_junctions(self):
        map_ = make_map()
        junction = MapShape(map=map_, kind=ShapeKindChoices.JUNCTION, points=[[1, 1]])
        junction.full_clean()
        junction.save()
        line = MapShape(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [1, 1], [5, 5]],
                        ends={'via': [{'point': 1, 'shape': junction.pk}]})
        line.full_clean()
        line.save()
        junction.points = [[2, 0]]
        junction.save()
        line.refresh_from_db()
        self.assertEqual(line.points, [[0, 0], [2, 0], [5, 5]])
        # A junction is one point; "via" only names points in between.
        with self.assertRaises(ValidationError):
            MapShape(map=map_, kind=ShapeKindChoices.JUNCTION, points=[[0, 0], [1, 1]]).full_clean()
        for via in ([{'point': 0, 'shape': 1}], [{'point': 1}], {'point': 1, 'shape': 1}):
            with self.subTest(via=via), self.assertRaises(ValidationError):
                MapShape(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [1, 1], [2, 2]], ends={'via': via}).full_clean()

    def test_form_shows_radius_only_for_circles(self):
        map_ = make_map()
        area = MapShape.objects.create(map=map_, kind=ShapeKindChoices.AREA, points=[[0, 0], [1, 0], [1, 1]])
        circle = MapShape.objects.create(map=map_, kind=ShapeKindChoices.CIRCLE, points=[[0, 0]], radius=5)
        self.assertNotIn('radius', MapShapeForm(instance=area).fields)
        self.assertIn('radius', MapShapeForm(instance=circle).fields)
        self.assertNotIn('points', MapShapeForm(instance=area).fields)
        # Lines don't open maps.
        line = MapShape.objects.create(map=map_, kind=ShapeKindChoices.LINE, points=[[0, 0], [1, 1]])
        self.assertNotIn('link', MapShapeForm(instance=line).fields)
        self.assertIn('link', MapShapeForm(instance=area).fields)


@override_settings(MEDIA_ROOT='/tmp/netbox-map-tests')
class OverlayTests(TestCase):
    def test_png_size_is_read(self):
        overlay = MapOverlay(map=make_map(), name='Plan', image=SimpleUploadedFile('plan.png', PNG_1PX))
        overlay.full_clean()
        overlay.save()
        self.assertEqual((overlay.image_width, overlay.image_height), (1, 1))

    def test_svg_size_and_unsafe_svg(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="10" height="10"/></svg>'
        overlay = MapOverlay(map=make_map(), name='Plan', image=SimpleUploadedFile('plan.svg', svg))
        overlay.full_clean()
        overlay.save()
        self.assertEqual((overlay.image_width, overlay.image_height), (400, 300))

        unsafe = b'<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>'
        with self.assertRaises(ValidationError):
            MapOverlay(map=overlay.map, name='Bad', image=SimpleUploadedFile('bad.svg', unsafe)).full_clean()

    def test_other_files_refused(self):
        with self.assertRaises(ValidationError):
            MapOverlay(map=make_map(), name='Doc', image=SimpleUploadedFile('plan.pdf', b'%PDF-1.4')).full_clean()

    def test_corners_all_or_none(self):
        with self.assertRaises(ValidationError):
            MapOverlay(map=make_map(), name='Half', image=SimpleUploadedFile('p.png', PNG_1PX), x_min=0).full_clean()
