const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(
  process.execPath,
  [
    path.join(__dirname, 'bundle-and-run-electron.cjs'),
    path.join(__dirname, '..', 'src', 'v3-acceptance', 'electron-interaction-harness.ts'),
  ],
  { stdio: 'inherit', windowsHide: true },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
