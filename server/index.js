#!/usr/bin/env node
// TextureCraft for Claude: launcher.
//
// Runs TextureCraft's own MCP server (`texturecraft-cli mcp --bridge <port>`) between Claude and
// the TextureCraft app you have open, and keeps it connected:
//
//   * It finds texturecraft-cli by itself (or uses the path you chose in the extension settings).
//   * The bridge reads TextureCraft's control token only when it starts, and TextureCraft writes a
//     new token every time it opens. So before each request the launcher checks the token, and
//     when TextureCraft has been (re)started since, it restarts the bridge with the new one and
//     replays the MCP handshake. Claude can be opened before or after TextureCraft.
//   * When texturecraft-cli cannot be found it still answers Claude, with one tool that explains
//     what to fix, instead of failing silently.
//
// No dependencies: Node.js built-ins only. MIT licence, see LICENSE.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const IS_WIN = process.platform === 'win32';
const CLI_NAME = IS_WIN ? 'texturecraft-cli.exe' : 'texturecraft-cli';
const APP_NAMES = IS_WIN ? ['texturecraft.exe'] : ['texturecraft'];
const DEFAULT_PORT = 7878;
// Lets the bridge start before TextureCraft has written a token: tool calls then say the app
// isn't running, which is the right message. (The CLI wants 16 to 1024 printable characters.)
const PLACEHOLDER_TOKEN = 'texturecraft-is-not-running-yet';
const REINIT_PREFIX = 'texturecraft-launcher-reinit-';
const REINIT_TIMEOUT_MS = 15000;

function log(msg) {
  process.stderr.write(`[texturecraft-launcher] ${msg}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---- settings -----------------------------------------------------------------------------------

// A user_config value, or '' when it was left empty (the host then passes `${user_config.x}`
// through unchanged).
function setting(name) {
  const v = (process.env[name] || '').trim();
  if (!v || v.includes('${')) return '';
  return v.replace(/^"(.*)"$/, '$1').trim(); // Windows "Copy as path" adds quotes
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function port() {
  const p = Number.parseInt(setting('TEXTURECRAFT_PORT'), 10);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
}

// Where texturecraft-cli usually is, most likely first.
function defaultLocations() {
  const env = process.env;
  const list = [];
  if (IS_WIN) {
    const bases = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']];
    if (env.LOCALAPPDATA) bases.push(path.join(env.LOCALAPPDATA, 'Programs'));
    // <base>\TextureCraft today; the other Craft apps already install to <base>\ArtCraft\<App>.
    for (const base of bases) {
      if (!base) continue;
      list.push(path.join(base, 'TextureCraft', CLI_NAME), path.join(base, 'ArtCraft', 'TextureCraft', CLI_NAME));
    }
  } else {
    list.push('/usr/bin/texturecraft-cli', '/usr/local/bin/texturecraft-cli', '/opt/homebrew/bin/texturecraft-cli');
    if (env.HOME) {
      list.push(
        path.join(env.HOME, '.local', 'bin', 'texturecraft-cli'),
        // the ArtCraft Launcher's Flatpak data folder on Linux
        path.join(env.HOME, '.var', 'app', 'ai.storyteller.artcraft-launcher', 'data', 'artcraft-launcher', 'apps', 'texturecraft', 'bin', 'texturecraft-cli'),
      );
    }
  }
  for (const dir of (env.PATH || '').split(path.delimiter)) if (dir) list.push(path.join(dir, CLI_NAME));
  return list;
}

// The chosen path may be the CLI, the TextureCraft app next to it, or their folder.
function cliFromChoice(choice) {
  if (isDir(choice)) return path.join(choice, CLI_NAME);
  if (APP_NAMES.includes(path.basename(choice).toLowerCase())) return path.join(path.dirname(choice), CLI_NAME);
  return choice;
}

// { cli } when found, else { problem } saying what to fix.
function findCli() {
  const chosen = setting('TEXTURECRAFT_CLI');
  if (chosen) {
    const cli = cliFromChoice(chosen);
    if (isFile(cli)) return { cli };
    log(`the chosen path ${chosen} has no ${CLI_NAME}; looking in the usual places`);
  }
  for (const cli of defaultLocations()) if (isFile(cli)) return { cli };
  const where = chosen ? `at the chosen path (${chosen}) or in the usual places` : 'in the usual places';
  return {
    problem:
      `TextureCraft's ${CLI_NAME} was not found ${where}. Install TextureCraft (getartcraft.com), ` +
      `or open Claude's Settings > Desktop app > Extensions > TextureCraft and choose ${CLI_NAME} ` +
      `in your TextureCraft folder, then turn the extension off and on again.`,
  };
}

// ---- the control token ---------------------------------------------------------------------------

// TextureCraft writes <temp>/texturecraft-control-<port>.token when it starts with --control.
// Windows has TMP and TEMP (usually the same folder): take the newest file of the candidates.
function tokenFiles(p) {
  const dirs = new Set([os.tmpdir()]);
  if (IS_WIN) for (const v of [process.env.TMP, process.env.TEMP]) if (v) dirs.add(v);
  return [...dirs].map((d) => path.join(d, `texturecraft-control-${p}.token`));
}

function currentToken(p) {
  const fromEnv = (process.env.TEXTURECRAFT_CONTROL_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  let best = null;
  for (const file of tokenFiles(p)) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 4096) continue;
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token.length >= 16 && (!best || stat.mtimeMs > best.mtimeMs)) best = { token, mtimeMs: stat.mtimeMs };
    } catch {
      // not there (TextureCraft hasn't run with --control yet) or unreadable
    }
  }
  return best ? best.token : PLACEHOLDER_TOKEN;
}

// ---- fallback server when the CLI is missing -----------------------------------------------------

function serveProblem(problem) {
  log(problem);
  const tool = {
    name: 'texturecraft_setup_problem',
    description: 'TextureCraft is not set up yet. Call this to see what to fix.',
    inputSchema: { type: 'object', properties: {} },
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.id === null || !msg.method) return; // notifications, replies
    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'texturecraft', version: '0' },
          instructions: problem,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [tool] });
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: problem }], isError: true });
      default:
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: problem } });
    }
  });
  rl.on('close', () => process.exit(0));
}

// ---- the bridge ----------------------------------------------------------------------------------

function serveBridge(cli, p) {
  let child = null;
  let childToken = null;
  let initRequest = null; // Claude's `initialize`, replayed to every new bridge process
  let initialized = false; // whether Claude has sent `notifications/initialized`
  let reinitCount = 0;
  const waiting = new Map(); // reinit id -> resolve
  let closing = false;

  function start(token) {
    const c = spawn(cli, ['mcp', '--bridge', String(p)], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      // The token goes in the environment, not on the command line, so other processes can't read it.
      env: { ...process.env, TEXTURECRAFT_CONTROL_TOKEN: token },
    });
    child = c;
    childToken = token;
    c.stdin.on('error', () => {}); // a bridge that already exited
    readline.createInterface({ input: c.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (c !== child) return; // output of a bridge that was replaced
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* not ours to judge: pass it on */ }
      if (msg && typeof msg.id === 'string' && waiting.has(msg.id)) {
        waiting.get(msg.id)();
        waiting.delete(msg.id);
        return;
      }
      process.stdout.write(line + '\n');
    });
    c.on('error', (e) => {
      log(`cannot start ${cli}: ${e.message}`);
      if (c === child) child = null;
    });
    c.on('exit', (code, signal) => {
      if (c === child) {
        child = null;
        if (!closing) log(`the bridge stopped (${signal || `exit code ${code}`}); it restarts on the next request`);
      }
    });
    return c;
  }

  function stop(c) {
    try { c.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { try { c.kill(); } catch { /* already gone */ } }, 500).unref();
  }

  // A bridge holding TextureCraft's current token, with Claude's handshake replayed.
  async function freshBridge() {
    const token = currentToken(p);
    if (child && token === childToken) return;
    if (child) {
      log('TextureCraft was started or restarted: reconnecting');
      const old = child;
      child = null;
      stop(old);
    }
    const c = start(token);
    if (!initRequest) return;
    const id = REINIT_PREFIX + ++reinitCount;
    const replied = new Promise((resolve) => {
      waiting.set(id, resolve);
      setTimeout(() => { if (waiting.delete(id)) { log('the bridge did not answer the handshake in time'); resolve(); } }, REINIT_TIMEOUT_MS).unref();
    });
    c.stdin.write(JSON.stringify({ ...initRequest, id }) + '\n');
    await replied;
    if (initialized && c === child) c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async function handle(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { /* pass it on as is */ }
    const isRequest = msg && msg.method && msg.id !== undefined && msg.id !== null;
    if (msg && msg.method === 'initialize') {
      initRequest = msg;
      if (!child) start(currentToken(p));
    } else {
      if (msg && msg.method === 'notifications/initialized') initialized = true;
      if (isRequest || !child) await freshBridge();
    }
    if (child) {
      child.stdin.write(line + '\n');
    } else if (isRequest) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `could not start ${cli}` } });
    }
  }

  // Claude's messages, one at a time and in order.
  let queue = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(() => handle(line)).catch((e) => log(`error: ${e && e.message}`));
  });
  input.on('close', () => {
    closing = true;
    queue.finally(() => {
      if (child) stop(child);
      setTimeout(() => process.exit(0), 600).unref();
    });
  });

  process.on('exit', () => {
    if (child) try { child.kill(); } catch { /* already gone */ }
  });

  start(currentToken(p));
}

// ---- main ----------------------------------------------------------------------------------------

function main() {
  const p = port();
  const found = findCli();
  if (found.problem) return serveProblem(found.problem);
  log(`using ${found.cli}, TextureCraft control port ${p}`);
  serveBridge(found.cli, p);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
main();
