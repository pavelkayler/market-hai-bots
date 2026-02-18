const baseUrl = process.env.RC_BASE_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const endpoint = `${baseUrl.replace(/\/$/, '')}/api/doctor`;

const main = async () => {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      process.stderr.write(`rc:doctor FAIL - HTTP ${response.status} from ${endpoint}\n`);
      process.exit(1);
      return;
    }

    const body = await response.json();
    const checks = Array.isArray(body.checks) ? body.checks : [];
    const hasFail = checks.some((check) => check?.status === 'FAIL');

    process.stdout.write(`Doctor overall ok: ${body.ok === true}\n`);
    for (const check of checks) {
      const status = typeof check?.status === 'string' ? check.status : 'WARN';
      const id = typeof check?.id === 'string' ? check.id : 'unknown';
      const message = typeof check?.message === 'string' ? check.message : '';
      process.stdout.write(`${status.padEnd(4)} ${id} - ${message}\n`);
    }

    if (hasFail) {
      process.exit(1);
      return;
    }

    process.exit(0);
  } catch (error) {
    process.stderr.write(`rc:doctor FAIL - cannot reach ${endpoint}: ${(error).message}\n`);
    process.exit(1);
  }
};

void main();
