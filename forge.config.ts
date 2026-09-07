import type { ForgeConfig } from "@electron-forge/shared-types";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "OpenMinion",
    // Keep local state and repository-only files outside the distributed archive.
    ignore: [/^\/(?!dist(?:\/|$)|package\.json$|LICENSE$|NOTICE$).+/],
    name: "OpenMinion",
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {},
    },
  ],
};

export default config;
