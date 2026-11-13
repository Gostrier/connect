import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const api = spawn(npm, ['run', 'dev:api'], { stdio: 'inherit' });
let web;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  web?.kill('SIGTERM');
  api.kill('SIGTERM');
  process.exitCode = code;
}

function canConnectToApi() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 3001 });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

api.once('error', (error) => {
  console.error('Could not start the API server:', error.message);
  stop(1);
});
api.once('exit', (code) => {
  if (!stopping) {
    console.error(`The API server exited before Vite could start${code === null ? '.' : ` (code ${code}).`}`);
    stop(code ?? 1);
  }
});

for (let attempt = 0; attempt < 120; attempt += 1) {
  if (await canConnectToApi()) break;
  if (api.exitCode !== null) process.exit(1);
  if (attempt === 119) {
    console.error('The API server did not become ready on port 3001.');
    stop(1);
    process.exit(1);
  }
  await delay(250);
}

if (!stopping) {
  console.log('API is ready; starting Vite.');
  web = spawn(npm, ['run', 'dev:web'], { stdio: 'inherit' });
  web.once('error', (error) => {
    console.error('Could not start Vite:', error.message);
    stop(1);
  });
  web.once('exit', (code) => stop(code ?? 0));
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
