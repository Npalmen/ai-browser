const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runHarness() {
  return spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'bundle-and-run-electron.cjs'),
      path.join(__dirname, '..', 'src', 'v6-acceptance', 'electron-autonomous-task-harness.ts'),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}

let result = runHarness();
if (result.error) {
  throw result.error;
}

for (let attempt = 0; attempt < 3 && (result.status ?? 1) !== 0; attempt += 1) {
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  result = runHarness();
  if (result.error) {
    throw result.error;
  }
}

process.exit(result.status ?? 1);
