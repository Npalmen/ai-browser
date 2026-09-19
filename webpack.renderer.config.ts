import type { Configuration } from 'webpack';

import { createRendererRules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const rendererConfig: Configuration = {
  // Forge dev defaults use eval-based source maps, but the trusted UI HTML meta
  // CSP allows only script-src 'self'. source-map keeps dev bundles CSP-safe.
  devtool: 'source-map',
  module: {
    rules: createRendererRules(),
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.tsx', '.css'],
  },
};
