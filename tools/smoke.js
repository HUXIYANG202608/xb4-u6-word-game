// 在 Node 中加载 data.js + core.js，验证题目生成逻辑不崩溃且结构正确
const fs = require('fs');
const vm = require('vm');
const ctx = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Math: Math, JSON: JSON, Date: Date };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../assets/js/data.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../assets/js/core.js', 'utf8'), ctx);

const C = ctx.XB4_CORE;
const opt = { minStar: 1, maxStar: 3, wrong: 3 };
const choose = C.buildChooseQuestions(ctx.READ_WORDS, opt);
const spell = C.buildSpellWordQuestions(ctx.SPELL_WORDS, opt);
const mix = C.buildMixQuestions(ctx.WORDS, opt);
const sent = C.buildSentenceQuestions(ctx.SENTENCES, opt);

function check(name, arr, mustHave, skipIfNoSource) {
  if (skipIfNoSource) { console.log('⏭ ' + name + ': 该单元无对应词类，跳过'); return; }
  if (!Array.isArray(arr) || !arr.length) { console.error('❌ ' + name + ' 为空'); process.exit(1); }
  const q0 = arr[0];
  for (const k of mustHave) if (!(k in q0)) { console.error('❌ ' + name + ' 缺少字段 ' + k); process.exit(1); }
  console.log('✅ ' + name + ': ' + arr.length + ' 题，首题字段: ' + Object.keys(q0).join(','));
}
check('choose', choose, ['word', 'options', 'testSense'], ctx.READ_WORDS.length === 0);
check('spell-word', spell, ['word'], ctx.SPELL_WORDS.length === 0);
check('mix', mix, ['word']);
check('sentence', sent, ['word', 'target', 'sentence'], ctx.SENTENCES.length === 0);

// 抽查 choose 选项：恰好 1 个正确，且正确项释义 == 被测义项
if (choose.length) {
  const q = choose[0];
  const correct = q.options.filter(function (o) { return o.correct; });
  if (correct.length !== 1) { console.error('❌ choose 正确选项数 != 1 (' + correct.length + ')'); process.exit(1); }
  if (correct[0].def !== q.testSense.cnDef) { console.error('❌ choose 正确项释义不匹配'); process.exit(1); }
  if (q.options.length < 2) { console.error('❌ choose 选项过少'); process.exit(1); }
  console.log('✅ choose 首题: word=' + q.word + ' 选项数=' + q.options.length + ' 正确项=「' + correct[0].def + '」');
}

// 抽查 sentence 挖空目标存在
if (sent.length) {
  const s0 = sent[0];
  if (!s0.sentence.toLowerCase().includes(s0.target.toLowerCase())) { console.error('❌ sentence 挖空目标不在句中'); process.exit(1); }
  console.log('✅ sentence 首题: word=' + s0.word + ' 挖空=' + s0.target);
}
console.log('✅ 题目生成逻辑全部通过（与 XB4U1 同款 core.js 正常消费新 data.js）。');
