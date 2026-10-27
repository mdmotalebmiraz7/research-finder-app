// Electron shell: starts the Python backend, waits until it answers, then opens the UI in a window.
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

let backend = null;
let win = null;
let port = 0;

const SPLASH = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#f7f8fa;color:#20232b;font-family:Segoe UI,sans-serif">
   <div style="text-align:center"><div style="width:46px;height:46px;margin:0 auto 16px;border-radius:12px;background:#5b55d9;color:#fff;font:800 26px/46px Segoe UI">R</div>
   <h2 style="margin:0 0 8px">Research Finder</h2><p style="margin:0;color:#5f6577">${html}</p></div></body>`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
  });
}

function ping(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

function startBackend(dataDir) {
  const env = {
    ...process.env,
    RF_PORT: String(port),
    RF_DATA_DIR: dataDir,
    HF_HOME: path.join(dataDir, 'models'),
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
  };
  let cmd, args, cwd;
  if (app.isPackaged) {
    env.RF_STATIC_DIR = path.join(process.resourcesPath, 'ui');
    cmd = path.join(process.resourcesPath, 'backend', 'backend.exe');
    args = [];
    cwd = path.dirname(cmd);
  } else { // development: `npm start` with Python deps installed and frontend built
    env.RF_STATIC_DIR = path.join(__dirname, '..', 'frontend', 'dist');
    cwd = path.join(__dirname, '..', 'backend');
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    args = ['desktop_main.py'];
  }
  const logFile = fs.createWriteStream(path.join(dataDir, 'backend.log'), { flags: 'a' });
  backend = spawn(cmd, args, { cwd, env, windowsHide: true });
  backend.stdout.pipe(logFile);
  backend.stderr.pipe(logFile);
  backend.on('error', err => { backend = null; fail(`Could not start the backend (${cmd}): ${err.message}`, dataDir); });
  backend.on('exit', code => { if (!app.isQuitting && code) fail(`The backend stopped (exit code ${code}).`, dataDir); backend = null; });
}

function fail(message, dataDir) {
  if (app.isQuitting) return;
  dialog.showErrorBox('Research Finder', `${message}\n\nLog file:\n${path.join(dataDir, 'backend.log')}`);
  app.quit();
}

function stopBackend() {
  if (!backend) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { windowsHide: true });
    else backend.kill('SIGTERM');
  } catch (_) { /* already gone */ }
  backend = null;
}

async function main() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#f7f8fa', autoHideMenuBar: true, title: 'Research Finder',
    webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadURL(SPLASH('Starting the backend…'));

  port = await freePort();
  startBackend(dataDir);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (!backend) return; // failed and reported
    if (await ping(`${base}/health`)) { win.loadURL(base); return; }
    await new Promise(r => setTimeout(r, 500));
  }
  fail('The backend did not start within 3 minutes.', dataDir);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', () => { app.isQuitting = true; stopBackend(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(main);
}
