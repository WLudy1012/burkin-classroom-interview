const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL } = require('../desktop/runtime/endpoint.cjs');
const { createClonedVoice, queryClonedVoice, waitForClonedVoice, resolveVoiceCustomizationUrl } = require('../desktop/runtime/voice-clone.cjs');

const voiceId = `${MODEL}-burkin-abc123`;

function reply(output, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return output; } };
}

test('音色创建地址沿用已配置的实时模型域名', () => {
  assert.equal(resolveVoiceCustomizationUrl('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'), 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
  assert.equal(resolveVoiceCustomizationUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/api/v1/services/audio/tts/customization');
  assert.throws(() => resolveVoiceCustomizationUrl('http://remote.example.com'), /wss 或 https/);
});

test('本地录音复刻绑定 Flash，保存 ID 后轮询至可用', async () => {
  const calls = [];
  const order = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (body.input.action === 'create_voice') return reply({ output: { voice_id: voiceId } });
    order.push('query');
    return reply({ output: { target_model: MODEL, status: calls.length === 2 ? 'DEPLOYING' : 'OK' } });
  };
  const result = await createClonedVoice({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.aliyuncs.com',
    audioBuffer: Buffer.alloc(2048, 1),
    fileName: 'reference.wav',
    fetchImpl,
    sleep: async () => order.push('sleep'),
    onCreated: async id => { assert.equal(id, voiceId); order.push('saved'); }
  });
  assert.deepEqual(result, { voiceId, status: 'OK' });
  assert.deepEqual(order, ['saved', 'query', 'sleep', 'query']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'voice-enrollment');
  assert.deepEqual(Object.keys(calls[0].body.input).sort(), ['action', 'audio', 'language_hints', 'prefix', 'target_model']);
  assert.equal(calls[0].body.input.action, 'create_voice');
  assert.equal(calls[0].body.input.target_model, MODEL);
  assert.equal(calls[0].body.input.prefix, 'burkin');
  assert.deepEqual(calls[0].body.input.language_hints, ['zh']);
  assert.equal(calls[0].body.input.audio, `data:audio/wav;base64,${Buffer.alloc(2048, 1).toString('base64')}`);
  assert.deepEqual(calls.slice(1).map(call => call.body.input), [
    { action: 'query_voice', voice_id: voiceId },
    { action: 'query_voice', voice_id: voiceId }
  ]);
});

test('无效录音在发送前被拒绝，接口错误不泄露密钥', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply({ code: 'InvalidParameter', message: 'bad sample test-key' }, 400); };
  const args = { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com', audioBuffer: Buffer.alloc(2048), fetchImpl };
  await assert.rejects(() => createClonedVoice({ ...args, fileName: 'sample.txt' }), /仅支持 WAV/);
  await assert.rejects(() => createClonedVoice({ ...args, fileName: 'sample.wav', audioBuffer: Buffer.alloc(100) }), /1 KB 到 10 MB/);
  assert.equal(calls, 0);
  await assert.rejects(() => createClonedVoice({ ...args, fileName: 'sample.mp3' }), error => {
    assert.match(error.message, /HTTP 400.*InvalidParameter/);
    assert.doesNotMatch(error.message, /test-key/);
    return true;
  });
  assert.equal(calls, 1);
});

test('查询拒绝其他模型音色，超时保留已创建 ID', async () => {
  const args = { apiKey: 'key', baseUrl: 'https://dashscope.aliyuncs.com', voiceId };
  await assert.rejects(() => queryClonedVoice({
    ...args,
    fetchImpl: async () => reply({ output: { target_model: 'qwen-audio-3.1-realtime-plus', status: 'OK' } })
  }), /模型不匹配/);
  await assert.rejects(() => waitForClonedVoice({
    ...args, attempts: 2, sleep: async () => {},
    fetchImpl: async () => reply({ output: { target_model: MODEL, status: 'DEPLOYING' } })
  }), error => {
    assert.equal(error.voiceId, voiceId);
    assert.match(error.message, /已保留音色 ID/);
    return true;
  });
});
