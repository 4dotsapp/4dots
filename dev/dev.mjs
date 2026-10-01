// Runs 4dots locally: the Worker under `wrangler dev`, talking to an in-memory
// mock of the nimbo API, so local work never touches real storage.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockNimbo } from './mock-nimbo.mjs';

const mock = await startMockNimbo(Number(process.env.MOCK_PORT) || 0);
console.log(`mock nimbo listening on ${mock.url}`);
const child = spawn('npx', [
  'wrangler', 'dev',
  '--var', `NIMBO_BASE_URL:${mock.url}`,
  '--var', 'NIMBO_TOKEN:nimbo_mock',
  ...process.argv.slice(2),
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
child.on('exit', (code) => {
  mock.close();
  process.exit(code ?? 0);
});
