import type { RuleSetRule } from 'webpack';

export const typescriptRule: RuleSetRule = {
  test: /\.tsx?$/,
  exclude: /(node_modules|\.webpack)/,
  use: {
    loader: 'ts-loader',
    options: {
      transpileOnly: true,
    },
  },
};

export const mainNativeModuleRules: RuleSetRule[] = [
  {
    test: /native_modules[/\\].+\.node$/,
    use: 'node-loader',
  },
  {
    test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
    parser: { amd: false },
    use: {
      loader: '@vercel/webpack-asset-relocator-loader',
      options: {
        outputAssetBase: 'native_modules',
      },
    },
  },
];

export const rendererCssRule: RuleSetRule = {
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
};

export function createMainRules(): RuleSetRule[] {
  return [...mainNativeModuleRules, typescriptRule];
}

export function createRendererRules(): RuleSetRule[] {
  return [typescriptRule, rendererCssRule];
}
