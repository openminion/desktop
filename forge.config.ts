import type { ForgeConfig } from "@electron-forge/shared-types";

const packageIcon =
  process.platform === "darwin"
    ? "assets/icon.icns"
    : process.platform === "win32"
      ? "assets/icon.ico"
      : "assets/icon.png";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "OpenMinion",
    icon: packageIcon,
    // Keep local state and repository-only files outside the distributed archive.
    ignore: [/^\/(?!dist(?:\/|$)|package\.json$|LICENSE$|NOTICE$).+/],
    name: "OpenMinion",
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"],
      config: {},
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          homepage: "https://www.openminion.com",
          maintainer: "OpenMinion Contributors",
        },
      },
    },
  ],
};

export default config;
