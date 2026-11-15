let socket;
let connecting;
let nextId = 1;
const pending = new Map();
const listeners = new Set();

function onMessage(message) {
  let data;
  try { data = JSON.parse(message.data); } catch { return; }
  if (data.event) {
    for (const listener of listeners) {
      try { listener(data.event); } catch {}
    }
    return;
  }
  const request = pending.get(data.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error.message || '本地服务请求失败'));
  else request.resolve(data.result);
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connecting) return connecting;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(`${protocol}//${location.host}/bridge`);
  socket = current;
  connecting = new Promise((resolve, reject) => {
    current.addEventListener('open', () => {
      connecting = null;
      resolve(current);
    }, { once: true });
    current.addEventListener('error', () => {
      connecting = null;
      reject(new Error('无法连接 Windows 本机 WebUI 服务'));
    }, { once: true });
    current.addEventListener('close', () => {
      if (socket === current) socket = null;
      connecting = null;
      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        request.reject(new Error('本机 WebUI 服务已断开，请重新启动后刷新网页'));
        pending.delete(id);
      }
    });
    current.addEventListener('message', onMessage);
  });
  return connecting;
}

async function request(method, params = {}) {
  const current = await connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本机服务响应超时，请重试'));
    }, 180000);
    pending.set(id, { resolve, reject, timer });
    try { current.send(JSON.stringify({ id, method, params })); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function pickAudioFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4';
    input.hidden = true;
    document.body.append(input);
    const finish = file => { input.remove(); resolve(file || null); };
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    input.click();
  });
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('无法读取参考录音'));
    reader.readAsDataURL(file);
  });
}

window.digitalHuman = Object.freeze({
  getSettings: async () => {
    const settings = await request('settings:get');
    const integrated = settings.keyPersistence === 'encrypted';
    const intro = document.querySelector('#settings-panel > .teacher-intro');
    if (intro) intro.textContent = integrated
      ? '填写 Qwen 实时 WebSocket 的 Base URL 和 API Key。与桌面端共用设置；密钥由 Windows 加密保存在当前用户目录。'
      : '填写 Qwen 实时 WebSocket 的 Base URL 和 API Key。公共入口已预填；WebUI 的密钥仅保存在本次 Windows 启动进程的内存中，重启后需重新填写。';
    const clearToken = document.querySelector('#clear-token');
    if (clearToken) clearToken.textContent = integrated ? '清除已保存的 API Key' : '清除本次运行的 API Key';
    return settings;
  },
  saveSettings: data => request('settings:save', data),
  cloneVoice: async () => {
    const file = await pickAudioFile();
    if (!file) return { canceled: true };
    if (!/\.(wav|mp3|m4a)$/i.test(file.name)) throw new Error('参考录音仅支持 WAV、MP3 或 M4A');
    if (file.size < 1024 || file.size > 10 * 1024 * 1024) throw new Error('参考录音大小必须在 1 KB 到 10 MB 之间');
    return request('voice:clone', { fileName: file.name, audioBase64: await fileBase64(file) });
  },
  checkPendingVoice: () => request('voice:check-pending'),
  previewVoice: data => request('voice:preview', data),
  status: () => request('runtime:status'),
  startSession: () => request('runtime:start'),
  sendVoice: (audioBase64, mode) => request('runtime:voice', { audioBase64, mode }),
  sendText: (text, mode) => request('runtime:text', { text, mode }),
  resetSession: () => request('runtime:reset'),
  toggleFullscreen: async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    return Boolean(document.fullscreenElement);
  },
  onRuntimeEvent: listener => {
    listeners.add(listener);
    connect().catch(() => {});
    return () => listeners.delete(listener);
  }
});
