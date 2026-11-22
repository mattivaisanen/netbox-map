# All of the plugin's tables, as of 0.1.0. Replaces the seven migrations
# made while 0.1.0 was being built, so a database that already has them is
# taken as up to date.

import django.core.validators
import django.db.models.deletion
import netbox.models.deletion
import netbox_map.images
import netbox_map.models
import taggit.managers
import utilities.fields
import utilities.json
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    replaces = [
        ('netbox_map', '0001_initial'),
        ('netbox_map', '0002_map_view_and_shape_links'),
        ('netbox_map', '0003_shape_routes'),
        ('netbox_map', '0004_shape_levels_and_ends'),
        ('netbox_map', '0005_junctions_and_layer_offsets'),
        ('netbox_map', '0006_curved_lines'),
        ('netbox_map', '0007_movable_labels'),
    ]

    dependencies = [
        ("contenttypes", "0002_remove_content_type_name"),
        ("extras", "0144_customfield_status"),
    ]

    operations = [
        migrations.CreateModel(
            name="Map",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("created", models.DateTimeField(auto_now_add=True, null=True)),
                ("last_updated", models.DateTimeField(auto_now=True, null=True)),
                (
                    "custom_field_data",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        encoder=utilities.json.CustomFieldJSONEncoder,
                    ),
                ),
                ("name", models.CharField(max_length=100, unique=True)),
                ("base_layer", models.CharField(default="world", max_length=20)),
                ("scope_id", models.PositiveBigIntegerField(blank=True, null=True)),
                ("description", models.CharField(blank=True, max_length=200)),
                ("comments", models.TextField(blank=True)),
                ("default_x", models.FloatField(blank=True, null=True)),
                ("default_y", models.FloatField(blank=True, null=True)),
                ("default_zoom", models.FloatField(blank=True, null=True)),
                (
                    "rotation",
                    models.FloatField(
                        default=0,
                        validators=[
                            django.core.validators.MinValueValidator(-360),
                            django.core.validators.MaxValueValidator(360),
                        ],
                    ),
                ),
                ("layer_offsets", models.JSONField(blank=True, default=dict)),
                (
                    "parent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="children",
                        to="netbox_map.map",
                    ),
                ),
                (
                    "scope_type",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={
                            "model__in": ("region", "sitegroup", "site", "location")
                        },
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="contenttypes.contenttype",
                    ),
                ),
                (
                    "tags",
                    taggit.managers.TaggableManager(
                        through="extras.TaggedItem", to="extras.Tag"
                    ),
                ),
            ],
            options={
                "verbose_name": "map",
                "verbose_name_plural": "maps",
                "ordering": ("name",),
            },
            bases=(netbox.models.deletion.DeleteMixin, models.Model),
        ),
        migrations.CreateModel(
            name="MapMarker",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("created", models.DateTimeField(auto_now_add=True, null=True)),
                ("last_updated", models.DateTimeField(auto_now=True, null=True)),
                ("object_id", models.PositiveBigIntegerField(blank=True, null=True)),
                ("label", models.CharField(blank=True, max_length=100)),
                ("icon", models.CharField(blank=True, max_length=50)),
                ("color", utilities.fields.ColorField(blank=True, max_length=6)),
                ("x", models.FloatField(blank=True, null=True)),
                ("y", models.FloatField(blank=True, null=True)),
                ("label_offset", models.JSONField(blank=True, null=True)),
                (
                    "map",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="markers",
                        to="netbox_map.map",
                    ),
                ),
                (
                    "object_type",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to="contenttypes.contenttype",
                    ),
                ),
            ],
            options={
                "verbose_name": "marker",
                "verbose_name_plural": "markers",
                "ordering": ("map", "label", "pk"),
            },
            bases=(netbox.models.deletion.DeleteMixin, models.Model),
        ),
        migrations.CreateModel(
            name="MapOverlay",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("created", models.DateTimeField(auto_now_add=True, null=True)),
                ("last_updated", models.DateTimeField(auto_now=True, null=True)),
                ("name", models.CharField(max_length=100)),
                (
                    "image",
                    models.FileField(
                        max_length=255,
                        upload_to=netbox_map.models.overlay_upload_to,
                        validators=[netbox_map.images.validate_image],
                    ),
                ),
                ("image_width", models.PositiveIntegerField(default=0, editable=False)),
                (
                    "image_height",
                    models.PositiveIntegerField(default=0, editable=False),
                ),
                (
                    "opacity",
                    models.PositiveSmallIntegerField(
                        default=100,
                        validators=[
                            django.core.validators.MinValueValidator(0),
                            django.core.validators.MaxValueValidator(100),
                        ],
                    ),
                ),
                ("weight", models.PositiveSmallIntegerField(default=100)),
                ("x_min", models.FloatField(blank=True, null=True)),
                ("y_min", models.FloatField(blank=True, null=True)),
                ("x_max", models.FloatField(blank=True, null=True)),
                ("y_max", models.FloatField(blank=True, null=True)),
                (
                    "map",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="overlays",
                        to="netbox_map.map",
                    ),
                ),
            ],
            options={
                "verbose_name": "overlay",
                "verbose_name_plural": "overlays",
                "ordering": ("map", "weight", "name"),
            },
            bases=(netbox.models.deletion.DeleteMixin, models.Model),
        ),
        migrations.CreateModel(
            name="MapShape",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("created", models.DateTimeField(auto_now_add=True, null=True)),
                ("last_updated", models.DateTimeField(auto_now=True, null=True)),
                ("kind", models.CharField(max_length=20)),
                ("label", models.CharField(blank=True, max_length=100)),
                ("color", utilities.fields.ColorField(default="2196f3", max_length=6)),
                ("points", models.JSONField(default=list)),
                ("radius", models.FloatField(blank=True, null=True)),
                ("object_id", models.PositiveBigIntegerField(blank=True, null=True)),
                ("level", models.SmallIntegerField(default=0)),
                ("ends", models.JSONField(blank=True, default=dict)),
                ("smooth", models.JSONField(blank=True, default=list)),
                ("label_position", models.JSONField(blank=True, null=True)),
                (
                    "link",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="netbox_map.map",
                    ),
                ),
                (
                    "map",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="shapes",
                        to="netbox_map.map",
                    ),
                ),
                (
                    "object_type",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to=models.Q(
                            models.Q(
                                ("app_label", "dcim"),
                                ("model__in", ("cable", "cablebundle")),
                            ),
                            models.Q(("app_label", "circuits"), ("model", "circuit")),
                            _connector="OR",
                        ),
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="contenttypes.contenttype",
                    ),
                ),
            ],
            options={
                "verbose_name": "shape",
                "verbose_name_plural": "shapes",
                "ordering": ("map", "label", "pk"),
            },
            bases=(netbox.models.deletion.DeleteMixin, models.Model),
        ),
        migrations.AddIndex(
            model_name="map",
            index=models.Index(
                fields=["scope_type", "scope_id"], name="netbox_map__scope_t_820d19_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="mapmarker",
            index=models.Index(
                fields=["object_type", "object_id"],
                name="netbox_map__object__f81ced_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="mapmarker",
            constraint=models.UniqueConstraint(
                fields=("map", "object_type", "object_id"),
                name="netbox_map_marker_unique_object",
                violation_error_message="This object is already on the map.",
            ),
        ),
        migrations.AddConstraint(
            model_name="mapoverlay",
            constraint=models.UniqueConstraint(
                fields=("map", "name"), name="netbox_map_overlay_unique_name"
            ),
        ),
        migrations.AddIndex(
            model_name="mapshape",
            index=models.Index(
                fields=["object_type", "object_id"],
                name="netbox_map__object__b1be16_idx",
            ),
        ),
    ]
