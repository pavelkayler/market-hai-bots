const baseUrl = process.env.RC_BASE_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const apiBase = baseUrl.replace(/\/$/, '');

const endpoints = {
  doctor: `${apiBase}/api/doctor`,
  state: `${apiBase}/api/bot/state`,
  runs: `${apiBase}/api/runs/summary?limit=5`
};

const stableDoctorIds = [
  'ws_freshness',
  'market_age_per_symbol',
  'run_recording_status',
  'filesystem_writable',
  'lifecycle_invariants',
  'universe_contract_filter'
];

const printHeader = (title) => {
  process.stdout.write(`\n=== ${title} ===\n`);
};

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
};

const compactRunLine = (run) => {
  const mode = run?.mode ?? 'unknown';
  const tf = run?.tf ?? 'n/a';
  const direction = run?.direction ?? 'n/a';
  const trades = Number.isFinite(run?.trades) ? run.trades : 0;
  const pnlUSDT = Number.isFinite(run?.pnlUSDT) ? run.pnlUSDT : 0;
  const startedAt = typeof run?.startedAt === 'number' ? new Date(run.startedAt).toISOString() : 'n/a';
  return `${run?.id ?? 'unknown'} | mode=${mode} tf=${tf} direction=${direction} trades=${trades} pnlUSDT=${pnlUSDT} startedAt=${startedAt}`;
};

const main = async () => {
  let exitCode = 0;

  try {
    printHeader('RC E2E report (non-destructive)');
    process.stdout.write(`Base URL: ${apiBase}\n`);

    printHeader('1) Doctor checks');
    const doctor = await fetchJson(endpoints.doctor);
    const checks = Array.isArray(doctor?.checks) ? doctor.checks : [];

    if (!Array.isArray(doctor?.checks)) {
      throw new Error('/api/doctor payload missing checks[]');
    }

    const foundIds = new Set();
    let hasFail = false;
    for (const check of checks) {
      const status = typeof check?.status === 'string' ? check.status : 'WARN';
      const id = typeof check?.id === 'string' ? check.id : 'unknown';
      const message = typeof check?.message === 'string' ? check.message : '';
      foundIds.add(id);
      if (status === 'FAIL') {
        hasFail = true;
      }
      process.stdout.write(`${status.padEnd(4)} ${id} - ${message}\n`);
    }

    for (const stableId of stableDoctorIds) {
      if (!foundIds.has(stableId)) {
        process.stdout.write(`WARN missing_doctor_check_id - expected stable id '${stableId}'\n`);
      }
    }

    if (hasFail) {
      process.stdout.write('Doctor status: FAIL present -> stop RC flow until resolved.\n');
      exitCode = 1;
    } else {
      process.stdout.write('Doctor status: no FAIL checks.\n');
    }

    printHeader('2) Bot state invariants snapshot');
    const state = await fetchJson(endpoints.state);
    process.stdout.write(`phase=${state.running ? (state.paused ? 'PAUSED' : 'RUNNING') : 'STOPPED'}\n`);
    process.stdout.write(`mode=${state.mode ?? 'null'} direction=${state.direction ?? 'null'} tf=${state.tf ?? 'null'}\n`);
    process.stdout.write(`activeOrders=${Number(state.activeOrders ?? 0)} openPositions=${Number(state.openPositions ?? 0)} queueDepth=${Number(state.queueDepth ?? 0)} journalAgeMs=${Number(state.journalAgeMs ?? 0)}\n`);

    printHeader('3) Last 5 runs summary');
    const summary = await fetchJson(endpoints.runs);
    const runs = Array.isArray(summary?.runs) ? summary.runs : [];
    if (runs.length === 0) {
      process.stdout.write('No runs found.\n');
    } else {
      for (const run of runs) {
        process.stdout.write(`- ${compactRunLine(run)}\n`);
      }
    }

    if (runs.length > 0 && typeof runs[0]?.id === 'string' && runs[0].id.length > 0) {
      const runId = runs[0].id;
      printHeader(`4) Last 10 SYSTEM events for latest run (${runId})`);
      const eventsPayload = await fetchJson(`${apiBase}/api/runs/${encodeURIComponent(runId)}/events?limit=50&types=SYSTEM`);
      const events = Array.isArray(eventsPayload?.events) ? eventsPayload.events : [];
      for (const event of events.slice(0, 10)) {
        const ts = typeof event?.ts === 'number' ? new Date(event.ts).toISOString() : 'n/a';
        process.stdout.write(`- ${ts} ${event?.type ?? 'unknown'} ${event?.event ?? 'unknown'}\n`);
      }
      if (events.length === 0) {
        process.stdout.write('No SYSTEM events found for latest run.\n');
      }
      if (Array.isArray(eventsPayload?.warnings) && eventsPayload.warnings.length > 0) {
        process.stdout.write(`Warnings: ${eventsPayload.warnings.join('; ')}\n`);
      }
    }

    printHeader('Manual steps remaining');
    process.stdout.write('- Follow docs/RC_E2E_V1.md sections 5-13 for paper/demo execution and operator confirmations.\n');
    process.stdout.write('- This script does not place orders or mutate runtime state.\n');
    process.stdout.write(`- Re-run this script anytime: npm run rc:e2e (override URL via RC_BASE_URL).\n`);
  } catch (error) {
    process.stderr.write(`rc:e2e FAIL - ${(error).message}\n`);
    process.exit(1);
    return;
  }

  process.exit(exitCode);
};

void main();
