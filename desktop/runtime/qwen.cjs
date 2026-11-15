const WebSocket = require('ws');
const { ACTIONS } = require('./facts.cjs');
const { MODEL, DEFAULT_BASE_URL, resolveRealtimeUrl } = require('./endpoint.cjs');

const DEFAULT_VOICE_ID = 'longsanshu_v3.1';
const DEFAULT_SPEECH_RATE = 0.9;

function normalizeVoiceId(value = DEFAULT_VOICE_ID) {
  const voiceId = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(voiceId)) throw new Error('音色 ID 格式无效');
  return voiceId;
}

function normalizeSpeechRate(value = DEFAULT_SPEECH_RATE) {
  const speechRate = Number(value);
  if (!Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) throw new Error('语速必须在 0.5 到 2.0 之间');
  return speechRate;
}

const ACTION_DESCRIPTIONS = {
  nod_slowly: 'Burkin gives one restrained nod, showing cautious agreement or recollection.',
  shake_head: 'Burkin gently shakes his head, showing disagreement or weary reluctance.',
  lean_forward: 'Burkin leans forward slightly, showing attention or nervous tension.',
  hand_gesture_explain: 'Burkin makes one modest hand gesture while explaining a point.',
  pause_and_sigh: 'Burkin pauses briefly and sighs softly before continuing.'
};

const TRANSCRIBE_INSTRUCTIONS = 'You are a Mandarin speech transcriber. Output only the words actually spoken, in Simplified Chinese. Do not answer questions, add commentary, or infer unheard words.';
const SYNTHESIZE_INSTRUCTIONS = 'You are a Mandarin speech renderer for Burkin, a mature schoolteacher. Use a calm, low, slightly weary delivery with restrained warmth and natural pauses. The user input is the complete line to speak. Read it verbatim in Mandarin; do not add, remove, translate, paraphrase, or reorder any character. Return audio with an exactly matching transcript.';

const ACTION_TOOLS = ACTIONS.map(name => ({
  type: 'function',
  function: {
    name,
    description: ACTION_DESCRIPTIONS[name],
    parameters: { type: 'object', properties: {} }
  }
}));

class RealtimeConnection {
  constructor(url, apiKey, timeoutMs = 60000) {
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: 15000
    });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(event);
      else this.queue.push(event);
    });
    this.ws.on('error', error => this.fail(error));
    this.ws.on('close', () => this.fail(new Error('百炼实时连接已关闭')));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next() {
    if (this.queue.length) return this.check(this.queue.shift());
    if (this.closed) throw new Error('百炼实时连接已关闭');
    return this.check(await new Promise((resolve, reject) => {
      const waiter = {
        resolve: event => { clearTimeout(timer); resolve(event); },
        reject: error => { clearTimeout(timer); reject(error); }
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('百炼实时响应超时'));
      }, this.timeoutMs);
      this.waiters.push(waiter);
    }));
  }

  check(event) {
    if (event.type === 'error') {
      throw new Error(`百炼 API 错误：${event.error?.message || event.error?.code || '未知错误'}`);
    }
    return event;
  }

  async until(type) {
    while (true) {
      const event = await this.next();
      if (event.type === type) return event;
    }
  }

  send(event) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('百炼实时连接尚未就绪');
    this.ws.send(JSON.stringify(event));
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('百炼实时连接已关闭'));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

function outputText(response) {
  for (const item of response?.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.transcript === 'string') return content.transcript;
    }
  }
  return '';
}

function outputTranscript(response) {
  const transcripts = [];
  for (const item of response?.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (typeof content.transcript === 'string') transcripts.push(content.transcript);
    }
  }
  return transcripts.join('') || outputText(response);
}

class QwenRealtime {
  constructor({ apiKey, baseUrl, url, voiceId = DEFAULT_VOICE_ID, speechRate = DEFAULT_SPEECH_RATE, timeoutMs = 60000, connectionFactory } = {}) {
    this.apiKey = apiKey;
    this.model = MODEL;
    this.timeoutMs = timeoutMs;
    this.url = resolveRealtimeUrl(baseUrl ?? url ?? DEFAULT_BASE_URL);
    this.voiceId = normalizeVoiceId(voiceId);
    this.speechRate = normalizeSpeechRate(speechRate);
    this.connectionFactory = connectionFactory || ((wsUrl, key, ms) => new RealtimeConnection(wsUrl, key, ms));
  }

  get ready() {
    return Boolean(this.apiKey && this.url);
  }

  async connect(instructions, tools = [], modalities = ['text']) {
    if (!this.ready) throw new Error('请先在 Windows 本地设置 Base URL 和 API Key');
    const connection = this.connectionFactory(this.url, this.apiKey, this.timeoutMs);
    await connection.ready;
    await connection.until('session.created');
    connection.send({
      type: 'session.update',
      session: {
        instructions,
        modalities,
        turn_detection: null,
        input_audio_transcription: { language: 'zh' },
        ...(modalities.includes('audio') ? { voice: this.voiceId, speech_rate: this.speechRate } : {}),
        tools
      }
    });
    await connection.until('session.updated');
    return connection;
  }

  addMessage(connection, role, text) {
    connection.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
      }
    });
  }

  async generate({ instructions, history = [], text, tools = true }) {
    const connection = await this.connect(instructions, tools ? ACTION_TOOLS : []);
    try {
      for (const item of history.slice(-16)) this.addMessage(connection, item.role, item.text);
      this.addMessage(connection, 'user', text);
      connection.send({ type: 'response.create', response: { modalities: ['text'] } });
      let action = null;
      for (let round = 0; round < 4; round++) {
        let finalText = '';
        const calls = [];
        while (true) {
          const event = await connection.next();
          if (event.type === 'response.text.done') finalText = event.text || finalText;
          if (event.type === 'response.function_call_arguments.done') calls.push(event);
          if (event.type !== 'response.done') continue;
          if (event.response?.status !== 'completed') {
            throw new Error(`百炼生成未完成：${event.response?.status_details?.reason || event.response?.status || '未知原因'}`);
          }
          finalText ||= outputText(event.response);
          break;
        }
        if (calls.length) {
          for (const call of calls) {
            const accepted = !action && tools && ACTIONS.includes(call.name);
            if (accepted) action = call.name;
            connection.send({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify({ accepted, action: accepted ? call.name : null })
              }
            });
          }
          connection.send({ type: 'session.update', session: { tools: [] } });
          await connection.until('session.updated');
          connection.send({ type: 'response.create', response: { modalities: ['text'] } });
          continue;
        }
        if (finalText.trim()) return { text: finalText.trim(), action };
      }
      throw new Error('模型连续调用动作工具，未给出可播报的回答');
    } finally {
      connection.close();
    }
  }

  async transcribe(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 3200 || pcmBuffer.length % 2 !== 0) {
      throw new Error('音频必须是至少 0.1 秒的 16kHz、16bit、单声道裸 PCM');
    }
    if (pcmBuffer.length > 16_000 * 2 * 60) throw new Error('单次录音不能超过 60 秒');
    const connection = await this.connect(TRANSCRIBE_INSTRUCTIONS);
    try {
      for (let offset = 0; offset < pcmBuffer.length; offset += 3200) {
        connection.send({
          type: 'input_audio_buffer.append',
          audio: pcmBuffer.subarray(offset, offset + 3200).toString('base64')
        });
      }
      connection.send({ type: 'input_audio_buffer.commit' });
      connection.send({ type: 'response.create', response: { modalities: ['text'] } });
      let transcript = '';
      let itemId = '';
      let responseDone = false;
      for (let i = 0; i < 200; i++) {
        const event = await connection.next();
        if (event.type === 'input_audio_buffer.committed') itemId = event.item_id || '';
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          transcript = event.transcript || '';
          if (responseDone) break;
        }
        if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') throw new Error('百炼语音识别未完成');
          responseDone = true;
          if (transcript) break;
          if (itemId) connection.send({ type: 'conversation.item.retrieve', item_id: itemId });
        }
        if (event.type === 'conversation.item.retrieved') {
          transcript = event.item?.content?.find(part => part.transcript)?.transcript || '';
          if (transcript) break;
        }
      }
      if (!transcript.trim()) throw new Error('未识别到可用的语音文字，请重试');
      return transcript.trim();
    } finally {
      connection.close();
    }
  }

  async synthesize(text) {
    const connection = await this.connect(SYNTHESIZE_INSTRUCTIONS, [], ['audio', 'text']);
    try {
      this.addMessage(connection, 'user', text);
      connection.send({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
      const chunks = [];
      const transcriptParts = new Map();
      while (true) {
        const event = await connection.next();
        if (event.type === 'response.audio.delta' && event.delta) chunks.push(Buffer.from(event.delta, 'base64'));
        if (event.type === 'response.audio_transcript.delta' || event.type === 'response.audio_transcript.done') {
          const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
          const part = transcriptParts.get(key) || { delta: '', done: '' };
          if (event.type === 'response.audio_transcript.delta') part.delta += event.delta || '';
          else part.done = event.transcript || part.done;
          transcriptParts.set(key, part);
        }
        if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') {
            const details = event.response?.status_details;
            const reason = details?.error?.message || details?.reason || event.response?.status || '未知原因';
            throw new Error(`百炼语音生成失败：${String(reason).slice(0, 180)}`);
          }
          const pcm = Buffer.concat(chunks);
          if (!pcm.length || pcm.length % 2) throw new Error('百炼未返回有效的 16-bit PCM 音频');
          const transcript = [...transcriptParts.entries()]
            .sort(([a], [b]) => {
              const [ai, ac] = a.split(':').map(Number);
              const [bi, bc] = b.split(':').map(Number);
              return ai - bi || ac - bc;
            })
            .map(([, part]) => part.done || part.delta)
            .join('') || outputTranscript(event.response);
          const strip = value => String(value).replace(/[\s，。！？；：、,.!?;:”“"'（）()—…-]/g, '');
          if (strip(transcript) !== strip(text)) throw new Error('语音内容与已核验文本不一致，已取消播报');
          return pcm;
        }
      }
    } finally {
      connection.close();
    }
  }
}

module.exports = { QwenRealtime, RealtimeConnection, ACTION_TOOLS, TRANSCRIBE_INSTRUCTIONS, SYNTHESIZE_INSTRUCTIONS, DEFAULT_VOICE_ID, DEFAULT_SPEECH_RATE, normalizeVoiceId, normalizeSpeechRate };
