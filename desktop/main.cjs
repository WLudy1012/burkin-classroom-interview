const { app, BrowserWindow, ipcMain, session, safeStorage, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createRuntime } = require('./runtime/index.cjs');
const { MODEL, DEFAULT_BASE_URL, resolveRealtimeUrl } = require('./runtime/endpoint.cjs');
const { QwenRealtime, DEFAULT_VOICE_ID, DEFAULT_SPEECH_RATE, normalizeVoiceId, normalizeSpeechRate } = require('./runtime/qwen.cjs');
const { createClonedVoice, queryClonedVoice } = require('./runtime/voice-clone.cjs');
const { createWebServer } = require('../web/server.cjs');

let mainWindow;
let runtime;
let runtimeRevision = 0;
let sessionStarted = false;
let runtimeStatus = 'idle';
let cloneInProgress = false;
let webServer;
let webOpening;
let settings = { baseUrl: DEFAULT_BASE_URL, apiKey: '', voiceId: DEFAULT_VOICE_ID, speechRate: DEFAULT_SPEECH_RATE, pendingVoiceId: '' };

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function persistSettings() {
  if (settings.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统当前无法安全保存 API Key');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({
    baseUrl: settings.baseUrl,
    voiceId: settings.voiceId,
    speechRate: settings.speechRate,
    pendingVoiceId: settings.pendingVoiceId,
    encryptedApiKey: settings.apiKey ? safeStorage.encryptString(settings.apiKey).toString('base64') : '',
  }), { encoding: 'utf8', mode: 0o600 });
}

function loadSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const legacy = /^[A-Za-z0-9_-]{3,128}$/.test(stored.workspaceId || '')
      ? `wss://${stored.workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime` : DEFAULT_BASE_URL;
    settings.baseUrl = String(stored.baseUrl || legacy).trim();
    resolveRealtimeUrl(settings.baseUrl);
    settings.apiKey = stored.encryptedApiKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')) : '';
    settings.voiceId = normalizeVoiceId(stored.voiceId || DEFAULT_VOICE_ID);
    settings.speechRate = normalizeSpeechRate(stored.speechRate ?? DEFAULT_SPEECH_RATE);
    settings.pendingVoiceId = stored.pendingVoiceId ? normalizeVoiceId(stored.pendingVoiceId) : '';
  } catch {
    settings = { baseUrl: DEFAULT_BASE_URL, apiKey: '', voiceId: DEFAULT_VOICE_ID, speechRate: DEFAULT_SPEECH_RATE, pendingVoiceId: '' };
  }
}

function publicSettings() {
  return { baseUrl: settings.baseUrl, hasApiKey: Boolean(settings.apiKey), model: MODEL, voiceId: settings.voiceId, speechRate: settings.speechRate, pendingVoiceId: settings.pendingVoiceId };
}

async function closeRuntime() {
  runtimeRevision++;
  const oldRuntime = runtime;
  runtime = undefined;
  sessionStarted = false;
  runtimeStatus = 'idle';
  if (oldRuntime?.close) await oldRuntime.close();
}

async function saveSettings(data) {
  if (cloneInProgress) throw new Error('音色复刻进行中，请完成后再保存设置');
  const baseUrl = String(data.baseUrl || '').trim();
  resolveRealtimeUrl(baseUrl);
  const apiKey = data.clearApiKey ? '' : (typeof data.apiKey === 'string' && data.apiKey.trim() ? data.apiKey.trim() : settings.apiKey);
  const voiceId = data.voiceId === undefined ? settings.voiceId : normalizeVoiceId(data.voiceId);
  const speechRate = data.speechRate === undefined ? settings.speechRate : normalizeSpeechRate(data.speechRate);
  if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统当前无法安全保存 API Key');
  await closeRuntime();
  settings = { ...settings, baseUrl, apiKey, voiceId, speechRate };
  persistSettings();
  if (webServer) await webServer.invalidateRuntime();
  return publicSettings();
}

function notifyDesktopReset() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:event', { type: 'resetRequired' });
}

async function ensureWebServer() {
  if (webServer) return webServer;
  if (webOpening) return webOpening;
  const options = {
    settingsBridge: {
      get: () => settings,
      validate: next => {
        if (next.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统当前无法安全保存 API Key');
      },
      beforeChange: closeRuntime,
      persist: persistSettings,
      afterChange: notifyDesktopReset,
    },
  };
  webOpening = (async () => {
    try { return await createWebServer({ ...options, port: 4173 }); }
    catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      return createWebServer({ ...options, port: 0 });
    }
  })();
  try {
    webServer = await webOpening;
    return webServer;
  } finally {
    webOpening = undefined;
  }
}

function emit(event) {
  if (event?.type === 'status') runtimeStatus = event.status || 'idle';
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:event', event);
}

function ensureRuntime() {
  if (!settings.apiKey || !settings.baseUrl) throw new Error('请先在“模型设置”中填写 Base URL 和 API Key');
  if (!runtime) runtime = createRuntime({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, voiceId: settings.voiceId, speechRate: settings.speechRate, onEvent: emit });
  return runtime;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#101713',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  loadSettings();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(webContents === mainWindow?.webContents && permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return webContents === mainWindow?.webContents && permission === 'media';
  });

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:save', (_event, data) => saveSettings(data || {}));
  ipcMain.handle('voice:clone', async () => {
    if (cloneInProgress) throw new Error('音色复刻已在进行中');
    if (!settings.apiKey || !settings.baseUrl) throw new Error('请先保存 Base URL 和 API Key');
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择布尔金音色参考录音',
      properties: ['openFile'],
      filters: [{ name: '参考录音', extensions: ['wav', 'mp3', 'm4a'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    cloneInProgress = true;
    try {
      const filePath = selected.filePaths[0];
      const fileInfo = await fs.promises.stat(filePath);
      if (!fileInfo.isFile() || fileInfo.size === 0 || fileInfo.size > 10 * 1024 * 1024) throw new Error('参考录音需为不超过 10 MB 的有效音频文件');
      const audioBuffer = await fs.promises.readFile(filePath);
      const result = await createClonedVoice({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        audioBuffer,
        fileName: path.basename(filePath),
        onCreated: (voiceId) => {
          settings.pendingVoiceId = voiceId;
          persistSettings();
        },
      });
      await closeRuntime();
      settings.voiceId = result.voiceId;
      settings.pendingVoiceId = '';
      persistSettings();
      if (webServer) await webServer.invalidateRuntime();
      return { voiceId: result.voiceId, status: 'OK' };
    } finally {
      cloneInProgress = false;
    }
  });
  ipcMain.handle('voice:check-pending', async () => {
    if (!settings.pendingVoiceId) return { pending: false };
    if (cloneInProgress) throw new Error('音色复刻仍在进行中');
    const result = await queryClonedVoice({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      voiceId: settings.pendingVoiceId,
    });
    if (result.status === 'OK') {
      await closeRuntime();
      settings.voiceId = result.voiceId;
      settings.pendingVoiceId = '';
      persistSettings();
      if (webServer) await webServer.invalidateRuntime();
    } else if (result.status === 'UNDEPLOYED') {
      settings.pendingVoiceId = '';
      persistSettings();
    }
    return result;
  });
  ipcMain.handle('voice:preview', async (_event, data) => {
    if (!settings.apiKey || !settings.baseUrl) throw new Error('请先保存 Base URL 和 API Key');
    const voiceId = normalizeVoiceId(data?.voiceId ?? settings.voiceId);
    const speechRate = normalizeSpeechRate(data?.speechRate ?? settings.speechRate);
    const model = new QwenRealtime({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, voiceId, speechRate });
    const pcm = await model.synthesize('我是布尔金。那件事说来话长，请听我慢慢讲。');
    return { pcmBase64: pcm.toString('base64'), sampleRate: 24000 };
  });
  ipcMain.handle('runtime:status', () => ({
    configured: Boolean(settings.apiKey && settings.baseUrl),
    sessionStarted,
    status: runtimeStatus,
    model: MODEL,
  }));
  ipcMain.handle('runtime:start', async () => {
    const active = ensureRuntime();
    const revision = runtimeRevision;
    const result = await active.start();
    if (revision !== runtimeRevision) throw new Error('模型设置已更新，请重新开始访谈');
    sessionStarted = true;
    return result;
  });
  ipcMain.handle('runtime:voice', (_event, data) => {
    if (!sessionStarted) throw new Error('请先开始访谈');
    const { audioBase64, mode } = data || {};
    if (typeof audioBase64 !== 'string' || audioBase64.length > 4000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) throw new Error('音频数据无效或过长');
    if (mode !== 'role' && mode !== 'verify') throw new Error('语音模式无效');
    const pcm = Buffer.from(audioBase64, 'base64');
    if (pcm.length < 3200 || pcm.length > 3000000 || pcm.length % 2 !== 0) throw new Error('录音长度无效');
    return ensureRuntime().voice(pcm, { mode });
  });
  ipcMain.handle('runtime:text', async (_event, data) => {
    if (!sessionStarted) throw new Error('请先开始访谈');
    const { text, mode } = data || {};
    if (mode !== 'role' && mode !== 'verify') throw new Error('文字提问模式无效');
    if (typeof text !== 'string' || text.length > 2000) throw new Error('请输入不超过 500 字的文字问题');
    const question = text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
    if (!question || Array.from(question).length > 500 || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(question)) {
      throw new Error('请输入不超过 500 字的有效文字问题');
    }
    const result = await ensureRuntime().ask(question, { mode });
    return { ...result, transcription: question };
  });
  ipcMain.handle('runtime:reset', async () => {
    const active = ensureRuntime();
    const revision = runtimeRevision;
    const result = await active.reset();
    if (revision !== runtimeRevision) throw new Error('模型设置已更新，请重新开始访谈');
    sessionStarted = true;
    return result;
  });
  ipcMain.handle('window:fullscreen', () => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });
  ipcMain.handle('web:open', async () => {
    const server = await ensureWebServer();
    await shell.openExternal(server.url);
    return { url: server.url };
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  closeRuntime().catch(() => {});
  webServer?.close().catch(() => {});
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
