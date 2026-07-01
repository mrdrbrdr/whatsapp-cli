import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const PORT = 37991;                       // not 3737 → never collides with the real daemon
const RO_PORT = 37992;                     // second daemon for read-only (default) coverage
const BASE = `http://127.0.0.1:${PORT}`;
let child, roChild;

const post = (base, body, headers = {}) =>
  fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

// Spawn a daemon on `port` and wait for its HTTP server. Empty auth dir → it never reaches "connected",
// but the API comes up. `allowSend` toggles WA_CLI_ALLOW_SEND (read-only is the default when unset).
async function spawnDaemon(port, allowSend) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  const env = { ...process.env, WA_CLI_DATA: dataDir, WA_CLI_PORT: String(port), WA_CLI_LOG: 'silent' };
  if (allowSend) env.WA_CLI_ALLOW_SEND = '1'; else delete env.WA_CLI_ALLOW_SEND;
  const c = spawn('node', [path.join(REPO, 'daemon.mjs')], { env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/status`); if (r.ok) return c; } catch {}
    if (Date.now() > deadline) throw new Error('daemon API did not come up on ' + port);
    await new Promise((r) => setTimeout(r, 200));
  }
}

before(async () => {
  // send-enabled daemon so the /send guard tests below can reach the guards
  child = await spawnDaemon(PORT, true);
  // read-only (default) daemon for the disabled-send test
  roChild = await spawnDaemon(RO_PORT, false);
});

after(() => { for (const c of [child, roChild]) if (c) c.kill('SIGKILL'); });

test('GET /status reports not connected (no live socket)', async () => {
  const j = await (await fetch(`${BASE}/status`)).json();
  assert.equal(j.connected, false);
});

test('read-only mode (default): POST /send → 403 disabled', async () => {
  const r = await post(`http://127.0.0.1:${RO_PORT}`, JSON.stringify({ to: 'me', message: 'x' }));
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.status, 'disabled');
  assert.equal(j.ok, false);
});

test('CSRF guard: POST with Origin header → 403', async () => {
  const r = await post(BASE, JSON.stringify({ to: 'me', message: 'x' }), { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('CSRF guard: POST with Referer header → 403', async () => {
  const r = await post(BASE, JSON.stringify({ to: 'me', message: 'x' }), { Referer: 'https://evil.example/x' });
  assert.equal(r.status, 403);
});

test('wrong Content-Type → 415', async () => {
  const r = await post(BASE, '{"to":"me","message":"x"}', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('valid request but not connected → 503', async () => {
  const r = await post(BASE, JSON.stringify({ to: 'me', message: 'x' }));
  assert.equal(r.status, 503);
});

test('oversized body → 413', async () => {
  const r = await post(BASE, JSON.stringify({ to: 'me', message: 'x'.repeat(70000) }));
  assert.equal(r.status, 413);
});

test('unknown route → 404', async () => {
  const r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
});
