const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const harness = path.join(__dirname, '..', 'src', 'v2-acceptance', 'electron-observation-harness.ts');
const outfile = path.join(os.tmpdir(), `v2-electron-observation-${process.pid}.cjs`);
const esbuildBin = require.resolve('esbuild/bin/esbuild');

const bundled = spawnSync(
  process.execPath,
  [
    esbuildBin,
    harness,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    `--outfile=${outfile}`,
  ],
  { stdio: 'inherit' },
);

if (bundled.status !== 0) {
  process.exit(bundled.status ?? 1);
}

const child = spawn(electron, [outfile], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
  windowsHide: true,
});

child.on('exit', (code, signal) => {
  fs.rmSync(outfile, { force: true });
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
