const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const esbuildBin = require.resolve('esbuild/bin/esbuild');
const preloadOut = path.join(os.tmpdir(), `v7-electron-preload-${process.pid}.cjs`);

function cleanup() {
  fs.rmSync(preloadOut, { force: true });
}

const bundledPreload = spawnSync(
  process.execPath,
  [
    esbuildBin,
    path.join(__dirname, '..', 'src', 'preload', 'app-preload.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    `--outfile=${preloadOut}`,
  ],
  { stdio: 'inherit', windowsHide: true },
);

if (bundledPreload.error) {
  cleanup();
  throw bundledPreload.error;
}
if ((bundledPreload.status ?? 1) !== 0) {
  cleanup();
  process.exit(bundledPreload.status ?? 1);
}

process.env.V7_ACCEPTANCE_PRELOAD_PATH = preloadOut;

function runHarness() {
  return spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'bundle-and-run-electron.cjs'),
      path.join(__dirname, '..', 'src', 'v7-acceptance', 'electron-persistent-workflow-harness.ts'),
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
