const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createWebServer } = require('../web/server.cjs');
const { DEFAULT_BASE_URL } = require('../desktop/runtime/endpoint.cjs');

function tempSettings() {
  const dir = fs.mkdtempSync(path.join(__dirname, '.web-test-'));
  return {
    path: path.join(dir, 'settings.json'),
    cleanup() {
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(__dirname));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function httpRequest(web, pathname, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: web.port,
      path: pathname,
      method,
      headers: host ? { Host: host } : undefined
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function upgradeStatus(web, { pathname = '/bridge', host = `127.0.0.1:${web.port}`, origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(web.port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket upgrade timed out'));
    }, 3000);
    socket.on('connect', () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...(origin ? [`Origin: ${origin}`] : []),
        '',
        ''
      ].join('\r\n'));
    });
    socket.on('data', data => {
      const firstLine = data.toString('utf8').split('\r\n')[0];
      const match = /^HTTP\/1\.1 (\d+)/.exec(firstLine);
      if (!match) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(match[1]));
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openClient(web) {
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/bridge`, { origin: web.url });
  await once(socket, 'open');
  let id = 0;
  const events = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.event) events.push(message.event);
  });
  return {
    socket,
    events,
    call(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off('message', receive);
          reject(new Error(`RPC timed out: ${method}`));
        }, 5000);
        const receive = raw => {
          const message = JSON.parse(raw.toString());
          if (message.id !== requestId) return;
          clearTimeout(timer);
          socket.off('message', receive);
          resolve(message);
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    }
  };
}

test('WebUI 仅监听本机并只提供白名单页面，拒绝伪造的 Host 和 Origin', async () => {
  const temp = tempSettings();
  let web;
  try {
    await assert.rejects(() => createWebServer({ port: 0, host: '0.0.0.0', settingsPath: temp.path }), /127\.0\.0\.1/);
    web = await createWebServer({ port: 0, settingsPath: temp.path });
    assert.equal(web.server.address().address, '127.0.0.1');
    assert.match(web.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const redirect = await httpRequest(web, '/');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/renderer/index.html');
    const page = await httpRequest(web, '/renderer/index.html');
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /web-bridge\.js/);
    assert.match(page.body.toString(), /connect-src 'self' ws:\/\/127\.0\.0\.1:/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await httpRequest(web, '/renderer/app.js')).status, 200);
    assert.equal((await httpRequest(web, '/assets/scene-study.webp')).status, 200);
    for (const route of ['/runtime/qwen.cjs', '/desktop/runtime/facts.cjs', '/settings.json', '/assets/scene-study.png', '/renderer/%2e%2e/runtime/qwen.cjs']) {
      assert.equal((await httpRequest(web, route)).status, 404, route);
    }
    assert.equal((await httpRequest(web, '/renderer/index.html', { method: 'POST' })).status, 405);
    assert.equal((await httpRequest(web, '/renderer/index.html', { host: 'attacker.example' })).status, 403);
    assert.equal(await upgradeStatus(web, { origin: 'https://attacker.example' }), 403);
    assert.equal(await upgradeStatus(web, { host: 'attacker.example', origin: web.url }), 403);
    assert.equal(await upgradeStatus(web, { pathname: '/other', origin: web.url }), 403);
    assert.equal(await upgradeStatus(web), 403);
    const client = await openClient(web);
    assert.equal((await client.call('settings:get')).result.keyPersistence, 'memory');
    assert.equal((await client.call('runtime:status')).result.configured, false);
    client.socket.terminate();
  } finally {
    if (web) await web.close();
    temp.cleanup();
  }
});

test('WebUI 桥接完成访谈流程并串行处理请求，密钥只在当前进程内存中', async () => {
  const temp = tempSettings();
  const trace = [];
  const secret = 'test-secret-never-persist';
  const runtimeFactory = options => {
    trace.push(['runtime', options.apiKey, options.voiceId, options.speechRate]);
    return {
      async start() {
        trace.push(['start']);
        options.onEvent({ type: 'status', status: 'connecting' });
        options.onEvent({ type: 'mode', teacherMode: false });
        options.onEvent({ type: 'audio', pcmBase64: 'AAAAAA==', sampleRate: 24000 });
        options.onEvent({ type: 'audioEnd' });
        return { opening: '大家好啊，我是布尔金。', audioReady: true };
      },
      async ask(text, options) {
        trace.push(['ask:start', text, options.mode]);
        await new Promise(resolve => setTimeout(resolve, 15));
        trace.push(['ask:end', text]);
        options.onEvent?.({ type: 'status', status: 'ready' });
        return { reply: `我听见你问：${text}`, action: null, teacherMode: options.mode === 'verify', source: 'mixed', audioReady: true };
      },
      async voice(pcm, options) {
        trace.push(['voice', pcm.length, options.mode]);
        return { reply: '我记得那件事。', transcription: '那件事怎样？', action: null, teacherMode: options.mode === 'verify', source: 'direct', audioReady: true };
      },
      async reset() {
        trace.push(['reset']);
        return { opening: '大家好啊，我是布尔金。', audioReady: true };
      },
      close() { trace.push(['close']); }
    };
  };
  let web;
  let reopened;
  try {
    web = await createWebServer({ port: 0, settingsPath: temp.path, runtimeFactory });
    const client = await openClient(web);
    assert.match((await client.call('runtime:start')).error.message, /Base URL 和 API Key/);
    const saved = await client.call('settings:save', { baseUrl: DEFAULT_BASE_URL, apiKey: secret, voiceId: 'longhan_v3.1', speechRate: 0.8 });
    assert.equal(saved.result.hasApiKey, true);
    assert.equal(Object.hasOwn(saved.result, 'apiKey'), false);
    assert.doesNotMatch(JSON.stringify(saved), /test-secret/);
    const settings = await client.call('settings:get');
    assert.equal(settings.result.voiceId, 'longhan_v3.1');
    assert.equal(settings.result.speechRate, 0.8);
    assert.equal(settings.result.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(settings), /test-secret/);
    assert.doesNotMatch(fs.readFileSync(temp.path, 'utf8'), /test-secret|apiKey/i);

    const started = await client.call('runtime:start');
    assert.equal(started.result.audioReady, true);
    assert.deepEqual(client.events.slice(0, 4).map(event => event.type), ['status', 'mode', 'audio', 'audioEnd']);
    assert.deepEqual(trace[0], ['runtime', secret, 'longhan_v3.1', 0.8]);
    assert.match((await client.call('runtime:text', { text: '问题', mode: 'other' })).error.message, /模式无效/);
    assert.match((await client.call('runtime:text', { text: '问'.repeat(501), mode: 'role' })).error.message, /500 字/);
    assert.match((await client.call('runtime:voice', { audioBase64: '@@@', mode: 'role' })).error.message, /音频数据无效/);
    assert.match((await client.call('runtime:voice', { audioBase64: Buffer.alloc(100).toString('base64'), mode: 'role' })).error.message, /录音长度无效/);

    const [first, second] = await Promise.all([
      client.call('runtime:text', { text: '第一问', mode: 'role' }),
      client.call('runtime:text', { text: '第二问', mode: 'verify' })
    ]);
    assert.equal(first.result.transcription, '第一问');
    assert.equal(second.result.teacherMode, true);
    assert.deepEqual(trace.filter(item => item[0].startsWith('ask:')).map(item => item[0]), ['ask:start', 'ask:end', 'ask:start', 'ask:end']);
    const voice = await client.call('runtime:voice', { audioBase64: Buffer.alloc(3200).toString('base64'), mode: 'verify' });
    assert.equal(voice.result.transcription, '那件事怎样？');
    assert.deepEqual(trace.find(item => item[0] === 'voice'), ['voice', 3200, 'verify']);
    assert.equal((await client.call('runtime:reset')).result.audioReady, true);
    assert.equal((await client.call('runtime:status')).result.sessionStarted, true);

    const firstClosed = once(client.socket, 'close');
    const replacement = await openClient(web);
    assert.equal((await firstClosed)[0], 1008);
    assert.equal((await replacement.call('runtime:status')).result.sessionStarted, false);
    replacement.socket.terminate();
    await web.close();
    web = undefined;

    reopened = await createWebServer({ port: 0, settingsPath: temp.path, runtimeFactory });
    const next = await openClient(reopened);
    const restored = (await next.call('settings:get')).result;
    assert.equal(restored.voiceId, 'longhan_v3.1');
    assert.equal(restored.speechRate, 0.8);
    assert.equal(restored.hasApiKey, false);
    assert.equal(restored.keyPersistence, 'memory');
    assert.equal((await next.call('runtime:status')).result.configured, false);
    next.socket.terminate();
  } finally {
    if (reopened) await reopened.close();
    if (web) await web.close();
    temp.cleanup();
  }
});

test('WebUI 音色试听与复刻仅使用内存密钥，错误消息不回显密钥', async () => {
  const temp = tempSettings();
  const secret = 'preview-secret-key';
  const voiceId = 'qwen-audio-3.1-realtime-flash-burkin-test';
  const calls = [];
  let web;
  try {
    web = await createWebServer({
      port: 0,
      settingsPath: temp.path,
      modelFactory: options => ({
        async synthesize(text) {
          calls.push(['preview', options.apiKey, options.voiceId, options.speechRate, text]);
          return Buffer.alloc(4800);
        }
      }),
      cloneVoice: async options => {
        calls.push(['clone', options.apiKey, options.fileName, options.audioBuffer.length]);
        await options.onCreated(voiceId);
        return { voiceId, status: 'OK' };
      },
      queryVoice: async () => ({ voiceId, status: 'OK' }),
      runtimeFactory: options => ({
        async start() { throw new Error(`upstream echoed ${options.apiKey}`); },
        close() {}
      })
    });
    const client = await openClient(web);
    await client.call('settings:save', { baseUrl: DEFAULT_BASE_URL, apiKey: secret });
    const preview = await client.call('voice:preview', { voiceId: 'longsanshu_v3.1', speechRate: 0.9 });
    assert.equal(Buffer.from(preview.result.pcmBase64, 'base64').length, 4800);
    assert.deepEqual(calls[0].slice(0, 4), ['preview', secret, 'longsanshu_v3.1', 0.9]);
    assert.match((await client.call('voice:clone', { fileName: 'voice.wav', audioBase64: '@@@' })).error.message, /无效/);
    const cloned = await client.call('voice:clone', { fileName: 'voice.wav', audioBase64: Buffer.alloc(1024).toString('base64') });
    assert.equal(cloned.result.voiceId, voiceId);
    assert.deepEqual(calls[1], ['clone', secret, 'voice.wav', 1024]);
    assert.equal((await client.call('settings:get')).result.voiceId, voiceId);
    assert.doesNotMatch(fs.readFileSync(temp.path, 'utf8'), /preview-secret/);
    const failure = await client.call('runtime:start');
    assert.match(failure.error.message, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(failure), /preview-secret/);
    client.socket.terminate();
  } finally {
    if (web) await web.close();
    temp.cleanup();
  }
});

test('一体版 WebUI 与桌面端共用设置、密钥和音色，桌面修改会重置网页会话', async () => {
  const temp = tempSettings();
  const shared = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: 'desktop-initial-key',
    voiceId: 'longsanshu_v3.1',
    speechRate: 0.9,
    pendingVoiceId: ''
  };
  const snapshots = [];
  const runtimeKeys = [];
  let beforeChanges = 0;
  let closes = 0;
  const clonedVoiceId = 'qwen-audio-3.1-realtime-flash-burkin-unified';
  const settingsBridge = {
    get: () => shared,
    validate: next => {
      if (next.apiKey === 'rejected-key') throw new Error('密钥不可用');
    },
    beforeChange: async () => { beforeChanges++; },
    persist: () => snapshots.push({ ...shared })
  };
  let web;
  try {
    web = await createWebServer({
      port: 0,
      settingsPath: temp.path,
      settingsBridge,
      runtimeFactory: options => {
        runtimeKeys.push([options.apiKey, options.voiceId]);
        return {
          async start() { return { opening: '大家好啊，我是布尔金。', audioReady: true }; },
          close() { closes++; }
        };
      },
      cloneVoice: async options => {
        await options.onCreated(clonedVoiceId);
        return { voiceId: clonedVoiceId, status: 'OK' };
      }
    });
    const client = await openClient(web);
    const initial = await client.call('settings:get');
    assert.equal(initial.result.hasApiKey, true);
    assert.equal(initial.result.keyPersistence, 'encrypted');
    assert.equal(initial.result.keyPersistence, 'encrypted');
    assert.equal(initial.result.voiceId, 'longsanshu_v3.1');
    assert.doesNotMatch(JSON.stringify(initial), /desktop-initial-key/);
    assert.equal((await client.call('runtime:status')).result.configured, true);
    assert.equal((await client.call('runtime:start')).result.audioReady, true);
    assert.deepEqual(runtimeKeys[0], ['desktop-initial-key', 'longsanshu_v3.1']);

    const rejected = await client.call('settings:save', { baseUrl: DEFAULT_BASE_URL, apiKey: 'rejected-key' });
    assert.match(rejected.error.message, /密钥不可用/);
    assert.equal(shared.apiKey, 'desktop-initial-key');
    const changed = await client.call('settings:save', { baseUrl: DEFAULT_BASE_URL, apiKey: 'web-new-key', voiceId: 'longanqian_v3.1' });
    assert.equal(changed.result.hasApiKey, true);
    assert.equal(shared.apiKey, 'web-new-key');
    assert.equal(shared.voiceId, 'longanqian_v3.1');
    assert.equal((await client.call('runtime:status')).result.sessionStarted, false);
    assert.ok(beforeChanges >= 1);
    assert.ok(closes >= 1);
    assert.equal((await client.call('runtime:start')).result.audioReady, true);
    assert.deepEqual(runtimeKeys.at(-1), ['web-new-key', 'longanqian_v3.1']);

    Object.assign(shared, { apiKey: 'desktop-new-key', voiceId: 'longhan_v3.1' });
    await web.invalidateRuntime();
    assert.equal((await client.call('runtime:status')).result.sessionStarted, false);
    assert.equal((await client.call('settings:get')).result.voiceId, 'longhan_v3.1');
    assert.equal((await client.call('runtime:start')).result.audioReady, true);
    assert.deepEqual(runtimeKeys.at(-1), ['desktop-new-key', 'longhan_v3.1']);

    const cloned = await client.call('voice:clone', { fileName: 'voice.wav', audioBase64: Buffer.alloc(1024).toString('base64') });
    assert.equal(cloned.result.voiceId, clonedVoiceId);
    assert.equal(shared.voiceId, clonedVoiceId);
    assert.equal(shared.pendingVoiceId, '');
    assert.ok(snapshots.some(item => item.pendingVoiceId === clonedVoiceId));
    assert.equal(snapshots.at(-1).voiceId, clonedVoiceId);
    assert.equal(fs.existsSync(temp.path), false);
    client.socket.terminate();
  } finally {
    if (web) await web.close();
    temp.cleanup();
  }
});
