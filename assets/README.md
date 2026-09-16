# Desktop Brand Assets

`icon.png` is the unchanged OpenMinion logo used by the main OpenMinion README,
published at [OpenMinion's brand asset](https://www.openminion.com/brand/openminion-logo.png).
It is the source for the in-window mark and development Dock icon.

`icon.icns` contains macOS icon sizes derived from that PNG with `sips` and
`iconutil`, without redrawing the artwork. Forge embeds it in the application
bundle. The source image is 279 by 279 pixels; larger icon representations
are scaled exports, not higher-detail masters.

`icon.ico` contains the same unchanged mark as a 256 by 256 PNG-backed Windows
icon. Linux packages use `icon.png` directly.

The build copies the PNG into the renderer's fixed local asset set. Do not
load branding from the network at runtime or package unrelated brand studies.
