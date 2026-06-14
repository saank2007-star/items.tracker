const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { google } = require('googleapis');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
let oAuth2Client = null;
let driveFileId = null;

function tokenPath() { return path.join(app.getPath('userData'), 'google-token.json'); }
function fileIdPath() { return path.join(app.getPath('userData'), 'drive-file-id.txt'); }

function readToken() {
  try {
    const p = tokenPath();
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  } catch { return null; }
}

function writeToken(tokens) {
  try { fs.writeFileSync(tokenPath(), JSON.stringify(tokens)); } catch(e) { console.error(e); }
}

function buildOAuthClient() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8')).installed;
  return new google.auth.OAuth2(creds.client_id, creds.client_secret);
}

async function initAuth() {
  const token = readToken();
  if (!token) return false;
  oAuth2Client = buildOAuthClient();
  oAuth2Client.setCredentials(token);
  oAuth2Client.on('tokens', (t) => writeToken({ ...(readToken() || {}), ...t }));
  const fip = fileIdPath();
  if (fs.existsSync(fip)) driveFileId = fs.readFileSync(fip, 'utf8').trim();
  return true;
}

async function doSignIn() {
  const client = buildOAuthClient();
  return new Promise((resolve, reject) => {
    let port;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      if (!code) { res.end(''); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#0f1115;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:1.2rem"><p>✓ Signed in! You can close this tab.</p></body></html>');
      server.close();
      try {
        const { tokens } = await client.getToken({ code, redirect_uri: `http://localhost:${port}` });
        client.setCredentials(tokens);
        writeToken(tokens);
        client.on('tokens', (t) => writeToken({ ...(readToken() || {}), ...t }));
        oAuth2Client = client;
        resolve(true);
      } catch(e) { reject(e); }
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        redirect_uri: `http://localhost:${port}`,
      });
      shell.openExternal(authUrl);
    });
    server.on('error', reject);
  });
}

async function loadFromDrive() {
  if (!oAuth2Client) return null;
  try {
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    // Always search by name on load to get the latest file (don't rely on cached ID)
    const listRes = await drive.files.list({
      q: "name='tracker-data.json' and trashed=false",
      fields: 'files(id)',
      pageSize: 1,
    });
    if (listRes.data.files && listRes.data.files.length > 0) {
      driveFileId = listRes.data.files[0].id;
      fs.writeFileSync(fileIdPath(), driveFileId);
    } else {
      return null;
    }
    const res = await drive.files.get({ fileId: driveFileId, alt: 'media' });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch(e) {
    console.error('Drive load:', e.message);
    if (e.code === 404) { driveFileId = null; }
    return null;
  }
}

async function saveToDrive(data) {
  if (!oAuth2Client) return false;
  try {
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    const body = Readable.from([JSON.stringify(data)]);
    if (driveFileId) {
      await drive.files.update({ fileId: driveFileId, media: { mimeType: 'application/json', body } });
    } else {
      const res = await drive.files.create({
        requestBody: { name: 'tracker-data.json' },
        media: { mimeType: 'application/json', body },
        fields: 'id',
      });
      driveFileId = res.data.id;
      fs.writeFileSync(fileIdPath(), driveFileId);
    }
    return true;
  } catch(e) {
    console.error('Drive save:', e.message);
    return false;
  }
}

// IPC
ipcMain.handle('drive:signin', async () => {
  try {
    await doSignIn();
    const fip = fileIdPath();
    if (fs.existsSync(fip)) driveFileId = fs.readFileSync(fip, 'utf8').trim();
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('drive:status', () => ({ signedIn: !!oAuth2Client }));
ipcMain.handle('drive:load', async () => loadFromDrive());
ipcMain.handle('drive:save', async (_, data) => saveToDrive(data));

// Window
function createWindow() {
  const win = new BrowserWindow({
    width: 1150,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Items Tracker',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('items.tracker.html');
  win.maximize();
  win.setMenuBarVisibility(false);
}

function setupAutoUpdater() {
  autoUpdater.checkForUpdates().catch(() => {});
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart to apply the update.',
      buttons: ['Restart Now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
}

app.whenReady().then(async () => {
  await initAuth();
  createWindow();
  setupAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { app.quit(); });
