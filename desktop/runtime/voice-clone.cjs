const { extname } = require('node:path');
const { MODEL, resolveRealtimeUrl } = require('./endpoint.cjs');

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

function resolveVoiceCustomizationUrl(baseUrl) {
  const url = new URL(resolveRealtimeUrl(baseUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/v1/services/audio/tts/customization';
  url.search = '';
  return url.toString();
}

function validateVoiceId(voiceId) {
  if (typeof voiceId !== 'string' || !voiceId.startsWith(`${MODEL}-`) || !/^[A-Za-z0-9._-]{1,128}$/.test(voiceId)) {
    throw new Error('返回的音色 ID 与当前实时模型不匹配');
  }
  return voiceId;
}

function safeDetail(value, apiKey) {
  if (typeof value !== 'string') return '';
  let detail = value.slice(0, 200).replace(/data:audio\/[^\s"']+/gi, '[audio]');
  if (apiKey) detail = detail.replaceAll(apiKey, '[redacted]');
  return detail;
}

async function requestVoice({ apiKey, baseUrl, input, fetchImpl = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('请先保存有效的 API Key');
  const response = await fetchImpl(resolveVoiceCustomizationUrl(baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voice-enrollment', input }),
    signal: AbortSignal.timeout(25000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`音色接口返回无效内容（HTTP ${response.status}）`); }
  if (!response.ok || result?.code) {
    const code = safeDetail(result?.code, apiKey);
    const message = safeDetail(result?.message, apiKey);
    throw new Error(`音色接口请求失败（HTTP ${response.status}${code ? ` / ${code}` : ''}）${message ? `：${message}` : ''}`);
  }
  return result;
}

async function queryClonedVoice({ apiKey, baseUrl, voiceId, fetchImpl = fetch }) {
  validateVoiceId(voiceId);
  const result = await requestVoice({
    apiKey, baseUrl, fetchImpl,
    input: { action: 'query_voice', voice_id: voiceId }
  });
  const status = result?.output?.status;
  const targetModel = result?.output?.target_model;
  if (targetModel !== MODEL) throw new Error('音色所属模型与当前实时模型不匹配');
  if (!['DEPLOYING', 'OK', 'UNDEPLOYED'].includes(status)) throw new Error('音色接口返回未知状态');
  return { voiceId, status };
}

async function waitForClonedVoice({ apiKey, baseUrl, voiceId, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30 }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(1000);
    const result = await queryClonedVoice({ apiKey, baseUrl, voiceId, fetchImpl });
    if (result.status === 'OK') return result;
    if (result.status === 'UNDEPLOYED') throw new Error('音色审核未通过，请更换清晰录音后重试');
  }
  const error = new Error('音色仍在处理中，已保留音色 ID，可稍后查询状态');
  error.voiceId = voiceId;
  throw error;
}

async function createClonedVoice({ apiKey, baseUrl, audioBuffer, fileName, fetchImpl = fetch, sleep, onCreated }) {
  const mime = AUDIO_MIME[extname(String(fileName || '')).toLowerCase()];
  if (!mime) throw new Error('参考录音仅支持 WAV、MP3 或 M4A');
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 1024 || audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error('参考录音大小必须在 1 KB 到 10 MB 之间');
  }
  const result = await requestVoice({
    apiKey, baseUrl, fetchImpl,
    input: {
      action: 'create_voice',
      target_model: MODEL,
      prefix: 'burkin',
      audio: `data:${mime};base64,${audioBuffer.toString('base64')}`,
      language_hints: ['zh']
    }
  });
  const voiceId = validateVoiceId(result?.output?.voice_id);
  if (onCreated) await onCreated(voiceId);
  return waitForClonedVoice({ apiKey, baseUrl, voiceId, fetchImpl, sleep });
}

module.exports = { createClonedVoice, queryClonedVoice, waitForClonedVoice, resolveVoiceCustomizationUrl, MAX_AUDIO_BYTES };
