// A stand-in for `texturecraft --control <port>`, for tests: writes a fresh token file to the temp
// folder like the app does, then answers the control channel (JSON lines, `auth` first).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function startFakeApp(port, name) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(os.tmpdir(), `texturecraft-control-${port}.token`);
  fs.rmSync(tokenFile, { force: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let authed = false;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        const reply = (body) => socket.write(JSON.stringify({ id: req.id, ...body }) + '\n');
        if (!authed) {
          if (req.method === 'auth' && req.params && req.params.token === token) {
            authed = true;
            reply({ ok: true, result: null });
          } else {
            reply({ ok: false, error: 'unauthorized' });
            socket.destroy();
          }
          continue;
        }
        if (req.method === 'session.inspect') reply({ ok: true, result: { project: name, layers: 3 } });
        else if (req.method === 'ping') reply({ ok: true, result: 'pong' });
        else reply({ ok: true, result: { method: req.method, params: req.params } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        token,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      }),
    );
  });
}

module.exports = { startFakeApp };
