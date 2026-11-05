from django.utils.translation import gettext_lazy as _

from netbox.plugins import PluginMenu, PluginMenuButton, PluginMenuItem


def _item(model, text, add=True):
    """A menu entry for one of the plugin's lists, with an Add button."""
    buttons = ()
    if add:
        buttons = (
            PluginMenuButton(
                link=f'plugins:netbox_map:{model}_add',
                title=_('Add'),
                icon_class='mdi mdi-plus-thick',
                permissions=[f'netbox_map.add_{model}'],
            ),
        )
    return PluginMenuItem(
        link=f'plugins:netbox_map:{model}_list',
        link_text=text,
        permissions=[f'netbox_map.view_{model}'],
        buttons=buttons,
    )


# Its own tab in the navigation bar, like "Organization" or "IPAM".
menu = PluginMenu(
    label=_('Maps'),
    icon_class='mdi mdi-map-outline',
    groups=(
        (_('Maps'), (
            _item('map', _('Maps')),
        )),
        (_('Map Contents'), (
            _item('mapmarker', _('Markers')),
            _item('mapoverlay', _('Overlays')),
            _item('mapshape', _('Shapes'), add=False),  # drawn on the map
        )),
    ),
)
