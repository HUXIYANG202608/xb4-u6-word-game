// 数据完整性校验（与具体词数无关，适用于任意 data.js）
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'data.js'), 'utf8');
const sandbox = {};
const fn = new Function('window', code + '\nreturn (typeof XB4_DATA!=="undefined")?XB4_DATA:(window&&window.XB4_DATA);');
// 在带 window 的上下文执行
const windowObj = {};
const result = fn(windowObj);
const D = windowObj.XB4_DATA || result;
if (!D) { console.error('FAIL: XB4_DATA 未定义'); process.exit(1); }

const errors = [];
const words = D.WORDS;
if (!Array.isArray(words)) errors.push('WORDS 不是数组');
console.log('WORDS:', words.length);

const seen = new Set();
for (const w of words) {
  if (!w.word) errors.push('存在空 word');
  if (seen.has(w.word)) errors.push('重复单词: ' + w.word);
  seen.add(w.word);
  if (!['spell','choose'].includes(w.practiceType)) errors.push(w.word + ' practiceType 非法: ' + w.practiceType);
  if (![1,2,3].includes(w.difficulty)) errors.push(w.word + ' difficulty 非法: ' + w.difficulty);
  if (!Array.isArray(w.senses) || !w.senses.length) errors.push(w.word + ' 无 senses');
  w.senses.forEach((s, i) => {
    if (!s.cnDef || !s.cnDef.trim()) errors.push(w.word + ' sense#' + i + ' cnDef 空');
    if (typeof s.senseNo !== 'number') errors.push(w.word + ' sense#' + i + ' senseNo 缺失');
    if (!s.type) errors.push(w.word + ' sense#' + i + ' type 缺失');
    if (!('enDef' in s)) errors.push(w.word + ' sense#' + i + ' enDef 缺失');
    if (!('example' in s)) errors.push(w.word + ' sense#' + i + ' example 缺失');
  });
}

const spell = D.SPELL_WORDS, choose = D.READ_WORDS;
console.log('SPELL_WORDS:', spell.length, ' READ_WORDS:', choose.length);
if (spell.length + choose.length !== words.length) errors.push('SPELL+READ 数量不等于 WORDS');

const spellSet = new Set(spell.map(w => w.word));
const sentWords = new Set();
for (const s of D.SENTENCES) {
  if (!spellSet.has(s.word)) errors.push('SENTENCES 词不在拼写类: ' + s.word);
  sentWords.add(s.word);
  if (s.word.toLowerCase() !== s.word.toLowerCase()) {} // noop
  if (!s.sentence.toLowerCase().includes(s.word.toLowerCase())) errors.push('SENTENCES 句子不含目标词: ' + s.word + ' -> ' + s.sentence);
}
if (sentWords.size !== spell.length) errors.push('SENTENCES 覆盖数(' + sentWords.size + ') != 拼写类数(' + spell.length + ')');
console.log('SENTENCES:', D.SENTENCES.length);

// 难度分布
const dist = {1:0,2:0,3:0};
words.forEach(w => dist[w.difficulty]++);
console.log('难度分布:', dist);

if (errors.length) {
  console.error('\n❌ 校验失败，共 ' + errors.length + ' 处:');
  errors.slice(0, 40).forEach(e => console.error('  - ' + e));
  process.exit(1);
} else {
  console.log('\n✅ 数据校验通过：结构完整、分类自洽、句子全覆盖、无重复、无空释义。');
}
