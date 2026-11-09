// End-to-end test: the launcher + the real texturecraft-cli + a fake TextureCraft app.
//
//   TEXTURECRAFT_CLI=/path/to/texturecraft-cli node test/run.js
//
// Checks that Claude can be opened before TextureCraft, and that the bridge reconnects when
// TextureCraft is restarted (new token). Also checks the "CLI not found" answer.
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { startFakeApp } = require('./fake-app');

const PORT = 47878;
const LAUNCHER = path.join(__dirname, '..', 'server', 'index.js');

// A tiny MCP client over the launcher's stdio.
function client(env) {
  const proc = spawn(process.execPath, [LAUNCHER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const pending = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out\n${stderr}`)), 20000);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const init = async () => {
    const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    notify('notifications/initialized');
    return r;
  };
  const close = () => new Promise((done) => { proc.on('exit', done); proc.stdin.end(); });
  return { request, init, close, stderr: () => stderr };
}

const text = (r) => (r.result.content || []).map((c) => c.text || '').join('\n');

async function main() {
  const cli = process.env.TEXTURECRAFT_CLI;
  assert.ok(cli && fs.existsSync(cli), 'set TEXTURECRAFT_CLI to a built texturecraft-cli');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ext-test-'));
  process.env.TMPDIR = tmp; // the fake app, the CLI and the launcher share this temp folder
  const env = { TEXTURECRAFT_CLI: cli, TEXTURECRAFT_PORT: String(PORT), TMPDIR: tmp, TEXTURECRAFT_CONTROL_TOKEN: '' };
  delete process.env.TEXTURECRAFT_CONTROL_TOKEN;

  // 1. Claude first, TextureCraft not running yet.
  const c = client(env);
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, 'texturecraft');
  const tools = (await c.request('tools/list', {})).result.tools.map((t) => t.name);
  for (const t of ['session_inspect', 'command_run', 'viewport_screenshot', 'ui_menu_invoke']) assert.ok(tools.includes(t), `tool ${t}`);
  let r = await c.request('tools/call', { name: 'session_inspect', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(text(r), /--control/);
  console.log('ok 1 - before TextureCraft runs: tools listed, calls say to start it');

  // 2. TextureCraft starts afterwards.
  let app = await startFakeApp(PORT, 'first run');
  r = await c.request('tools/call', { name: 'session_inspect', arguments: {} });
  assert.notEqual(r.result.isError, true, text(r));
  assert.match(text(r), /first run/);
  console.log('ok 2 - TextureCraft started after Claude: connected');

  // 3. TextureCraft restarts with a new token.
  await app.close();
  app = await startFakeApp(PORT, 'second run');
  r = await c.request('tools/call', { name: 'command_run', arguments: { id: 'layer.add.fill', params: { color: '#336699' } } });
  assert.notEqual(r.result.isError, true, text(r));
  assert.match(text(r), /layer\.add\.fill/);
  r = await c.request('tools/call', { name: 'session_inspect', arguments: {} });
  assert.match(text(r), /second run/);
  console.log('ok 3 - TextureCraft restarted: reconnected with the new token');

  // 4. Same token again: no reconnect.
  const before = c.stderr().split('reconnecting').length;
  await c.request('tools/call', { name: 'session_inspect', arguments: {} });
  assert.equal(c.stderr().split('reconnecting').length, before);
  console.log('ok 4 - unchanged token: the bridge is kept');
  await c.close();
  await app.close();

  // 5. TextureCraft already running when Claude starts.
  app = await startFakeApp(PORT, 'already open');
  const c2 = client(env);
  await c2.init();
  r = await c2.request('tools/call', { name: 'session_inspect', arguments: {} });
  assert.match(text(r), /already open/);
  assert.ok(!c2.stderr().includes('reconnecting'));
  console.log('ok 5 - TextureCraft opened first: connected without a restart');
  await c2.close();
  await app.close();

  // 6. Quoted "Copy as path" input and the app picked instead of the CLI.
  const appPath = path.join(path.dirname(cli), process.platform === 'win32' ? 'texturecraft.exe' : 'texturecraft');
  const c3 = client({ ...env, TEXTURECRAFT_CLI: `"${appPath}"` });
  await c3.init();
  assert.match(c3.stderr(), new RegExp(`using ${cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  console.log('ok 6 - a quoted path to the app resolves to the CLI next to it');
  await c3.close();

  // 7. CLI missing: one tool that says what to fix.
  const c4 = client({ ...env, TEXTURECRAFT_CLI: path.join(tmp, 'nope', 'texturecraft-cli'), PATH: '' });
  const i4 = await c4.init();
  assert.match(i4.result.instructions, /not found/);
  const t4 = (await c4.request('tools/list', {})).result.tools;
  assert.deepEqual(t4.map((t) => t.name), ['texturecraft_setup_problem']);
  r = await c4.request('tools/call', { name: 'texturecraft_setup_problem', arguments: {} });
  assert.match(text(r), /Extensions/);
  console.log('ok 7 - CLI not found: Claude gets an explanation instead of a dead server');
  await c4.close();

  // 8. Unset user_config placeholders are treated as empty (auto-detect, default port).
  const c5 = client({ ...env, TEXTURECRAFT_CLI: '${user_config.texturecraft_cli}', TEXTURECRAFT_PORT: '${user_config.port}', PATH: `${path.dirname(cli)}${path.delimiter}${process.env.PATH}` });
  await c5.init();
  assert.match(c5.stderr(), /control port 7878/);
  assert.match(c5.stderr(), /using .*texturecraft-cli/);
  console.log('ok 8 - empty settings: CLI found on PATH, port 7878');
  await c5.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('all tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
