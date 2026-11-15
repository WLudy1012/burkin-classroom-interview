const bridge = window.digitalHuman;
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'connection-status', 'settings-button', 'webui-button', 'fullscreen-button', 'scene-stage', 'scene-label', 'stage-state', 'stage-placeholder',
  'avatar-stage', 'stage-indicator', 'session-indicator', 'reset-button', 'transcript',
  'empty-conversation', 'notice', 'start-button', 'voice-controls', 'mic-button', 'mic-label',
  'recording-time', 'voice-hint', 'text-form', 'text-input', 'text-send', 'teacher-button', 'activity-button', 'activity-count',
  'activity-panel', 'activity-close', 'activity-list', 'teacher-panel', 'teacher-close',
  'verify-next', 'verify-state', 'teacher-results', 'settings-panel', 'settings-close',
  'settings-form', 'base-url', 'api-key', 'token-state', 'clear-token', 'settings-save',
  'voice-preset', 'custom-voice-wrap', 'custom-voice-id', 'speech-rate', 'speech-rate-value',
  'preview-voice', 'clone-voice', 'check-pending-voice', 'voice-state', 'voice-name',
].map((id) => [id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), byId(id)]));

const actionNames = {
  nod_slowly: '缓缓点头',
  shake_head: '轻轻摇头',
  lean_forward: '身体前倾',
  hand_gesture_explain: '抬手解释',
  pause_and_sigh: '停顿叹息',
};

const sceneLabels = {
  study: '现场访谈 · 访谈室',
  street: '文本情境 · 骑车街道',
  stairwell: '文本情境 · 旧宅楼梯',
  cemetery: '文本情境 · 墓园归途',
  archive: '教师核验 · 资料室',
};

const voiceLabels = {
  'longsanshu_v3.1': '布尔金 · 沉稳男声',
  'longanzhi_v3.1': '温和男声 · 龙安智',
  'longhan_v3.1': '温暖男声 · 龙寒',
  'longanqian_v3.1': '千问原默认音色',
};

function sceneForText(text) {
  const value = String(text || '');
  if (/葬礼|送葬|出殡|墓地|墓园|墓穴|坟墓|下葬|安葬|funeral|cemetery/i.test(value)) return 'cemetery';
  if (/楼梯|楼道|推下楼|摔下楼|跌下楼|stair/i.test(value)) return 'stairwell';
  if (/自行车|骑车|骑行|脚踏车|单车|bicycle|bike/i.test(value)) return 'street';
  return null;
}

let narrativeScene = 'study';

function setScene(scene) {
  const next = sceneLabels[scene] ? scene : 'study';
  if (ui.sceneStage.dataset.scene === next) return;
  ui.sceneStage.dataset.scene = next;
  ui.sceneLabel.textContent = sceneLabels[next];
}

function setNarrativeScene(scene) {
  narrativeScene = sceneLabels[scene] && scene !== 'archive' ? scene : 'study';
  if (!currentVerifying) setScene(narrativeScene);
}

let sessionStarted = false;
let sessionRevision = 0;
let busy = false;
let recording = null;
let verifyNext = false;
let currentVerifying = false;
let settingsSnapshot = null;
let pendingTranscript = '';
let lastSpeechError = '';
let actionTimer;
let lastAction = { name: '', at: 0 };
let audioContext;
let playbackAnalyser;
let playbackLevels;
let speechFrame;
let lastSpeechSampleAt = 0;
let lastSpeechLevel = '0';
let nextAudioTime = 0;
const activeSources = new Set();
const activity = [];

function timeLabel() {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function setNotice(message = '') { ui.notice.textContent = message; }

function logActivity(title, detail = '') {
  activity.unshift({ title, detail, time: timeLabel() });
  if (activity.length > 16) activity.length = 16;
  ui.activityCount.textContent = String(activity.length);
  ui.activityList.replaceChildren(...activity.map((item) => {
    const row = document.createElement('div');
    row.className = 'activity-item';
    const time = document.createElement('time');
    time.textContent = item.time;
    const copy = document.createElement('div');
    const titleElement = document.createElement('strong');
    titleElement.textContent = item.title;
    const detailElement = document.createElement('p');
    detailElement.textContent = item.detail;
    copy.append(titleElement, detailElement);
    row.append(time, copy);
    return row;
  }));
}

function setConnection(label, kind = '') {
  ui.connectionStatus.className = `connection-status ${kind}`.trim();
  ui.connectionStatus.lastElementChild.textContent = label;
}

function updateTextUi() {
  const available = sessionStarted && !busy && !recording;
  ui.textInput.disabled = !available;
  ui.textSend.disabled = !available || !ui.textInput.value.trim();
}

function setBusy(value, label = '') {
  busy = value;
  ui.startButton.disabled = value;
  ui.resetButton.disabled = value || !sessionStarted;
  ui.micButton.disabled = value && !recording;
  ui.verifyNext.disabled = value;
  updateTextUi();
  if (label) setNotice(label);
}

function addMessage(role, copy, pending = false) {
  if (!copy) return null;
  ui.emptyConversation.hidden = true;
  const article = document.createElement('article');
  article.className = `message ${role}${pending ? ' pending' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'student' ? '学生提问' : '布尔金回答';
  const paragraph = document.createElement('p');
  paragraph.className = 'message-copy';
  paragraph.textContent = copy;
  article.append(meta, paragraph);
  ui.transcript.append(article);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return article;
}

function addTeacherResult(question, answer, source) {
  const card = document.createElement('section');
  card.className = 'teacher-result';
  const q = document.createElement('p');
  q.className = 'question';
  q.textContent = question || '语音核验';
  const a = document.createElement('p');
  a.className = 'answer';
  a.textContent = answer || '本轮未取得核验结果。';
  card.append(q, a);
  if (source) {
    const s = document.createElement('p');
    s.className = 'source';
    s.textContent = typeof source === 'string' ? source : JSON.stringify(source);
    card.append(s);
  }
  ui.teacherResults.prepend(card);
}

function openPanel(name) {
  for (const panel of [ui.activityPanel, ui.teacherPanel, ui.settingsPanel]) panel.hidden = panel !== name;
  ui.activityButton.setAttribute('aria-expanded', String(!ui.activityPanel.hidden));
}

function closePanels() { openPanel(null); }

function updateVerifyUi() {
  ui.verifyNext.textContent = verifyNext ? '取消下一轮核验' : '下一轮提问进行核验 ↗';
  ui.verifyState.textContent = verifyNext ? '已准备：下一次提问将进入教师核验' : '当前为学生访谈模式';
  ui.teacherButton.classList.toggle('is-armed', verifyNext);
  ui.voiceHint.textContent = verifyNext ? '核验模式：说完后再点击一次，人物形象会暂停表演。' : '说完后再点击一次，布尔金会回答你的问题。';
  ui.textInput.placeholder = verifyNext ? '写下需要核验的文本问题' : '也可以在这里写下你的问题';
  ui.textSend.setAttribute('aria-label', verifyNext ? '发送文字核验问题' : '发送文字提问');
  if (!recording) ui.micLabel.textContent = verifyNext ? '点击开始教师核验' : '点击开始提问';
}

function setAction(action) {
  const name = typeof action === 'string' ? action : action?.name;
  if (!actionNames[name] || currentVerifying) return;
  if (lastAction.name === name && Date.now() - lastAction.at < 700) return;
  lastAction = { name, at: Date.now() };
  clearTimeout(actionTimer);
  ui.avatarStage.classList.remove('is-thinking');
  ui.avatarStage.dataset.action = name;
  ui.stageIndicator.textContent = actionNames[name];
  logActivity('人物动作', actionNames[name]);
  actionTimer = setTimeout(() => {
    delete ui.avatarStage.dataset.action;
    if (!currentVerifying) ui.stageIndicator.textContent = activeSources.size ? '正在回答' : '等待提问';
  }, name === 'pause_and_sigh' ? 2500 : 2000);
}

async function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    playbackAnalyser = audioContext.createAnalyser();
    playbackAnalyser.fftSize = 512;
    playbackLevels = new Float32Array(playbackAnalyser.fftSize);
    playbackAnalyser.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}

function stopSpeechMotion() {
  if (speechFrame) cancelAnimationFrame(speechFrame);
  speechFrame = 0;
  lastSpeechSampleAt = 0;
  lastSpeechLevel = '0';
  ui.avatarStage.style.setProperty('--speech-level', '0');
}

function startSpeechMotion() {
  if (speechFrame || currentVerifying) return;
  const update = (timestamp) => {
    if (!activeSources.size || currentVerifying) { stopSpeechMotion(); return; }
    if (!lastSpeechSampleAt || timestamp - lastSpeechSampleAt >= 33) {
      playbackAnalyser.getFloatTimeDomainData(playbackLevels);
      let energy = 0;
      for (const sample of playbackLevels) energy += sample * sample;
      const rms = Math.sqrt(energy / playbackLevels.length);
      const level = String(Math.min(.95, Math.max(0, (rms - .012) * 12)).toFixed(2));
      if (level !== lastSpeechLevel) {
        ui.avatarStage.style.setProperty('--speech-level', level);
        lastSpeechLevel = level;
      }
      lastSpeechSampleAt = timestamp;
    }
    speechFrame = requestAnimationFrame(update);
  };
  speechFrame = requestAnimationFrame(update);
}

function stopPlayback() {
  for (const source of activeSources) { try { source.stop(); } catch {} }
  activeSources.clear();
  nextAudioTime = 0;
  stopSpeechMotion();
  ui.avatarStage.classList.remove('is-speaking');
}

async function playPcm(base64, sampleRate = 24000, preview = false) {
  if (!base64) return;
  const context = await ensureAudioContext();
  const binary = atob(base64);
  const sampleCount = Math.floor(binary.length / 2);
  const buffer = context.createBuffer(1, sampleCount, sampleRate);
  const float = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let value = lo | (hi << 8);
    if (value & 0x8000) value -= 0x10000;
    float[i] = value / 32768;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackAnalyser);
  const when = Math.max(context.currentTime + .025, nextAudioTime);
  nextAudioTime = when + buffer.duration;
  activeSources.add(source);
  if (!preview) ui.avatarStage.classList.remove('is-thinking');
  if (!preview && !currentVerifying) {
    ui.avatarStage.classList.add('is-speaking');
    startSpeechMotion();
  }
  if (!preview) ui.stageIndicator.textContent = currentVerifying ? '教师核验中' : '正在回答';
  source.onended = () => {
    activeSources.delete(source);
    source.disconnect();
    if (!activeSources.size && !preview) {
      ui.avatarStage.classList.remove('is-speaking');
      stopSpeechMotion();
      if (!busy) ui.stageIndicator.textContent = currentVerifying ? '核验已完成' : '等待提问';
    }
  };
  source.start(when);
}

function handleRuntimeEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'session_reset' || event.type === 'resetRequired') {
    const revision = ++sessionRevision;
    Promise.resolve(returnToWelcome()).then(loadSettings).then(settings => {
      if (revision !== sessionRevision) return;
      setBusy(false);
      setConnection(settings.hasApiKey ? '模型已配置' : '待配置', settings.hasApiKey ? 'is-ready' : 'is-error');
      setNotice('模型设置已在另一界面更新，请重新开始访谈。');
    }).catch(error => {
      if (revision !== sessionRevision) return;
      setBusy(false);
      setNotice(error.message || '会话同步失败，请刷新界面。');
    });
    return;
  }
  if (event.type === 'audio') playPcm(event.pcmBase64 || event.audioBase64, event.sampleRate || 24000).catch((error) => setNotice(error.message));
  if (event.type === 'action') setAction(event.action || event.name);
  if (event.type === 'mode') {
    currentVerifying = Boolean(event.teacherMode);
    ui.avatarStage.classList.toggle('is-verifying', currentVerifying);
    if (currentVerifying) {
      setScene('archive');
      ui.avatarStage.classList.remove('is-listening', 'is-thinking', 'is-speaking');
      stopSpeechMotion();
      delete ui.avatarStage.dataset.action;
      ui.stageIndicator.textContent = '教师核验中';
      logActivity('进入教师核验', '人物表演已暂停');
    } else setScene(narrativeScene);
  }
  if (event.type === 'transcription') {
    pendingTranscript = event.text || event.transcription || pendingTranscript;
    if (!currentVerifying) setNarrativeScene(sceneForText(pendingTranscript) || 'study');
  }
  if (event.type === 'status') {
    if (event.status === 'thinking' || event.status === 'connecting') lastSpeechError = '';
    if (event.status === 'thinking' && sessionStarted && !currentVerifying) ui.avatarStage.classList.add('is-thinking');
    if (['connected', 'ready', 'error', 'idle', 'speech_failed'].includes(event.status)) ui.avatarStage.classList.remove('is-thinking');
    const names = { connecting: '连接模型中', connected: '模型已连接', thinking: '正在思考', ready: '模型已连接', error: '连接异常', idle: '待开始', speech_failed: '语音播报失败' };
    const label = names[event.status] || event.status;
    setConnection(label, event.status === 'error' || event.status === 'speech_failed' ? 'is-error' : (event.status === 'connected' || event.status === 'ready' ? 'is-ready' : ''));
    if (event.status === 'speech_failed') {
      lastSpeechError = String(event.message || '模型未返回可播放的音频').replace(/\s+/g, ' ').slice(0, 120);
      setNotice(`语音播报失败：${lastSpeechError}`);
      logActivity('语音播报失败', event.message || '模型未返回与字幕一致的音频');
    }
  }
}

function setSession(opening) {
  sessionStarted = true;
  setNarrativeScene('study');
  ui.avatarStage.classList.remove('is-listening', 'is-thinking', 'is-verifying');
  ui.startButton.hidden = true;
  ui.voiceControls.hidden = false;
  ui.textForm.hidden = false;
  updateTextUi();
  ui.stagePlaceholder.hidden = true;
  ui.avatarStage.hidden = false;
  ui.resetButton.disabled = false;
  ui.stageState.textContent = '访谈进行中';
  ui.stageIndicator.textContent = activeSources.size ? '正在回答' : '等待提问';
  ui.sessionIndicator.textContent = '访谈进行中';
  if (opening) addMessage('assistant', opening);
  setConnection('模型已连接', 'is-ready');
  setNotice('可点击话筒说出问题，也可以输入文字提问。');
}

function updateSpeechStatus(result) {
  if (result?.audioReady === false) setConnection('语音播报失败', 'is-error');
  else if (result?.audioReady === true) setConnection('模型已连接', 'is-ready');
}

async function returnToWelcome() {
  if (recording) await stopRecording(false);
  sessionStarted = false;
  verifyNext = false;
  currentVerifying = false;
  setNarrativeScene('study');
  updateVerifyUi();
  stopPlayback();
  ui.avatarStage.classList.remove('is-listening', 'is-thinking');
  ui.stagePlaceholder.hidden = false;
  ui.avatarStage.hidden = true;
  ui.avatarStage.classList.remove('is-verifying');
  ui.startButton.hidden = false;
  ui.voiceControls.hidden = true;
  ui.textForm.hidden = true;
  ui.textInput.value = '';
  updateTextUi();
  ui.resetButton.disabled = true;
  ui.transcript.replaceChildren(ui.emptyConversation);
  ui.emptyConversation.hidden = false;
  ui.stageIndicator.textContent = '待开始';
  ui.stageState.textContent = '待开始';
  ui.sessionIndicator.textContent = '尚未建立会话';
}

async function startSession() {
  if (busy) return;
  const revision = sessionRevision;
  setBusy(true, '正在连接千问实时语音模型…');
  try {
    await ensureAudioContext();
    if (revision !== sessionRevision) return;
    const result = await bridge.startSession();
    if (revision !== sessionRevision) return;
    if (!result?.opening) throw new Error('角色开场白缺失，请重新开始访谈');
    setSession(result.opening);
    updateSpeechStatus(result);
    if (result?.audioReady === false) setNotice(`开场白已显示，语音播报失败：${lastSpeechError || '模型未返回可播放的音频'}`);
    logActivity('访谈开始', '布尔金进入现场');
  } catch (error) {
    if (revision !== sessionRevision) return;
    setNotice(error.message || '访谈启动失败');
    setConnection('连接失败', 'is-error');
    logActivity('连接失败', error.message || '请检查模型设置');
    if (/设置|API Key|Base URL/.test(error.message || '')) openPanel(ui.settingsPanel);
  } finally {
    if (revision === sessionRevision) setBusy(false);
  }
}

async function resetSession() {
  if (busy) return;
  const revision = sessionRevision;
  if (recording) await stopRecording(false);
  if (revision !== sessionRevision) return;
  stopPlayback();
  clearTimeout(actionTimer);
  delete ui.avatarStage.dataset.action;
  ui.avatarStage.classList.remove('is-listening', 'is-thinking');
  currentVerifying = false;
  setNarrativeScene('study');
  verifyNext = false;
  updateVerifyUi();
  ui.textInput.value = '';
  updateTextUi();
  setBusy(true, '正在开启新的访谈…');
  try {
    const result = await bridge.resetSession();
    if (revision !== sessionRevision) return;
    if (!result?.opening) throw new Error('角色开场白缺失，请重新开始访谈');
    ui.transcript.replaceChildren(ui.emptyConversation);
    ui.emptyConversation.hidden = true;
    ui.teacherResults.replaceChildren();
    addMessage('assistant', result.opening);
    ui.avatarStage.classList.remove('is-verifying');
    ui.stageIndicator.textContent = '等待提问';
    updateSpeechStatus(result);
    setNotice(result?.audioReady === false ? `新访谈已开始，语音播报失败：${lastSpeechError || '模型未返回可播放的音频'}` : '新访谈已开始。');
    logActivity('访谈重置', '旧对话上下文已清空');
  } catch (error) {
    if (revision !== sessionRevision) return;
    setNotice(error.message || '重置失败');
    logActivity('重置失败', error.message || '');
  } finally {
    if (revision === sessionRevision) setBusy(false);
  }
}

function resampleToPcm16(chunks, inputRate) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const source = new Float32Array(total);
  let position = 0;
  for (const chunk of chunks) { source.set(chunk, position); position += chunk.length; }
  const outputLength = Math.floor(total * 16000 / inputRate);
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * inputRate / 16000);
    const end = Math.max(start + 1, Math.floor((index + 1) * inputRate / 16000));
    let sum = 0;
    for (let sample = start; sample < Math.min(end, total); sample++) sum += source[sample];
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, Math.min(end, total) - start)));
    output[index] = value < 0 ? value * 32768 : value * 32767;
  }
  return output;
}

function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const parts = [];
  for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(parts.join(''));
}

async function startRecording() {
  if (!sessionStarted || busy || recording) return;
  const revision = sessionRevision;
  try {
    await ensureAudioContext();
    if (revision !== sessionRevision) return;
    stopPlayback();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (revision !== sessionRevision) { stream.getTracks().forEach(track => track.stop()); return; }
    currentVerifying = verifyNext;
    if (currentVerifying) setScene('archive');
    else setScene(narrativeScene);
    ui.avatarStage.classList.toggle('is-verifying', currentVerifying);
    ui.avatarStage.classList.toggle('is-listening', !currentVerifying);
    ui.avatarStage.classList.remove('is-thinking');
    if (!currentVerifying) ui.stageIndicator.textContent = '正在听取提问';
    else ui.stageIndicator.textContent = '教师核验录音中';
    const captureContext = new AudioContext();
    const source = captureContext.createMediaStreamSource(stream);
    const processor = captureContext.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor);
    processor.connect(captureContext.destination);
    recording = { stream, captureContext, source, processor, chunks, started: Date.now(), timer: null };
    updateTextUi();
    ui.micButton.classList.add('is-recording');
    ui.micButton.setAttribute('aria-pressed', 'true');
    ui.micLabel.textContent = '正在录音 · 点击结束';
    ui.recordingTime.textContent = '00:00';
    recording.timer = setInterval(() => {
      if (!recording) return;
      const elapsed = Math.floor((Date.now() - recording.started) / 1000);
      ui.recordingTime.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      if (elapsed >= 45) stopRecording(true);
    }, 300);
    setNotice('录音中。说完后再次点击话筒。');
  } catch (error) {
    if (revision !== sessionRevision) return;
    ui.avatarStage.classList.remove('is-listening');
    setNotice(error.name === 'NotAllowedError' ? '没有麦克风权限，请在 Windows 设置中允许应用使用麦克风。' : (error.message || '无法启动麦克风'));
    logActivity('麦克风不可用', error.message || '');
  }
}

function showQuestionResult(result, mode, fallbackQuestion) {
  updateSpeechStatus(result);
  const teacherMode = Boolean(result?.teacherMode) || mode === 'verify';
  const question = result?.transcription || fallbackQuestion || pendingTranscript || '提问';
  const answer = result?.reply || '';
  currentVerifying = teacherMode;
  if (teacherMode) setScene('archive');
  else setNarrativeScene(sceneForText(question) || sceneForText(answer) || 'study');
  ui.avatarStage.classList.toggle('is-verifying', teacherMode);
  if (teacherMode) {
    addTeacherResult(question, answer, result?.source);
    ui.stageIndicator.textContent = '核验已完成';
    setNotice(result?.audioReady === false ? `核验已显示，语音播报失败：${lastSpeechError || '模型未返回可播放的音频'}` : '教师核验已完成，下一轮自动返回访谈。');
    openPanel(ui.teacherPanel);
    logActivity('教师核验完成', question);
  } else {
    addMessage('student', question);
    addMessage('assistant', answer || '本轮没有取得回答，请再试一次。');
    if (!activeSources.size) ui.stageIndicator.textContent = '等待提问';
    setNotice(result?.audioReady === false ? `回答字幕已显示，语音播报失败：${lastSpeechError || '模型未返回可播放的音频'}` : '可以继续追问。');
    if (result?.action) setAction(result.action);
  }
  verifyNext = false;
  updateVerifyUi();
}

function restoreAfterQuestionError(mode) {
  currentVerifying = false;
  ui.avatarStage.classList.remove('is-thinking', 'is-verifying');
  setScene(narrativeScene);
  ui.stageIndicator.textContent = '等待提问';
  if (mode === 'verify') verifyNext = true;
  updateVerifyUi();
}

async function stopRecording(submit) {
  if (!recording) return;
  const revision = sessionRevision;
  const capture = recording;
  recording = null;
  setBusy(true, submit ? '正在处理录音…' : '');
  clearInterval(capture.timer);
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.processor.onaudioprocess = null;
  capture.stream.getTracks().forEach((track) => track.stop());
  await capture.captureContext.close();
  ui.micButton.classList.remove('is-recording');
  ui.avatarStage.classList.remove('is-listening');
  ui.micButton.setAttribute('aria-pressed', 'false');
  updateVerifyUi();
  if (revision !== sessionRevision) return;
  if (!submit) { setBusy(false); return; }
  const pcm = resampleToPcm16(capture.chunks, capture.captureContext.sampleRate);
  if (pcm.length < 8000) { setNotice('录音太短，请至少说半秒后再结束。'); setBusy(false); return; }
  const mode = verifyNext ? 'verify' : 'role';
  pendingTranscript = '';
  setBusy(true, '正在识别问题并生成回答…');
  ui.avatarStage.classList.toggle('is-thinking', !currentVerifying);
  ui.stageIndicator.textContent = '正在思考';
  try {
    const result = await bridge.sendVoice(pcmToBase64(pcm), mode);
    if (revision !== sessionRevision) return;
    showQuestionResult(result, mode, pendingTranscript || '语音提问');
  } catch (error) {
    if (revision !== sessionRevision) return;
    setNotice(error.message || '语音提问失败，请重试');
    logActivity('语音提问失败', error.message || '');
    restoreAfterQuestionError(mode);
  } finally {
    if (revision === sessionRevision) {
      ui.avatarStage.classList.remove('is-thinking');
      setBusy(false);
    }
  }
}

async function sendText() {
  if (!sessionStarted || busy || recording) return;
  const revision = sessionRevision;
  const question = ui.textInput.value.trim();
  if (!question) return;
  const mode = verifyNext ? 'verify' : 'role';
  const teacherMode = mode === 'verify' || /^教师核验\s*[：:，,。]?/.test(question);
  pendingTranscript = '';
  stopPlayback();
  currentVerifying = teacherMode;
  ui.avatarStage.classList.toggle('is-verifying', teacherMode);
  ui.avatarStage.classList.toggle('is-thinking', !teacherMode);
  if (teacherMode) setScene('archive');
  else setNarrativeScene(sceneForText(question) || 'study');
  ui.stageIndicator.textContent = teacherMode ? '教师核验中' : '正在思考';
  setBusy(true, '正在生成文字提问的回答…');
  try {
    const result = await bridge.sendText(question, mode);
    if (revision !== sessionRevision) return;
    showQuestionResult(result, mode, question);
    ui.textInput.value = '';
  } catch (error) {
    if (revision !== sessionRevision) return;
    setNotice(error.message || '文字提问失败，请重试');
    logActivity('文字提问失败', error.message || '');
    restoreAfterQuestionError(mode);
  } finally {
    if (revision === sessionRevision) {
      ui.avatarStage.classList.remove('is-thinking');
      setBusy(false);
      ui.textInput.focus();
    }
  }
}

async function loadSettings() {
  const settings = await bridge.getSettings();
  settingsSnapshot = settings;
  ui.baseUrl.value = settings.baseUrl || '';
  ui.apiKey.value = '';
  ui.tokenState.textContent = settings.keyPersistence === 'memory'
    ? (settings.hasApiKey ? '本次运行已配置 API Key；留空可保持当前密钥。' : '本次运行尚未配置 API Key。')
    : (settings.hasApiKey ? '已保存 API Key；留空可保持当前密钥。' : '尚未保存 API Key。');
  const voiceId = settings.voiceId || 'longsanshu_v3.1';
  ui.voicePreset.value = voiceLabels[voiceId] ? voiceId : 'custom';
  ui.customVoiceId.value = ui.voicePreset.value === 'custom' ? voiceId : '';
  ui.speechRate.value = String(settings.speechRate ?? 0.9);
  updateVoiceUi();
  ui.voiceName.textContent = voiceLabels[voiceId] || '专属复刻音色';
  ui.checkPendingVoice.hidden = !settings.pendingVoiceId;
  setVoiceState(settings.pendingVoiceId
    ? `音色 ${settings.pendingVoiceId} 正在生成，可检查状态；请勿重复导入同一录音。`
    : (ui.voicePreset.value === 'custom' ? '已填写 Flash 专属音色 ID，建议先试听确认是否可用。' : '点击导入后才会将录音发送给百炼。支持不超过 10 MB 的 WAV、MP3 或 M4A，建议 10–20 秒清晰单人语音。'));
  return settings;
}

function selectedVoiceId() {
  return ui.voicePreset.value === 'custom' ? ui.customVoiceId.value.trim() : ui.voicePreset.value;
}

function updateVoiceUi() {
  const custom = ui.voicePreset.value === 'custom';
  ui.customVoiceWrap.hidden = !custom;
  ui.customVoiceId.required = custom;
  ui.speechRateValue.value = `${Number(ui.speechRate.value).toFixed(2)} ×`;
}

function setVoiceState(message, error = false) {
  ui.voiceState.textContent = message;
  ui.voiceState.classList.toggle('is-error', error);
}

async function initialize() {
  bridge.onRuntimeEvent(handleRuntimeEvent);
  const [settings, status] = await Promise.all([loadSettings(), bridge.status()]);
  if (status.configured) {
    setConnection('模型已配置', 'is-ready');
    setNotice('点击“开始访谈”连接千问实时语音。');
  } else {
    setConnection('待配置', 'is-error');
    setNotice('请先填写 Base URL 和 API Key。');
    openPanel(ui.settingsPanel);
  }
  if (status.sessionStarted) setSession('');
  if (settings.model) byId('model-name').textContent = settings.model;
}

ui.startButton.addEventListener('click', startSession);
ui.resetButton.addEventListener('click', resetSession);
ui.micButton.addEventListener('click', () => recording ? stopRecording(true) : startRecording());
ui.textInput.addEventListener('input', updateTextUi);
ui.textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    ui.textForm.requestSubmit();
  }
});
ui.textForm.addEventListener('submit', (event) => { event.preventDefault(); sendText(); });
ui.fullscreenButton.addEventListener('click', () => bridge.toggleFullscreen());
ui.webuiButton.hidden = typeof bridge.openWebUI !== 'function';
ui.webuiButton.addEventListener('click', async () => {
  ui.webuiButton.disabled = true;
  try {
    const opened = await bridge.openWebUI();
    const url = typeof opened === 'string' ? opened : opened?.url;
    setNotice(url ? `WebUI 已在浏览器打开：${url}` : 'WebUI 已在浏览器打开。');
    logActivity('打开 WebUI', url || '本机浏览器');
  } catch (error) {
    setNotice(error.message || '打开 WebUI 失败');
  } finally {
    ui.webuiButton.disabled = false;
  }
});
ui.settingsButton.addEventListener('click', async () => { await loadSettings(); openPanel(ui.settingsPanel); });
ui.teacherButton.addEventListener('click', () => openPanel(ui.teacherPanel));
ui.activityButton.addEventListener('click', () => ui.activityPanel.hidden ? openPanel(ui.activityPanel) : closePanels());
ui.activityClose.addEventListener('click', closePanels);
ui.teacherClose.addEventListener('click', closePanels);
ui.settingsClose.addEventListener('click', closePanels);
ui.voicePreset.addEventListener('change', updateVoiceUi);
ui.speechRate.addEventListener('input', updateVoiceUi);
ui.previewVoice.addEventListener('click', async () => {
  if (!settingsSnapshot?.hasApiKey || ui.apiKey.value.trim() || ui.baseUrl.value.trim() !== settingsSnapshot.baseUrl) {
    setVoiceState('请先保存当前的 Base URL 和 API Key，再试听音色。', true);
    return;
  }
  const voiceId = selectedVoiceId();
  if (!voiceId) { setVoiceState('请填写 Flash 专属音色 ID 后再试听。', true); return; }
  ui.previewVoice.disabled = true;
  setVoiceState('正在生成音色试听，请稍候…');
  try {
    const result = await bridge.previewVoice({ voiceId, speechRate: Number(ui.speechRate.value) });
    stopPlayback();
    await playPcm(result.pcmBase64, result.sampleRate || 24000, true);
    setVoiceState('试听已开始。保存后，下一场访谈会使用当前音色和语速。');
  } catch (error) {
    setVoiceState(error.message || '音色试听失败', true);
  } finally {
    ui.previewVoice.disabled = false;
  }
});
ui.verifyNext.addEventListener('click', () => {
  verifyNext = !verifyNext;
  updateVerifyUi();
  setNotice(verifyNext ? '下一次提问将进入教师核验。' : '已返回学生访谈模式。');
  if (verifyNext) closePanels();
});
ui.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  ui.settingsSave.disabled = true;
  try {
    await bridge.saveSettings({
      baseUrl: ui.baseUrl.value,
      apiKey: ui.apiKey.value,
      voiceId: selectedVoiceId(),
      speechRate: Number(ui.speechRate.value),
    });
    await loadSettings();
    await returnToWelcome();
    closePanels();
    setConnection('模型已配置', 'is-ready');
    setNotice('设置已保存。点击“开始访谈”连接模型。');
    logActivity('模型设置已更新', '新配置将用于下一场访谈');
  } catch (error) {
    setNotice(error.message || '设置保存失败');
  } finally {
    ui.settingsSave.disabled = false;
  }
});
ui.cloneVoice.addEventListener('click', async () => {
  if (!settingsSnapshot?.hasApiKey || ui.apiKey.value.trim() || ui.baseUrl.value.trim() !== settingsSnapshot.baseUrl) {
    setVoiceState('请先保存当前的 Base URL 和 API Key，再导入参考录音。', true);
    return;
  }
  if (settingsSnapshot.pendingVoiceId) {
    setVoiceState('已有音色正在生成，请先检查状态，避免重复创建。', true);
    return;
  }
  ui.cloneVoice.disabled = true;
  ui.settingsSave.disabled = true;
  setVoiceState('正在导入录音并生成专属音色，请稍候…');
  try {
    const result = await bridge.cloneVoice();
    if (result?.canceled) { await loadSettings(); return; }
    await loadSettings();
    await returnToWelcome();
    setConnection('模型已配置', 'is-ready');
    setVoiceState('专属音色已生成并启用。下一场访谈将使用这个声音。');
    setNotice('专属音色已启用。点击“开始访谈”试听。');
    logActivity('专属音色已启用', result?.voiceId || '');
  } catch (error) {
    const refreshed = await loadSettings().catch(() => null);
    setVoiceState(refreshed?.pendingVoiceId
      ? `音色已提交，ID：${refreshed.pendingVoiceId}。请稍后检查状态，无需重复导入录音。`
      : (error.message || '音色复刻失败'), !refreshed?.pendingVoiceId);
  } finally {
    ui.cloneVoice.disabled = false;
    ui.settingsSave.disabled = false;
  }
});
ui.checkPendingVoice.addEventListener('click', async () => {
  ui.checkPendingVoice.disabled = true;
  setVoiceState('正在检查专属音色状态…');
  try {
    const result = await bridge.checkPendingVoice();
    await loadSettings();
    if (result?.status === 'OK') {
      await returnToWelcome();
      setConnection('模型已配置', 'is-ready');
      setVoiceState('专属音色已生成并启用。下一场访谈将使用这个声音。');
      setNotice('专属音色已启用。点击“开始访谈”试听。');
      logActivity('专属音色已启用', result.voiceId || '');
    } else if (result?.status === 'DEPLOYING') setVoiceState('音色仍在生成，请稍后再检查。');
    else if (result?.status === 'UNDEPLOYED') setVoiceState('音色未能完成部署，请换一段清晰录音后重新导入。', true);
    else setVoiceState('当前没有待处理的音色。');
  } catch (error) {
    setVoiceState(error.message || '音色状态检查失败', true);
  } finally {
    ui.checkPendingVoice.disabled = false;
  }
});
ui.clearToken.addEventListener('click', async () => {
  try {
    await bridge.saveSettings({ baseUrl: ui.baseUrl.value, clearApiKey: true });
    await loadSettings();
    await returnToWelcome();
    setConnection('待配置', 'is-error');
    setNotice('API Key 已清除。');
  } catch (error) { setNotice(error.message || '清除失败'); }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePanels(); });
window.addEventListener('beforeunload', () => {
  stopPlayback();
  if (recording) stopRecording(false);
});

initialize().catch((error) => {
  setConnection('初始化失败', 'is-error');
  setNotice(error.message || '初始化失败');
});
