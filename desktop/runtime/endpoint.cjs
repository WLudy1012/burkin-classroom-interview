const MODEL = 'qwen-audio-3.1-realtime-flash';
const DEFAULT_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

function resolveRealtimeUrl(baseUrl = DEFAULT_BASE_URL) {
  const input = String(baseUrl || '').trim();
  if (!input || input.length > 2048 || /\s/.test(input)) throw new Error('请输入有效的 Base URL');
  let url;
  try { url = new URL(input); } catch { throw new Error('Base URL 必须是完整的 ws、wss、http 或 https 地址'); }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Base URL 格式无效');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (['ws:', 'http:'].includes(url.protocol) && !loopback) throw new Error('远程 Base URL 必须使用 wss 或 https');
  url.protocol = ['http:', 'https:'].includes(url.protocol) ? (url.protocol === 'https:' ? 'wss:' : 'ws:') : url.protocol;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.includes('/compatible-mode/')) throw new Error('请填写 Qwen 实时 WebSocket 地址，不支持 compatible-mode/v1');
  if (!pathname) url.pathname = '/api-ws/v1/realtime';
  else if (pathname.endsWith('/api-ws/v1')) url.pathname = `${pathname}/realtime`;
  else if (!pathname.endsWith('/realtime')) throw new Error('Base URL 必须为域名或实时接口地址');
  url.searchParams.set('model', MODEL);
  return url.toString();
}

module.exports = { MODEL, DEFAULT_BASE_URL, resolveRealtimeUrl };
