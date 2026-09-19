import type { ForgeConfig } from '@electron-forge/shared-types';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new WebpackPlugin({
      // Sandboxed preload shares the renderer dev-server multi-compiler. Forge
      // defaults hot:true, which injects webpack-dev-server/HMR client into
      // every entry including preload — incompatible with sandbox=true.
      devServer: {
        hot: false,
        liveReload: false,
        client: false,
      },
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            name: 'main_window',
            html: './src/app-ui/index.html',
            js: './src/app-ui/renderer.tsx',
            preload: {
              js: './src/preload/app-preload.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
