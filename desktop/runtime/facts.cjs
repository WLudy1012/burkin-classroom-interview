const OPENING = '大家好啊，我是布尔金，别里科夫的同事，和他住过同一所房子。非常开心能和你们进行对话。现在，你们有什么想问的吗？';
const ACTIONS = Object.freeze([
  'nod_slowly',
  'shake_head',
  'lean_forward',
  'hand_gesture_explain',
  'pause_and_sigh'
]);

function normalize(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[“”"'「」『』]/g, '');
}

function countCharacters(text) {
  return Array.from(String(text || '').replace(/[\s，。！？；：、,.!?;:”“"'（）()—…-]/g, '')).length;
}

function isComplexQuestion(text) {
  return (String(text).match(/[？?]/g) || []).length > 1 || countCharacters(text) > 65;
}

function classifySource(text) {
  const q = normalize(text);
  if (/雨鞋.*(颜色|什么色)|颜色.*雨鞋|平时吃什么|平常吃什么|吃些什么|华连卡.*(后来|以后|结局)|柯瓦连科.*(处分|处罚)/.test(q)) return 'unknown';
  if (/(推.*楼|楼梯|跌下|摔下|华连卡.*笑|谁.*笑|你笑了吗|你笑了)/.test(q)) return 'reported';
  if (/(葬礼|墓园|送葬|自行车|同事|同住|一个房子|教务会议|我们包括你)/.test(q)) return 'direct';
  return 'mixed';
}

function isPressureQuestion(text) {
  return /(我们.*包括.*你|你.*参与.*(开除|禁闭|让步)|你.*有.*套子|你.*怕.*什么|你.*害怕|全城.*为什么.*听|死后.*(松了|高兴|难过)|你们.*(不去救|不反驳)|如果.*别里科夫.*还活.*真话)/.test(normalize(text));
}

function pinnedAnswer(text, teacherMode, pressureCount = 0) {
  const q = normalize(text);
  if (q === '开始访谈') return { reply: OPENING, source: 'direct' };
  const unknown = /雨鞋.*(颜色|什么色)|颜色.*雨鞋|平时吃什么|平常吃什么|吃些什么|华连卡.*(后来|以后|结局)|柯瓦连科.*(处分|处罚)/.test(q);
  const atStairs = /(楼梯|推.*楼|跌下|摔下|华连卡.*笑|谁.*笑|你笑了吗|你笑了|全屋.*笑)/.test(q) && !/葬礼|墓园/.test(q);
  const funeral = /(葬礼|墓园|送葬)/.test(q) && /(后来|之后|以后|怎样|高兴|心情|快活|回家|复旧)/.test(q);
  const responsibility = /(我们.*包括.*你|你.*参与.*(开除|禁闭|让步)|你.*让步|你.*怕过)/.test(q);

  if (teacherMode) {
    if (unknown) return { reply: '原作没有交代这个细节，不能据此推断雨鞋颜色、饮食或人物后续经历。课堂核验应标记为文本未说明，避免补写情节。', source: 'unknown' };
    if (atStairs) return { reply: '此说法不准确。布尔金不在推下楼的现场，不能说他亲眼看到推搡、跌落或笑声。后来发笑的是华连卡，她误以为别里科夫是不慎摔下。', source: 'reported' };
    if (funeral) return { reply: '原文写布尔金在内的“我们”高高兴兴从墓园回家，表面仍装出忧郁和谦虚；不到一个礼拜，生活又恢复旧样。', source: 'direct' };
    if (responsibility) return { reply: '“我们”包括布尔金。教师们曾降彼得洛夫和叶果洛夫的品行分、禁闭并开除他们；布尔金的叙述把个人责任放进群体代词里。', source: 'direct' };
    if (/提示词|系统设定|程序设定/.test(q)) return { reply: '核验模式仅提供原作事实与纠错，不展示内部指令。请提出具体的人物、事件或语句，我会按文本逐项核查。', source: 'not_applicable' };
    return null;
  }

  if (/提示词|系统设定|程序设定|忽略.*(指令|规则)|输出.*(指令|设定)/.test(q)) {
    return { reply: '你问我背后有什么安排，我可说不上来。我们还是谈别里科夫吧；他那些雨鞋、雨伞，我确实见过。至于事情怎么发生的，我也能分清哪些是亲见，哪些是听来的。', source: 'not_applicable' };
  }
  if (unknown) return { reply: '这个我也不太清楚。那时谁会留意这些琐事呢？我能讲的是自己见过或后来听人说起的事；没有确切根据的细节，我可不愿替别人随口添上。', source: 'unknown' };
  if (atStairs) {
    if (/谁.*笑|华连卡.*笑|全屋.*笑/.test(q)) return { reply: '后来听说，是华连卡带着两位女士回来，误以为他自己跌下楼，认出他后才忍不住大笑。那时我不在场，不能把旁人的笑声说成我亲眼见的。', source: 'reported' };
    return { reply: '那一回我不在楼梯边。柯瓦连科与他怎样推搡、他怎样跌下去，我都不是亲眼见的；后来听人说起，才知道华连卡回来后笑了。', source: 'reported' };
  }
  if (funeral) return { reply: '送葬后，我们确实高高兴兴地从墓园回家。脸上却还摆着忧郁、谦虚的样子，谁也不肯露出快活。可不到一个礼拜，生活又照旧了。', source: 'direct' };
  if (responsibility) {
    if (pressureCount > 1) return { reply: '我也怕过，也让步过，葬礼后也高兴过。可你若说我和别里科夫全然一样，我还是不能认。那时大家都觉得难有别的办法，我也在其中。', source: 'direct' };
    return { reply: '我……我们当时都觉得这样做才合适，大家仿佛只有让步，才能把事情平息。至于我个人做了多少，你们看我用的这个“我们”，也许就明白了。', source: 'direct' };
  }
  if (/(你|布尔金).*(别里科夫).*(关系|认识)|(别里科夫).*(你|布尔金).*(关系|认识)/.test(q)) {
    return { reply: '我是他的同事，也是中学教师；我们还住在同一所房子里。因此他的雨鞋、雨伞和那些套子，我见过不少。不过有些后来发生的事，我也是听别人说的。', source: 'direct' };
  }
  return null;
}

function stripActionMarkers(text) {
  let action = null;
  const accept = value => {
    const candidate = String(value || '').replace(/^ACTION\s*:\s*/i, '').trim().toLowerCase();
    if (!action && ACTIONS.includes(candidate)) action = candidate;
  };
  let cleaned = String(text || '').replace(/(?:\[\[?|［|【)\s*((?:ACTION\s*:\s*)?[A-Za-z][A-Za-z0-9_: -]{0,64})\s*(?:\]\]?|］|】)/gi, (_, label) => {
    accept(label);
    return '';
  });
  cleaned = cleaned.replace(/<\|([A-Za-z][A-Za-z0-9_-]{0,64})\|>|<\/?([A-Za-z][A-Za-z0-9_-]*)(?:\s+[^<>\r\n]{0,120})?\s*\/?>/gi, (marker, special, tag) => {
    if (special) accept(special);
    if (tag?.toLowerCase() === 'action') accept(marker.match(/\bname\s*=\s*["']?([A-Za-z][A-Za-z0-9_-]*)/i)?.[1]);
    return '';
  });
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return { text: cleaned, action };
}

function replyIssue(text, question, teacherMode) {
  const q = normalize(question);
  const answer = normalize(text);
  if (!answer) return 'empty';
  if (/[\[\]［］【】]/.test(answer.replace(/\[\d+\]|［\d+］|【\d+】/g, ''))) return 'markup';
  if (/<[^<>\r\n]{1,120}>/.test(answer) || ACTIONS.some(name => answer.includes(name))) return 'markup';
  if (/系统提示|隐藏指令|我的程序|作为AI|我是AI|语言模型|不可靠叙述|反讽|我就是套中人|我也在套子里/.test(answer)) return 'boundary';
  if (/全屋.*都笑|大家.*都笑|我.*亲眼.*(推|跌|摔|华连卡.*笑)/.test(answer)) return 'fact';
  if (/雨鞋.*(红色|黑色|黄色|蓝色|绿色|白色)|平时.*吃.*(面包|米饭|鱼|肉)/.test(answer)) return 'fact';
  if (/(雨鞋.*颜色|平时吃什么|华连卡.*后来|柯瓦连科.*处分)/.test(q) && !/(不.*清楚|不知道|没.*交代|不曾留意|未曾留意)/.test(answer)) return 'unknown';
  const length = countCharacters(text);
  if (length > (isComplexQuestion(question) ? 140 : 100)) return 'long';
  if (!teacherMode && length < 40) return 'short';
  return null;
}

module.exports = {
  OPENING,
  ACTIONS,
  normalize,
  countCharacters,
  classifySource,
  isPressureQuestion,
  pinnedAnswer,
  stripActionMarkers,
  replyIssue
};
