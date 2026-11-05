// Reproduces what Chrome does: starts the installed helper, sends "start", prints what comes back.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const home = os.homedir();
const dataDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'leetcode-capture-helper')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'leetcode-capture-helper');
const hostJs = path.join(dataDir, 'app', 'host.js');
console.log('host:', hostJs);

const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};
const child = spawn(process.execPath, [hostJs, 'chrome-extension://test/'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.on('error', (e) => console.log('SPAWN ERROR:', e.message));
child.on('exit', (c, s) => console.log('host exited', c, s));
child.stderr.on('data', (d) => console.log('host stderr:', String(d).trim()));
let buf = Buffer.alloc(0);
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0);
    console.log('host says:', buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
  }
});
child.stdin.write(frame({ type: 'ping', id: 1 }));
setTimeout(() => child.stdin.write(frame({ type: 'start', id: 2 })), 500);
setTimeout(async () => {
  try {
    const r = await fetch('http://127.0.0.1:8135/capture', { method: 'OPTIONS' });
    console.log('relay answers on 8135: status', r.status);
  } catch (e) {
    console.log('relay does NOT answer on 8135:', e.message);
  }
  child.stdin.end();
  setTimeout(() => process.exit(0), 3000);
}, 12000);
