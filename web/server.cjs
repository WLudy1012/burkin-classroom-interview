const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');
const { createRuntime } = require('../desktop/runtime/index.cjs');
const { MODEL, DEFAULT_BASE_URL, resolveRealtimeUrl } = require('../desktop/runtime/endpoint.cjs');
const { QwenRealtime, DEFAULT_VOICE_ID, DEFAULT_SPEECH_RATE, normalizeVoiceId, normalizeSpeechRate } = require('../desktop/runtime/qwen.cjs');
const { createClonedVoice, queryClonedVoice, MAX_AUDIO_BYTES } = require('../desktop/runtime/voice-clone.cjs');

const ROOT = path.join(__dirname, '..', 'desktop');
const RENDERER = path.join(ROOT, 'renderer');
const ASSETS = path.join(ROOT, 'assets');
const ASSET_NAME = /^(?:scene-(?:study|street|stairwell|cemetery|archive)|burkin-(?:neutral|speaking|gesture|sigh))\.webp$/;

async function createWebServer({
  port = 4173,
  host = '127.0.0.1',
  runtimeFactory = createRuntime,
  modelFactory = options => new QwenRealtime(options),
  cloneVoice = createClonedVoice,
  queryVoice = queryClonedVoice,
  settingsBridge,
  settingsPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BurkinClassroomWebUI', 'settings.json'),
} = {}) {
  if (host !== '127.0.0.1') throw new Error('网页端只允许监听 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('本地端口无效');

  let settings = { baseUrl: DEFAULT_BASE_URL, apiKey: '', voiceId: DEFAULT_VOICE_ID, speechRate: DEFAULT_SPEECH_RATE, pendingVoiceId: '' };
  if (!settingsBridge) {
    try {
      const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.baseUrl = String(stored.baseUrl || DEFAULT_BASE_URL).trim();
      resolveRealtimeUrl(settings.baseUrl);
      settings.voiceId = normalizeVoiceId(stored.voiceId || DEFAULT_VOICE_ID);
      settings.speechRate = normalizeSpeechRate(stored.speechRate ?? DEFAULT_SPEECH_RATE);
      settings.pendingVoiceId = stored.pendingVoiceId ? normalizeVoiceId(stored.pendingVoiceId) : '';
    } catch {
      settings = { baseUrl: DEFAULT_BASE_URL, apiKey: '', voiceId: DEFAULT_VOICE_ID, speechRate: DEFAULT_SPEECH_RATE, pendingVoiceId: '' };
    }
  }
  const readSettings = () => settingsBridge ? settingsBridge.get() : settings;
  const persistSettings = () => {
    if (settingsBridge) return settingsBridge.persist();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const current = readSettings();
    fs.writeFileSync(settingsPath, JSON.stringify({
      baseUrl: current.baseUrl,
      voiceId: current.voiceId,
      speechRate: current.speechRate,
      pendingVoiceId: current.pendingVoiceId,
    }), { encoding: 'utf8', mode: 0o600 });
  };
  let runtime;
  let runtimeStatus = 'idle';
  let sessionStarted = false;
  let cloneInProgress = false;
  let origin = '';
  let expectedHost = '';

  let activeSocket;
  let currentSocket;
  let serial = Promise.resolve();
  const enqueue = task => {
    const result = serial.then(task);
    serial = result.catch(() => {});
    return result;
  };
  const emit = event => {
    if (event?.type === 'status') runtimeStatus = event.status || 'idle';
    const payload = JSON.stringify({ event });
    if (activeSocket?.readyState === WebSocket.OPEN) {
      if (activeSocket.bufferedAmount > 8 * 1024 * 1024) activeSocket.close(1009, 'Event buffer full');
      else activeSocket.send(payload);
    }
  };

  const publicSettings = () => {
    const current = readSettings();
    return {
      baseUrl: current.baseUrl,
      hasApiKey: Boolean(current.apiKey),
      keyPersistence: settingsBridge ? 'encrypted' : 'memory',
      model: MODEL,
      voiceId: current.voiceId,
      speechRate: current.speechRate,
      pendingVoiceId: current.pendingVoiceId,
    };
  };

  const closeRuntime = async () => {
    const previous = runtime;
    runtime = undefined;
    sessionStarted = false;
    runtimeStatus = 'idle';
    if (previous?.close) await previous.close();
  };

  const beforeChange = async () => {
    await closeRuntime();
    if (settingsBridge?.beforeChange) await settingsBridge.beforeChange();
  };

  const applySettings = next => {
    if (settingsBridge) Object.assign(readSettings(), next);
    else settings = next;
  };

  const ensureRuntime = () => {
    const current = readSettings();
    if (!current.apiKey || !current.baseUrl) throw new Error('请先在“模型设置”中填写 Base URL 和 API Key');
    if (!runtime) runtime = runtimeFactory({
      apiKey: current.apiKey,
      baseUrl: current.baseUrl,
      voiceId: current.voiceId,
      speechRate: current.speechRate,
      onEvent: emit,
    });
    return runtime;
  };

  const saveSettings = async data => {
    if (cloneInProgress) throw new Error('音色复刻进行中，请完成后再保存设置');
    const current = readSettings();
    const baseUrl = String(data?.baseUrl || '').trim();
    resolveRealtimeUrl(baseUrl);
    const apiKey = data?.clearApiKey ? '' : (typeof data?.apiKey === 'string' && data.apiKey.trim() ? data.apiKey.trim() : current.apiKey);
    const voiceId = data?.voiceId === undefined ? current.voiceId : normalizeVoiceId(data.voiceId);
    const speechRate = data?.speechRate === undefined ? current.speechRate : normalizeSpeechRate(data.speechRate);
    const next = { ...current, baseUrl, apiKey, voiceId, speechRate };
    if (settingsBridge?.validate) await settingsBridge.validate(next);
    await beforeChange();
    applySettings(next);
    await persistSettings();
    if (settingsBridge?.afterChange) await settingsBridge.afterChange();
    return publicSettings();
  };

  const cloneRecordedVoice = async data => {
    if (cloneInProgress) throw new Error('音色复刻已在进行中');
    const current = readSettings();
    if (!current.apiKey || !current.baseUrl) throw new Error('请先保存 Base URL 和 API Key');
    if (data?.canceled) return { canceled: true };
    const fileName = path.basename(String(data?.fileName || ''));
    const audioBase64 = data?.audioBase64;
    if (typeof audioBase64 !== 'string' || audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) {
      throw new Error('参考录音数据无效或过长');
    }
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    cloneInProgress = true;
    try {
      const result = await cloneVoice({
        apiKey: current.apiKey,
        baseUrl: current.baseUrl,
        audioBuffer,
        fileName,
        onCreated: async voiceId => {
          readSettings().pendingVoiceId = voiceId;
          await persistSettings();
        },
      });
      await beforeChange();
      const updated = readSettings();
      updated.voiceId = result.voiceId;
      updated.pendingVoiceId = '';
      await persistSettings();
      if (settingsBridge?.afterChange) await settingsBridge.afterChange();
      return { voiceId: result.voiceId, status: 'OK' };
    } finally {
      cloneInProgress = false;
    }
  };

  const checkPendingVoice = async () => {
    const current = readSettings();
    if (!current.pendingVoiceId) return { pending: false };
    if (cloneInProgress) throw new Error('音色复刻仍在进行中');
    const result = await queryVoice({
      apiKey: current.apiKey,
      baseUrl: current.baseUrl,
      voiceId: current.pendingVoiceId,
    });
    if (result.status === 'OK') {
      await beforeChange();
      const updated = readSettings();
      updated.voiceId = result.voiceId;
      updated.pendingVoiceId = '';
      await persistSettings();
      if (settingsBridge?.afterChange) await settingsBridge.afterChange();
    } else if (result.status === 'UNDEPLOYED') {
      readSettings().pendingVoiceId = '';
      await persistSettings();
    }
    return result;
  };

  const runMethod = async (method, data) => {
    switch (method) {
      case 'settings:get': return publicSettings();
      case 'settings:save': return saveSettings(data);
      case 'voice:clone': return cloneRecordedVoice(data);
      case 'voice:check-pending': return checkPendingVoice();
      case 'voice:preview': {
        const current = readSettings();
        if (!current.apiKey || !current.baseUrl) throw new Error('请先保存 Base URL 和 API Key');
        const voiceId = normalizeVoiceId(data?.voiceId ?? current.voiceId);
        const speechRate = normalizeSpeechRate(data?.speechRate ?? current.speechRate);
        const model = modelFactory({ apiKey: current.apiKey, baseUrl: current.baseUrl, voiceId, speechRate });
        const pcm = await model.synthesize('我是布尔金。那件事说来话长，请听我慢慢讲。');
        return { pcmBase64: pcm.toString('base64'), sampleRate: 24000 };
      }
      case 'runtime:status': {
        const current = readSettings();
        return { configured: Boolean(current.apiKey && current.baseUrl), sessionStarted, status: runtimeStatus, model: MODEL };
      }
      case 'runtime:start': {
        const result = await ensureRuntime().start();
        sessionStarted = true;
        return result;
      }
      case 'runtime:reset': {
        const result = await ensureRuntime().reset();
        sessionStarted = true;
        return result;
      }
      case 'runtime:voice': {
        if (!sessionStarted) throw new Error('请先开始访谈');
        const { audioBase64, mode } = data || {};
        if (typeof audioBase64 !== 'string' || audioBase64.length > 4000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) throw new Error('音频数据无效或过长');
        if (mode !== 'role' && mode !== 'verify') throw new Error('语音模式无效');
        const pcm = Buffer.from(audioBase64, 'base64');
        if (pcm.length < 3200 || pcm.length > 3000000 || pcm.length % 2 !== 0) throw new Error('录音长度无效');
        return ensureRuntime().voice(pcm, { mode });
      }
      case 'runtime:text': {
        if (!sessionStarted) throw new Error('请先开始访谈');
        const { text, mode } = data || {};
        if (mode !== 'role' && mode !== 'verify') throw new Error('文字提问模式无效');
        if (typeof text !== 'string' || text.length > 2000) throw new Error('请输入不超过 500 字的文字问题');
        const question = text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
        if (!question || Array.from(question).length > 500 || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(question)) throw new Error('请输入不超过 500 字的有效文字问题');
        const result = await ensureRuntime().ask(question, { mode });
        return { ...result, transcription: question };
      }
      default: throw new Error('未知的网页端操作');
    }
  };

  const sendFile = async (response, filePath, contentType, transform) => {
    try {
      const file = await fs.promises.readFile(filePath);
      const body = transform ? Buffer.from(transform(file.toString('utf8')), 'utf8') : file;
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  };

  const server = http.createServer((request, response) => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end('Method not allowed');
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, origin).pathname; } catch { pathname = ''; }
    if (pathname === '/') {
      response.writeHead(302, { Location: '/renderer/index.html', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (pathname === '/renderer/index.html') {
      sendFile(response, path.join(RENDERER, 'index.html'), 'text/html; charset=utf-8', html => html
        .replace("connect-src 'none'", `connect-src 'self' ws://${expectedHost}`)
        .replace('<script defer src="./app.js"></script>', '<script defer src="./web-bridge.js"></script>\n  <script defer src="./app.js"></script>'));
      return;
    }
    if (pathname === '/renderer/web-bridge.js') {
      sendFile(response, path.join(__dirname, 'web-bridge.js'), 'text/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/favicon.ico') {
      sendFile(response, path.join(ASSETS, 'icon.ico'), 'image/x-icon');
      return;
    }
    if (['/renderer/app.js', '/renderer/styles.css'].includes(pathname)) {
      const fileName = pathname.slice('/renderer/'.length);
      const contentType = fileName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      sendFile(response, path.join(RENDERER, fileName), contentType);
      return;
    }
    if (pathname.startsWith('/assets/') && ASSET_NAME.test(pathname.slice('/assets/'.length))) {
      sendFile(response, path.join(ASSETS, pathname.slice('/assets/'.length)), 'image/webp');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 15 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.host !== expectedHost || request.headers.origin !== origin || request.url !== '/bridge') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
  });

  wss.on('connection', socket => {
    const previous = currentSocket;
    currentSocket = socket;
    activeSocket = undefined;
    if (previous?.readyState === WebSocket.OPEN) previous.close(1008, 'Another tab opened');
    enqueue(async () => {
      await closeRuntime();
      if (currentSocket === socket) activeSocket = socket;
    }).catch(() => {});
    socket.on('close', () => {
      if (currentSocket === socket) currentSocket = undefined;
      if (activeSocket === socket) activeSocket = undefined;
    });
    socket.on('message', (raw, isBinary) => {
      enqueue(async () => {
        if (currentSocket !== socket) return;
        let id;
        try {
          if (isBinary) throw new Error('只接受 JSON 请求');
          const request = JSON.parse(raw.toString());
          id = request.id;
          if (!Number.isSafeInteger(id) || id < 0 || typeof request.method !== 'string') throw new Error('网页端请求格式无效');
          const result = await runMethod(request.method, request.params);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, result }));
        } catch (error) {
          const message = String(error?.message || '网页端操作失败').replaceAll(readSettings().apiKey || '\0', '[redacted]').slice(0, 300);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, error: { message } }));
        }
      }).catch(() => {});
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    wss.close();
    throw error;
  }
  const actualPort = server.address().port;
  expectedHost = `${host}:${actualPort}`;
  origin = `http://${expectedHost}`;
  return {
    url: origin,
    port: actualPort,
    server,
    invalidateRuntime: () => enqueue(async () => {
      await closeRuntime();
      emit({ type: 'resetRequired' });
    }),
    close: async () => {
      activeSocket = undefined;
      currentSocket = undefined;
      for (const socket of wss.clients) socket.terminate();
      await serial;
      await closeRuntime();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (require.main === module) {
  createWebServer().then(({ url }) => process.stdout.write(`${url}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createWebServer };
