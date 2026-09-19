const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const esbuildBin = require.resolve('esbuild/bin/esbuild');
const root = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `v8-electron-${process.pid}-`));
const preloadOut = path.join(tmpRoot, 'preload.cjs');
const rendererOut = path.join(tmpRoot, 'renderer.js');
const htmlOut = path.join(tmpRoot, 'index.html');
const stylesOut = path.join(tmpRoot, 'styles.css');

function cleanup() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function bundle(args) {
  return spawnSync(process.execPath, [esbuildBin, ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
}

fs.copyFileSync(path.join(root, 'src', 'app-ui', 'styles.css'), stylesOut);
fs.writeFileSync(
  htmlOut,
  `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" />
    <title>AI Browser</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./renderer.js"></script>
  </body>
</html>
`,
  'utf8',
);

const bundledPreload = bundle([
  path.join(root, 'src', 'preload', 'app-preload.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--external:electron',
  `--outfile=${preloadOut}`,
]);
if (bundledPreload.error) {
  cleanup();
  throw bundledPreload.error;
}
if ((bundledPreload.status ?? 1) !== 0) {
  cleanup();
  process.exit(bundledPreload.status ?? 1);
}

const bundledRenderer = bundle([
  path.join(root, 'src', 'v8-acceptance', 'renderer-entry.tsx'),
  '--bundle',
  '--platform=browser',
  '--format=iife',
  '--jsx=automatic',
  `--outfile=${rendererOut}`,
]);
if (bundledRenderer.error) {
  cleanup();
  throw bundledRenderer.error;
}
if ((bundledRenderer.status ?? 1) !== 0) {
  cleanup();
  process.exit(bundledRenderer.status ?? 1);
}

process.env.V8_ACCEPTANCE_PRELOAD_PATH = preloadOut;
process.env.V8_ACCEPTANCE_APP_UI_HTML = htmlOut;

function runHarness() {
  return spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'bundle-and-run-electron.cjs'),
      path.join(__dirname, '..', 'src', 'v8-acceptance', 'electron-ai-native-harness.ts'),
    ],
    { stdio: 'inherit', windowsHide: true, env: process.env },
  );
}

const result = runHarness();
cleanup();

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
