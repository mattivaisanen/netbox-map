from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from extras.models import Bookmark, Tag

from ..models import Map
from .utils import make_map, make_user


class PrepareUninstallTests(TestCase):
    def test_removes_rows_about_maps(self):
        map_ = make_map()
        tag = Tag.objects.create(name='Floor plans', slug='floor-plans')
        map_.tags.add(tag)
        Bookmark.objects.create(user=make_user('someone'), object=map_)

        out = StringIO()
        call_command('prepare_map_uninstall', dry_run=True, stdout=out)
        self.assertIn('1 bookmarks', out.getvalue())
        self.assertTrue(Bookmark.objects.exists())

        call_command('prepare_map_uninstall', interactive=False, stdout=StringIO())
        self.assertFalse(Bookmark.objects.exists())
        self.assertFalse(map_.tags.exists())
        self.assertTrue(Map.objects.filter(pk=map_.pk).exists())
