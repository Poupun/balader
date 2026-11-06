#!/usr/bin/env node
// Drive the *running* desktop app (debug build) from the terminal.
// The app writes <data dir>/dev-bridge.json at start; this script reads it.
//
//   npm run bridge -- health
//   npm run bridge -- state                       # window.__balader.snapshot()
//   npm run bridge -- eval "return document.title"
//   npm run bridge -- deal https://youtu.be/...    # deal a link like a user
//   npm run bridge -- click grab                  # click [data-testid=grab]
//   npm run bridge -- wait "s.phase === 'dealt'" 60
//   npm run bridge -- events 20                   # last core events
//   npm run bridge -- snapshot out.png            # PNG of the webview (macOS)
//   npm run bridge -- reload

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ID = 'com.balader.desktop';

function dataDir() {
  if (process.env.BALADER_HOME) return join(process.env.BALADER_HOME, 'data');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', ID);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), ID);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), ID);
}

function bridge() {
  const file = join(dataDir(), 'dev-bridge.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`No dev bridge at ${file}. Start the debug app first (npm run app).`);
    process.exit(2);
  }
}

const { port, token } = bridge();
const base = `http://127.0.0.1:${port}`;

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-balader-token': token }, body });
  if ((res.headers.get('content-type') ?? '').includes('image/png')) return Buffer.from(await res.arrayBuffer());
  const json = await res.json();
  if (!json.ok) {
    console.error(json.error ?? json);
    process.exit(1);
  }
  return json.value ?? json;
}

const evalJs = (code, timeout = 30) => req('POST', `/eval?timeout=${timeout}`, code);
const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const [cmd = 'health', ...args] = process.argv.slice(2);

switch (cmd) {
  case 'health':
    print(await req('GET', '/health'));
    break;
  case 'state':
    print(await req('GET', '/state'));
    break;
  case 'eval':
    print(await evalJs(args.join(' ')));
    break;
  case 'deal':
    print(await evalJs(`await window.__balader.actions.deal(${JSON.stringify(args[0])}); return window.__balader.snapshot();`, 120));
    break;
  case 'click':
    print(await evalJs(`return window.__balader.dom.click(${JSON.stringify(args[0])});`));
    break;
  case 'wait': {
    const timeout = Number(args[1] ?? 60);
    print(await evalJs(`return await window.__balader.until((s) => (${args[0]}), ${timeout * 1000});`, timeout + 5));
    break;
  }
  case 'events':
    print(await req('GET', `/events?n=${Number(args[0] ?? 20)}`));
    break;
  case 'snapshot': {
    const png = await req('GET', '/snapshot');
    const out = args[0] ?? 'balader-snapshot.png';
    writeFileSync(out, png);
    console.log(`saved ${out} (${png.length} bytes)`);
    break;
  }
  case 'reload':
    print(await req('POST', '/reload'));
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(64);
}
