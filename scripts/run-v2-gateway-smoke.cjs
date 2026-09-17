const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(
  process.execPath,
  [
    path.join(__dirname, 'bundle-and-run-electron.cjs'),
    path.join(__dirname, '..', 'src', 'v2-live', 'gateway-smoke-harness.ts'),
  ],
  { stdio: 'inherit', windowsHide: true },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
