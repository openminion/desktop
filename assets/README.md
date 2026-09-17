# Desktop Brand Assets

`icon.png` is the polished OpenMinion transparent, unframed mark, adopted on
2026-09-17 from the shared artwork collection's
`openminion_logo_set_v4_unframed_transparent.png`. The 1254 by 1254 PNG is copied
unchanged, including its transparency. It is the source for the sidebar,
empty-chat mark, development Dock icon, and packaged application icons.

Source SHA-256: `c4ae3467e396c80d53f790c2da831d0da023fbbe76c4e618db3c91cdadf2ae13`.

The unframed variant retains the existing in-window presentation without adding
a rounded tile behind the mark. The shared artwork candidates remain separate
from Desktop; they are not bundled or overwritten.

`icon.icns` contains macOS icon sizes derived from that PNG with `sips` and
`iconutil`, without redrawing the artwork. Forge embeds it in the application
bundle. Representations cover 16, 32, 128, 256, and 512 logical pixels at 1x
and 2x. Every representation is downscaled from the master.

`icon.ico` contains PNG-backed Windows representations at 16, 24, 32, 48, 64,
128, and 256 pixels, downscaled with `sips` and stored in the ICO directory.
Linux packages use `icon.png` directly.

The build copies the PNG into the renderer's fixed local asset set. Do not
load branding from the network at runtime or package unrelated brand studies.
