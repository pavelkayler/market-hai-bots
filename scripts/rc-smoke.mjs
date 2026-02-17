import { spawn } from 'node:child_process';

const timeoutMs = Number.parseInt(process.env.RC_SMOKE_TIMEOUT_MS ?? '12000', 10);

const isWindows = process.platform === 'win32';

const startService = (name, command) => {
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk.toString()}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });

  child.on('error', (error) => {
    process.stderr.write(`[${name}] start failed: ${error.message}\n`);
  });

  return child;
};

const stopService = (name, child) => {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      process.stderr.write(`[${name}] force-killed after SIGTERM grace period\n`);
    }
  }, 1500);
};

const backend = startService('backend', 'npm --prefix backend run dev');
const frontend = startService('frontend', 'npm --prefix frontend run dev');

let exiting = false;

const shutdown = (code) => {
  if (exiting) {
    return;
  }
  exiting = true;
  stopService('backend', backend);
  stopService('frontend', frontend);
  setTimeout(() => process.exit(code), 1800);
};

const onEarlyExit = (name, code) => {
  if (exiting) {
    return;
  }
  if (code === 0 || code === null) {
    return;
  }
  process.stderr.write(`RC smoke failed: ${name} exited early with code ${code}\n`);
  shutdown(code);
};

backend.on('exit', (code) => onEarlyExit('backend', code));
frontend.on('exit', (code) => onEarlyExit('frontend', code));

process.stdout.write(`RC smoke: started backend + frontend; waiting ${timeoutMs}ms for sanity boot.\n`);

setTimeout(() => {
  process.stdout.write('RC smoke: timeout reached (expected). Stopping services cleanly.\n');
  shutdown(0);
}, timeoutMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`RC smoke: received ${signal}, shutting down.\n`);
    shutdown(0);
  });
}
