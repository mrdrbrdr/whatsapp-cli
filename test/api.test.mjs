import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const PORT = 37991;                       // not 3737 → never collides with the real daemon
const BASE = `http://127.0.0.1:${PORT}`;
let child;

const post = (body, headers = {}) =>
  fetch(`${BASE}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  // empty auth dir → the daemon's HTTP server comes up but it never reaches "connected"
  child = spawn('node', [path.join(REPO, 'daemon.mjs')], {
    env: { ...process.env, WA_CLI_DATA: dataDir, WA_CLI_PORT: String(PORT), WA_CLI_LOG: 'silent' },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const r = await fetch(`${BASE}/status`); if (r.ok) return; } catch {}
    if (Date.now() > deadline) throw new Error('daemon API did not come up');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => { if (child) child.kill('SIGKILL'); });

test('GET /status reports not connected (no live socket)', async () => {
  const j = await (await fetch(`${BASE}/status`)).json();
  assert.equal(j.connected, false);
});

test('CSRF guard: POST with Origin header → 403', async () => {
  const r = await post(JSON.stringify({ to: 'me', message: 'x' }), { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('CSRF guard: POST with Referer header → 403', async () => {
  const r = await post(JSON.stringify({ to: 'me', message: 'x' }), { Referer: 'https://evil.example/x' });
  assert.equal(r.status, 403);
});

test('wrong Content-Type → 415', async () => {
  const r = await post('{"to":"me","message":"x"}', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('valid request but not connected → 503', async () => {
  const r = await post(JSON.stringify({ to: 'me', message: 'x' }));
  assert.equal(r.status, 503);
});

test('oversized body → 413', async () => {
  const r = await post(JSON.stringify({ to: 'me', message: 'x'.repeat(70000) }));
  assert.equal(r.status, 413);
});

test('unknown route → 404', async () => {
  const r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
});
