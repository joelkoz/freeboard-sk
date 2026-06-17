// Wrapper for 'ng build' that exits cleanly after completion.
// Angular CLI 21 on macOS hangs post-build because the esbuild context is never
// disposed. The build output IS written before the hang, so we watch stdout for
// the final "Output location:" line and force exit 1 second later.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ng = spawn('node', ['node_modules/.bin/ng', 'build', ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
  cwd: process.cwd(),
});

let exitTimer;

function scheduledExit() {
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    ng.kill('SIGTERM');
    process.exit(0);
  }, 1000);
}

createInterface({ input: ng.stdout }).on('line', (line) => {
  process.stdout.write(line + '\n');
  if (line.startsWith('Output location:')) scheduledExit();
});

createInterface({ input: ng.stderr }).on('line', (line) => {
  process.stderr.write(line + '\n');
});

ng.on('close', (code) => {
  clearTimeout(exitTimer);
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  ng.kill('SIGINT');
  process.exit(130);
});
