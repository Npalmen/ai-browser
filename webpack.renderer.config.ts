import type { Configuration } from 'webpack';

import { createRendererRules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const rendererConfig: Configuration = {
  module: {
    rules: createRendererRules(),
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.tsx', '.css'],
  },
};
