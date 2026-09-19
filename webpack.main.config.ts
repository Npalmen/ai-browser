import type { Configuration } from 'webpack';

import { createMainRules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
  entry: './src/main/main.ts',
  module: {
    rules: createMainRules(),
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.json'],
  },
};
