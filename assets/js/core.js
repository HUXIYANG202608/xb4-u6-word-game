/* ============================================================
 * XB4 单词闯关 · 核心逻辑 (core)
 * ------------------------------------------------------------
 * 纯逻辑层：拼写判题、SM-2 间隔重复、题目生成、难度档等。
 * 不依赖任何 DOM / wx / 浏览器 API，可在 Node 中直接单元测试。
 * 移植自微信小程序 utils，并经 Node 测试验证。
 * ============================================================ */
(function (global) {
  'use strict';

  var SPELL_WORDS = global.SPELL_WORDS;
  var READ_WORDS = global.READ_WORDS;
  var SENTENCES = global.SENTENCES;

  /* ---------- 文本归一化与输入法检测 ---------- */
  function normalizeWord(s) {
    return String(s == null ? '' : s)
      .replace(/[\s  ᠎\u2000-\u200B\u200C-\u200F\u2028-\u202F\u205F-\u206F\u00AD\u3000]/g, '')
      .toLowerCase();
  }
  function normalizeSentence(s) {
    return String(s == null ? '' : s)
      .replace(/[  ᠎\u2000-\u200B\u200C-\u200F\u2028-\u202F\u205F-\u206F\u00AD\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    if (a.length > b.length) { var t = a; a = b; b = t; }
    var m = a.length, n = b.length;
    var dp = new Array(n + 1);
    for (var j = 0; j <= n; j++) dp[j] = j;
    for (var i = 1; i <= m; i++) {
      var prev = dp[0]; dp[0] = i;
      for (var j2 = 1; j2 <= n; j2++) {
        var tmp = dp[j2];
        if (a.charCodeAt(i - 1) === b.charCodeAt(j2 - 1)) dp[j2] = prev;
        else dp[j2] = 1 + Math.min(prev, dp[j2], dp[j2 - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }
  var RE_CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,
      RE_FULLWIDTH = /[\uFF01-\uFF5E]/,
      RE_NON_ASCII = /[^\x00-\x7F]/;
  function classifyInput(r) {
    if (!r) return { kind: 'empty', tip: null };
    if (RE_CJK.test(r)) return { kind: 'chinese', tip: '⌨️ 检测到中文/拼音——请先切换到英文输入法，再输入英文单词。' };
    if (RE_FULLWIDTH.test(r)) return { kind: 'fullwidth', tip: '⌨️ 检测到全角字符——请关闭全角、切到半角英文后重新输入。' };
    if (RE_NON_ASCII.test(r)) return { kind: 'nonascii', tip: '⌨️ 含非英文字符（如重音字母）——请确认输入法为英文。' };
    return { kind: 'none', tip: null };
  }
  function isSentence(t) {
    if (!t) return false;
    t = String(t).trim();
    if (t.length < 3) return false;
    return /^[A-Z]/.test(t) && /[.!?]["')\]}]?$/.test(t) && /\s/.test(t);
  }

  /* ---------- 拼写判题 + 错因定位 ---------- */
  function spellJudge(rawInput, rawTarget, opts) {
    opts = opts || {};
    var caseSensitive = (typeof opts.caseSensitive === 'boolean') ? opts.caseSensitive : isSentence(rawTarget);
    var cleanInput = caseSensitive ? normalizeSentence(rawInput) : normalizeWord(rawInput);
    var cleanTarget = caseSensitive ? normalizeSentence(rawTarget) : normalizeWord(rawTarget);
    var ime = classifyInput(cleanInput.toLowerCase());
    if (ime.kind === 'chinese' || ime.kind === 'fullwidth' || ime.kind === 'nonascii')
      return { correct: false, kind: 'input_method', imeTip: ime.tip, caseMismatch: false, distance: 0 };
    if (!cleanInput) return { correct: false, kind: 'empty', imeTip: null, caseMismatch: false, distance: 0 };
    if (cleanInput === cleanTarget) return { correct: true, kind: 'correct', imeTip: null, caseMismatch: false, distance: 0 };
    var caseMismatch = caseSensitive && (cleanInput.toLowerCase() === cleanTarget.toLowerCase());
    var distance = levenshtein(cleanInput, cleanTarget);
    return { correct: false, kind: 'spelling', imeTip: null, caseMismatch: caseMismatch, distance: distance };
  }
  function firstMismatch(input, target) {
    if (!input || !target || input.length !== target.length) return null;
    var lo = input.toLowerCase(), lt = target.toLowerCase();
    for (var i = 0; i < lt.length; i++) if (lo[i] !== lt[i]) return { index: i + 1, expected: lt[i], got: lo[i] };
    return null;
  }

  /* ---------- SM-2 间隔重复算法（纯函数） ---------- */
  function sm2(ease, interval, reps, quality) {
    var e = (typeof ease === 'number' && !isNaN(ease)) ? ease : 2.5;
    var iv = (typeof interval === 'number' && !isNaN(interval)) ? interval : 0;
    var r = (typeof reps === 'number' && !isNaN(reps)) ? reps : 0;
    var q = Math.max(0, Math.min(5, Math.round(quality)));
    if (q < 3) { r = 0; iv = 1; }
    else {
      if (r === 0) iv = 1;
      else if (r === 1) iv = 6;
      else iv = Math.round(iv * e);
      r = r + 1;
    }
    e = e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (e < 1.3) e = 1.3;
    return { ease: e, interval: iv, reps: r };
  }

  /* ---------- 难度档 ----------
   * 三档差异明显化（用户反馈"三层没差别"）：
   *   - 基础 easy  ：干扰字母最少(2) + 给首字母提示 → 键盘约 11 键；听音选义 3 选 1
   *   - 标准 normal：无首字母提示 + 干扰字母中等(5) → 键盘约 14 键；听音选义 4 选 1
   *   - 进阶 hard  ：无首字母提示 + 干扰字母最多(8) → 键盘约 17 键；听音选义 5 选 1
   * 词池过滤（3.1 词内分阶）：按词 difficulty 星级（1易/2中/3难）收窄词池，
   *   档内按星级升序出题 → 从易到难逐步递进。
   */
  var DIFFICULTY = {
    easy:   { key: 'easy',   label: '基础', distractors: 2, firstHint: true,  chooseWrong: 2, minStar: 1, maxStar: 2, timeFactor: 1.3, chooseTime: 15 },
    normal: { key: 'normal', label: '标准', distractors: 5, firstHint: false, chooseWrong: 3, minStar: 1, maxStar: 3, timeFactor: 1.0, chooseTime: 12 },
    hard:   { key: 'hard',   label: '进阶', distractors: 8, firstHint: false, chooseWrong: 4, minStar: 2, maxStar: 3, timeFactor: 0.85, chooseTime: 10 }
  };
  function getDifficulty(k) { return DIFFICULTY[k] || DIFFICULTY.normal; }

  /* ---------- 时间闯关：关卡限时计算（设计方案 §1） ----------
   * 拼写：基础 = 20 + 6×字母数；选择：按难度档固定。
   * 限时 = round(基础 × timeFactor × 动态系数 dynamicScale)，钳制 [30,150]。 */
  function timeForTarget(target, diffKey, type, dynamicScale) {
    var d = DIFFICULTY[diffKey] || DIFFICULTY.normal;
    var clean = String(target == null ? '' : target).replace(/[^a-zA-Z]/g, '');
    var base = (type === 'choose') ? d.chooseTime : (20 + 6 * clean.length);
    var sc = (typeof dynamicScale === 'number' && dynamicScale > 0) ? dynamicScale : 1;
    // 拼写长词限时宽（[30,150]）；选择题本就短时限（[8,60]）
    var lo = (type === 'choose') ? 8 : 30;
    var hi = (type === 'choose') ? 60 : 150;
    return Math.max(lo, Math.min(hi, Math.round(base * d.timeFactor * sc)));
  }

  /* ---------- 得分计算 ---------- */
  function computeResult(correct, total) {
    if (!total) return { total: 0, correct: 0, pct: 0, stars: '', msg: '暂无题目' };
    var pct = Math.round(correct / total * 100);
    var stars = pct >= 80 ? '⭐⭐⭐' : pct >= 60 ? '⭐⭐' : '⭐';
    var msg = pct >= 80 ? '太棒了！' : pct >= 60 ? '不错，继续加油！' : '多练几次就熟了！';
    return { total: total, correct: correct, pct: pct, stars: stars, msg: msg };
  }

  /* ---------- 通用工具 ---------- */
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function kwOf(def) {
    return def.split(/[；;,，、（）()]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 1; }).map(function (s) { return s.slice(0, 3); });
  }
  function pickSmartWrong(allSenses, testSense, n) {
    var correctDef = testSense.cnDef;
    var correctKw = {};
    kwOf(correctDef).forEach(function (k) { correctKw[k] = true; });
    var pool = allSenses.filter(function (s) { return s.cnDef !== correctDef; });
    pool = pool.filter(function (s) {
      var kw = kwOf(s.cnDef);
      return !kw.some(function (k) { return correctKw[k]; });
    });
    var chosen = [], usedKw = {};
    function tryPick(arr) {
      var sh = shuffle(arr);
      for (var i = 0; i < sh.length; i++) {
        if (chosen.length >= n) break;
        var kw = kwOf(sh[i].cnDef);
        if (kw.some(function (k) { return usedKw[k]; })) continue;
        chosen.push(sh[i]); kw.forEach(function (k) { usedKw[k] = true; });
      }
    }
    tryPick(pool.filter(function (s) { return s.type === testSense.type && s.pos === testSense.pos; }));
    tryPick(pool.filter(function (s) { return s.pos === testSense.pos; }));
    tryPick(pool);
    if (chosen.length < n) {
      var extra = pool.filter(function (s) { return chosen.indexOf(s) < 0; });
      while (chosen.length < n && extra.length) chosen.push(extra.shift());
    }
    return chosen;
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* ---------- 词形变体生成（规则化屈折变化，用于句子挖空） ----------
   * 覆盖：原形 / 三单·复数 / 过去式·过去分词 / 现在分词。 */
  function wordFormsOf(base) {
    var b = String(base == null ? '' : base).toLowerCase();
    if (!b) return [];
    var forms = [b];
    // 第三人称单数 / 名词复数
    if (/[sxz]$/.test(b) || /(sh|ch)$/.test(b)) forms.push(b + 'es');
    else if (/[^aeiou]y$/.test(b)) forms.push(b.slice(0, -1) + 'ies');
    else forms.push(b + 's');
    // 过去式 / 过去分词
    if (/e$/.test(b)) forms.push(b + 'd');
    else if (/[^aeiou]y$/.test(b)) forms.push(b.slice(0, -1) + 'ied');
    else forms.push(b + 'ed');
    // 现在分词
    if (/e$/.test(b)) forms.push(b.slice(0, -1) + 'ing');
    else forms.push(b + 'ing');
    var seen = {}, out = [];
    for (var i = 0; i < forms.length; i++) if (!seen[forms[i]]) { seen[forms[i]] = true; out.push(forms[i]); }
    return out;
  }

  /* ---------- 句子挖空：目标词所有词形全部替换为 ______ ----------
   * \b 词边界包裹，标点/空白原样保留；g 全局替换确保多处出现全部挖去。 */
  function blankWord(sentence, word) {
    if (!sentence) return { cloze: '', hasBlank: false, count: 0, matched: [] };
    var forms = wordFormsOf(word);
    var re = new RegExp('\\b(' + forms.map(escapeRegExp).join('|') + ')\\b', 'gi');
    var matched = [];
    var cloze = String(sentence).replace(re, function (m) { matched.push(m); return '______'; });
    return { cloze: cloze, hasBlank: matched.length > 0, count: matched.length, matched: matched };
  }

  /* ---------- 挖空自检：确认题干不再残留答案词任何完整词形 ---------- */
  function verifyCloze(clozeText, word) {
    var re = new RegExp('\\b(' + wordFormsOf(word).map(escapeRegExp).join('|') + ')\\b', 'i');
    return !re.test(String(clozeText || ''));
  }

  /* ---------- 向后兼容：保留 findWordInSentence（供旧调用方） ---------- */
  function findWordInSentence(sentence, word) {
    var s = String(sentence || '');
    var w = String(word || '').trim();
    if (!w) return { found: false, before: s, after: '', matchedWord: w, blankLen: w.length };
    var re = new RegExp('\\b' + escapeRegExp(w) + '\\b', 'i');
    var m = s.match(re);
    if (!m) return { found: false, before: s, after: '', matchedWord: w, blankLen: w.length };
    var idx = m.index, matched = m[0];
    return { found: true, before: s.slice(0, idx), after: s.slice(idx + matched.length), matchedWord: matched, blankLen: matched.length };
  }

  /* ---------- 生成句子填空题（挖空 + 自检） ----------
   * target = 句中实际出现的词形（答案）；clozeText = 挖空后的题干。
   * 挖不到（hasBlank=false）时题干保持原句，由上层过滤掉，绝不展示"答案词残留"的题。 */
  function buildSentenceQuestion(sentence, word) {
    var src = String(sentence || '');
    var w = String(word || '').trim();
    var result = { isSentence: true, sentence: src, word: w, target: w, clozeText: src, hasBlank: false, clozeCount: 0 };
    if (!w) return result;
    var b = blankWord(src, w);
    if (b.hasBlank && verifyCloze(b.cloze, w)) {
      result.target = b.matched[0];
      result.clozeText = b.cloze;
      result.hasBlank = true;
      result.clozeCount = b.count;
    }
    return result;
  }

  /* ---------- 全局词表 ---------- */
  var ALL_WORDS = SPELL_WORDS.concat(READ_WORDS);
  var ALL_SENSES = [];
  ALL_WORDS.forEach(function (w) { w.senses.forEach(function (s) { ALL_SENSES.push(s); }); });
  function coreSenseOf(w) { return w.senses.filter(function (s) { return s.type === '核心'; })[0] || w.senses[0]; }

  /* ---------- 题目生成 ---------- */
  /* 档内词池过滤 + 星级升序（3.1 词内分阶：从易到难） */
  function starFilter(words, opt) {
    var pool = words || [];
    if (opt && opt.maxStar) pool = pool.filter(function (w) { return (w.difficulty || 1) <= opt.maxStar; });
    if (opt && opt.minStar) pool = pool.filter(function (w) { return (w.difficulty || 1) >= opt.minStar; });
    // 先随机再按星级升序 → 同星级内保持随机，整体从易到难
    return shuffle(pool).sort(function (a, b) { return (a.difficulty || 1) - (b.difficulty || 1); });
  }
  function buildSpellWordQuestions(words, opt) {
    return starFilter(words, opt).map(function (w) {
      var coreSense = coreSenseOf(w);
      return Object.assign({}, w, { coreSense: coreSense, isSentence: false });
    });
  }
  function buildSentenceQuestions(sentences, opt) {
    return (sentences || []).filter(function (s) {
      var src = SPELL_WORDS.filter(function (x) { return x.word === s.word; })[0] ||
                READ_WORDS.filter(function (x) { return x.word === s.word; })[0];
      if (!src) return true;
      if (opt && opt.maxStar && (src.difficulty || 1) > opt.maxStar) return false;
      if (opt && opt.minStar && (src.difficulty || 1) < opt.minStar) return false;
      return true;
    }).map(function (s) {
      var src = SPELL_WORDS.filter(function (x) { return x.word === s.word; })[0] ||
                READ_WORDS.filter(function (x) { return x.word === s.word; })[0];
      var coreSense = src ? coreSenseOf(src) : null;
      var built = buildSentenceQuestion(s.sentence, s.word);
      return Object.assign({ coreSense: coreSense, pos: coreSense ? coreSense.pos : '', targetInitial: /^[A-Z]/.test(built.target) }, built);
    }).filter(function (q) { return q.hasBlank === true; });
  }
  function buildChooseQuestions(words, opt) {
    // opt.wrong：干扰选项个数（选项总数 = wrong + 1）。按难度分档：基础 2 / 标准 3 / 进阶 4
    var nWrong = (opt && typeof opt.wrong === 'number') ? opt.wrong : 3;
    // 3.1 词内分阶：与拼写模块一致 —— 按难度档收窄词池 + 星级升序（从易到难）
    return starFilter(words, opt).map(function (q) {
      var testSense = q.senses[Math.floor(Math.random() * q.senses.length)];
      var wrongs = pickSmartWrong(ALL_SENSES, testSense, nWrong);
      var options = shuffle([{ def: testSense.cnDef, correct: true }]
        .concat(wrongs.map(function (s) { return { def: s.cnDef, correct: false }; })));
      return { q: q, word: q.word, type: 'choose', testSense: testSense, options: options, allSenses: q.senses };
    });
  }
  function buildMixQuestions(words, opt) {
    // 3.1 词内分阶：混合训练同样按难度档收窄词池 + 星级升序（从易到难）
    return starFilter(words, opt).map(function (w) {
      var type = Math.random() < 0.5 ? 'spell' : 'choose';
      if (type === 'spell') {
        var sense = coreSenseOf(w);
        // 仅当例句里出现【原形】时才挖空；否则展示完整例句作语境，
        // 避免把过去式/单三等形式（shifted/arisen/symbolizes）挖空却要求拼写原形。
        var baseInExample = !!sense.example && new RegExp('\\b' + escapeRegExp(w.word) + '\\b', 'i').test(sense.example);
        var b = blankWord(sense.example, w.word);
        return { type: 'spell', word: w.word, pos: sense.pos, hint: sense.cnDef,
                 example: sense.example || '', cloze: baseInExample ? b.cloze : '', hasBlank: baseInExample && b.hasBlank,
                 allSenses: w.senses };
      }
      var coreSenses = w.senses.filter(function (s) { return s.type === '核心'; });
      var testSense = coreSenses.length > 0 ? coreSenses[Math.floor(Math.random() * coreSenses.length)] : w.senses[Math.floor(Math.random() * w.senses.length)];
      var nWrong = (opt && typeof opt.wrong === 'number') ? opt.wrong : 3;
      var wrongs = pickSmartWrong(ALL_SENSES, testSense, nWrong);
      var options = shuffle([{ def: testSense.cnDef, correct: true }]
        .concat(wrongs.map(function (s) { return { def: s.cnDef, correct: false }; })));
      return { type: 'choose', word: w.word, testSense: testSense, options: options, allSenses: w.senses };
    });
  }
  function buildReviewQuestions(reviewWords) {
    // 错词复习：同样按星级升序（易→难），保持与主模块一致的递进规律
    var ordered = starFilter(reviewWords || [], {});
    var wordQs = ordered.map(function (w) {
      var coreSense = coreSenseOf(w);
      return Object.assign({}, w, { coreSense: coreSense, isSentence: false });
    });
    var reviewSet = {};
    ordered.forEach(function (w) { reviewSet[w.word.toLowerCase()] = true; });
    var sentenceQs = (SENTENCES || []).filter(function (s) { return reviewSet[s.word.toLowerCase()]; }).map(function (s) {
      var src = SPELL_WORDS.filter(function (x) { return x.word === s.word; })[0] ||
                READ_WORDS.filter(function (x) { return x.word === s.word; })[0];
      var coreSense = src ? coreSenseOf(src) : null;
      var built = buildSentenceQuestion(s.sentence, s.word);
      return Object.assign({ coreSense: coreSense, pos: coreSense ? coreSense.pos : '', targetInitial: /^[A-Z]/.test(built.target) }, built);
    }).filter(function (q) { return q.hasBlank === true; });
    return wordQs.concat(sentenceQs);
  }

  global.XB4_CORE = {
    normalizeWord: normalizeWord, normalizeSentence: normalizeSentence, levenshtein: levenshtein,
    classifyInput: classifyInput, isSentence: isSentence, spellJudge: spellJudge, firstMismatch: firstMismatch,
    sm2: sm2, DIFFICULTY: DIFFICULTY, getDifficulty: getDifficulty, computeResult: computeResult,
    timeForTarget: timeForTarget,
    shuffle: shuffle, pickSmartWrong: pickSmartWrong, blankWord: blankWord, findWordInSentence: findWordInSentence,
    wordFormsOf: wordFormsOf, verifyCloze: verifyCloze,
    buildSentenceQuestion: buildSentenceQuestion, ALL_WORDS: ALL_WORDS, ALL_SENSES: ALL_SENSES,
    coreSenseOf: coreSenseOf, buildSpellWordQuestions: buildSpellWordQuestions,
    buildSentenceQuestions: buildSentenceQuestions, buildChooseQuestions: buildChooseQuestions,
    buildMixQuestions: buildMixQuestions, buildReviewQuestions: buildReviewQuestions
  };

  // 顶层全局别名，便于 app.js 直接调用
  global.normalizeWord = normalizeWord;
  global.normalizeSentence = normalizeSentence;
  global.spellJudge = spellJudge;
  global.firstMismatch = firstMismatch;
  global.sm2 = sm2;
  global.getDifficulty = getDifficulty;
  global.timeForTarget = timeForTarget;
  global.computeResult = computeResult;
  global.shuffle = shuffle;
  global.buildSpellWordQuestions = buildSpellWordQuestions;
  global.buildSentenceQuestions = buildSentenceQuestions;
  global.buildChooseQuestions = buildChooseQuestions;
  global.buildMixQuestions = buildMixQuestions;
  global.buildReviewQuestions = buildReviewQuestions;
  global.ALL_WORDS = ALL_WORDS;
  global.ALL_SENSES = ALL_SENSES;
  global.coreSenseOf = coreSenseOf;
})(typeof window !== 'undefined' ? window : this);
