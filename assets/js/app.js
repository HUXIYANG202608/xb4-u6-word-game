/* ============================================================
 * XB4 单词闯关 · 界面与交互 (app)
 * ------------------------------------------------------------
 * 游戏状态机 + DOM 渲染 + 点击字母键盘 + 分享。依赖 core/storage/audio。
 * 通过经典 <script> 全局函数暴露，支持直接双击 index.html 打开，
 * 也支持本地静态服务器运行。
 * ============================================================ */
(function (global) {
  'use strict';

  var document = global.document;
  // storage.js 在 app 之前加载，先捕获它暴露的持久化 setDiff，
  // 避免下方 app 同名函数覆盖 global.setDiff 后产生无限递归调用。
  var G_setDiff = global.setDiff;

  /* ---------- 游戏状态 ---------- */
  var state = {
    mode: null, questions: [], idx: 0, correct: 0, answered: false, q: null,
    inputVal: '', typed: [], tiles: [], capsOn: false, lastIdx: -1, firstHint: '', isReview: false,
    streak: 0,        // 连续答对计数（≥3 触发更热烈的英语鼓励音）
    wrongStreak: 0,   // 连续答错计数（3.4 自适应用）
    adj: 0,           // 自适应：干扰字母调整量（-2 ~ +2）
    adjHint: false,   // 自适应：是否自动开启首字母提示
    qStart: 0,        // 题目开始时间（3.7 埋点：用时统计）
    /* 时间闯关（设计方案 §1-§6） */
    timeLeft: 0, timeTotal: 0, timerId: 0,   // 剩余/总限时/定时器句柄
    timeScale: 1, timePaused: false,          // 动态系数 / 暂停道具
    slowTicks: 0,                             // 减速道具剩余 tick 数（每 tick -0.5s）
    lastLeftRatio: 0.5,                       // 上一题时间余量比（驱动动态调节）
    timeCoinsEarned: 0, newRecord: false      // 本局金币奖励 / 是否破纪录
  };
  var MODE_LABEL = { spell: '拼写挑战', choose: '听音选义', mix: '混合训练', review: '错词复习' };
  /* 难度说明（随选择实时变化，让三档差异一目了然） */
  var DIFF_DESC = {
    easy:   '🟢 基础 · 有首字母提示，字母池小（约 11 键）',
    normal: '🟡 标准 · 无首字母提示，字母池中等（约 14 键）',
    hard:   '🔴 进阶 · 无首字母提示，干扰字母最多（约 17 键）'
  };

  /* ---------- 屏幕切换 ---------- */
  function show(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    document.getElementById(id).classList.add('active');
    global.scrollTo(0, 0);
  }
  function goHome() { renderHome(); show('home'); }

  /* ---------- 首页 / 难度 ---------- */
  function renderDiff() {
    var k = getDiff();
    var btns = document.querySelectorAll('#diffSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.k === k);
    var dd = document.getElementById('diffDesc');
    if (dd) dd.textContent = DIFF_DESC[k] || '';
  }
  function renderHome() {
    renderDiff();
    var st = getStats();
    var stats = document.getElementById('stats');
    var cells = [['已学', st.learned], ['掌握', st.mastered], ['待复习', st.due], ['错词', st.wrong]];
    stats.innerHTML = cells.map(function (c) {
      return '<div class="stat"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>';
    }).join('');
    var rw = getReviewWords().length;
    var badge = document.getElementById('reviewBadge');
    badge.textContent = rw > 0 ? ('待复习 ' + rw + ' 词') : '';
    badge.style.display = rw > 0 ? 'inline-block' : 'none';
  }
  function setDiff(k) { if (G_setDiff) G_setDiff(k); renderDiff(); renderHome(); }

  /* ---------- 开始一个模式 ---------- */
  function startMode(mode) {
    var questions;
    // 听音选义/混合里的选择题也按难度分档：基础 3 选 1 / 标准 4 选 1 / 进阶 5 选 1
    var cd = getDifficulty(getDiff());
    var chooseOpt = { wrong: cd.chooseWrong };
    // 3.1 词内分阶：所有模式按难度档收窄词池 + 档内星级升序（从易到难，规律与拼写一致）
    var starOpt = { minStar: cd.minStar, maxStar: cd.maxStar };
    if (mode === 'spell') {
      questions = buildSpellWordQuestions(SPELL_WORDS, starOpt).concat(buildSentenceQuestions(SENTENCES, starOpt));
    } else if (mode === 'choose') {
      questions = buildChooseQuestions(READ_WORDS, Object.assign({}, chooseOpt, starOpt)); // 仅"听力/阅读类"词做听音选义
    } else if (mode === 'mix') {
      questions = buildMixQuestions(ALL_WORDS, Object.assign({}, chooseOpt, starOpt));
    } else if (mode === 'review') {
      var rw = getReviewWords();
      if (rw.length === 0) { toast('🎉 暂无错词，先去闯关吧！'); return; }
      questions = buildReviewQuestions(rw);
    } else return;

    // 空题单防护（单单元版可能某模式无词：如 U6 全为拼写类、听音选义 0 题）
    if (!questions || questions.length === 0) {
      toast('😅 当前难度下该模式暂无单词，请换一个模式或难度试试');
      return;
    }

    state.mode = mode;
    state.questions = questions;
    state.idx = 0;
    state.correct = 0;
    state.streak = 0;     // 新模式连对计数归零
    state.wrongStreak = 0;
    state.adj = 0;        // 自适应：干扰调整归零
    state.adjHint = false;
    state.isReview = (mode === 'review');
    // 时间闯关：新局重置
    state.timeScale = 1; state.timePaused = false; state.slowTicks = 0;
    state.lastLeftRatio = 0.5; state.timeCoinsEarned = 0; state.newRecord = false;
    if (global.ensureTimeGift) global.ensureTimeGift(); // 新手礼包（首次）
    document.getElementById('modeText').textContent = MODE_LABEL[mode];
    if (mode === 'spell' || mode === 'mix') maybeShowCapsTip();
    renderQuestion();
    show('play');
  }

  /* 首次进入拼写/混合：提示大写按钮用法（只弹一次） */
  function maybeShowCapsTip() {
    try {
      var k = 'xb4-caps-tip-shown';
      if (global.localStorage.getItem(k)) return;
      global.localStorage.setItem(k, '1');
      setTimeout(function () {
        toast('💡 默认小写 · 需要大写时点「⇧ 大写」切换');
      }, 600);
    } catch (e) {}
  }

  /* ---------- 渲染题目 ---------- */
  function renderQuestion() {
    var q = state.q = state.questions[state.idx];
    state.answered = false; state.inputVal = ''; state.typed = []; state.lastIdx = -1;
    // 句首单词自动武装大写（输入首字母后会自动切回小写）；其他场景默认小写
    state.capsOn = !!(q && q.targetInitial);
    // 必须传当前存储的难度键（getDifficulty() 无参会永远返回“标准”，
    // 这正是用户反馈“三层难度没有差别”的根因！）
    var diff = getDifficulty(getDiff());
    // 3.4 自适应：干扰字母数 ±adj，失败自动开首字母提示
    var baseDiff = {
      distractors: Math.max(2, diff.distractors + (state.adj || 0)),
      firstHint: !!(diff.firstHint || state.adjHint),
      isHard: diff.key === 'hard' // 3.3 形近干扰：仅进阶档启用
    };
    state.qStart = Date.now(); // 3.7 埋点：记录本题目开始时间
    var tot = state.questions.length;
    document.getElementById('progBar').style.width = Math.round(state.idx / tot * 100) + '%';
    document.getElementById('progText').textContent = (state.idx + 1) + ' / ' + tot;
    var fb = document.getElementById('feedback');
    fb.className = 'feedback'; fb.innerHTML = '';
    var qc = document.getElementById('qcard');
    var html = '';
    if (q.isSentence) {
      var clozeEsc = String(q.clozeText || q.sentence || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var clozeHtml = clozeEsc.replace(/______/g, '<b class="blank">______</b>');
      html += '<span class="qtag">拼写 · 句子挖空</span>';
      html += '<div class="qhint">请拼出挖空处的单词<small>' + (q.pos || '') + '</small></div>';
      html += '<div class="cloze">' + clozeHtml + '</div>';
      if (q.targetInitial) html += '<div class="caps-tip">💡 该词位于句首，首字母需大写——已自动开启大写，输入首字母后将自动切回小写。</div>';
      html += letterPadHtml(q.target, baseDiff);
    } else if (q.type === 'choose') {
      html += '<span class="qtag">听音选义</span>';
      html += '<button class="audio-btn" onclick="speak(\'' + q.word.replace(/'/g, "\\'") + '\')">🔊 点击听发音</button>';
      html += '<div class="qhint">选出正确释义</div>';
      html += '<div class="opts">' + q.options.map(function (o, i) {
        return '<button class="opt" id="opt' + i + '" onclick="chooseOption(' + i + ')">' + o.def + '</button>';
      }).join('') + '</div>';
    } else if (q.type === 'spell') {
      html += '<span class="qtag">拼写 · 单词</span>';
      html += '<button class="audio-btn" onclick="speak(\'' + q.word.replace(/'/g, "\\'") + '\')">🔊 听发音</button>';
      html += '<div class="qhint">' + (q.hint || '') + '<small>' + (q.pos || '') + '</small></div>';
      html += letterPadHtml(q.word, baseDiff);
    } else {
      html += '<span class="qtag">拼写 · 单词</span>';
      html += '<button class="audio-btn" onclick="speak(\'' + q.word.replace(/'/g, "\\'") + '\')">🔊 听发音</button>';
      html += '<div class="qhint">' + ((q.coreSense ? q.coreSense.cnDef : q.hint) || '') + '<small>' + ((q.coreSense ? q.coreSense.pos : q.pos) || '') + '</small></div>';
      html += letterPadHtml(q.word, baseDiff);
    }
    qc.innerHTML = html;
    renderKeys(); // 同步大写按钮视觉（句首自动武装后必须显示点亮）
    renderSlots(); // 首字母占位提示（首字母大写提示/小写提示）必须在题目首次落地时就出现，不能等用户点字母
    var sb = document.getElementById('submitBtn');
    sb.textContent = '提交答案'; sb.className = 'submit'; sb.disabled = (q.type === 'choose');
    startTimer(); // 时间闯关：启动倒计时（设计方案 §1.3）
  }

  /* ============ 时间闯关系统（设计方案 §1-§6） ============ */
  function timerEnabled() {
    try { return global.localStorage.getItem('xb4-timer-on') !== '0'; } catch (e) { return true; }
  }
  /* 首页「计时闯关」开关（新手指引后手动切换） */
  function toggleTimerMode() {
    var on = !timerEnabled();
    try { global.localStorage.setItem('xb4-timer-on', on ? '1' : '0'); } catch (e) {}
    renderTimerToggle();
    toast(on ? '⏱ 计时闯关已开启（限时挑战 + 道具 + 排行）' : '⏱ 计时闯关已关闭（无时间压力，安心练习）');
  }
  function renderTimerToggle() {
    var b = document.getElementById('timerToggle');
    if (!b) return;
    var on = timerEnabled();
    b.textContent = on ? '开' : '关';
    b.classList.toggle('on', on);
  }
  /* 首页「背景音乐」开关（默认关，课堂安全） */
  function bgmEnabled() { try { return global.localStorage.getItem('xb4-bgm') === '1'; } catch (e) { return false; } }
  function toggleBgm() {
    var on = !bgmEnabled();
    try { global.localStorage.setItem('xb4-bgm', on ? '1' : '0'); } catch (e) {}
    renderBgmToggle();
    if (on) { if (global.bgmStart) global.bgmStart(); toast('🎵 背景音乐已开启（轻量合成音，可在首页关闭）'); }
    else { if (global.bgmStop) global.bgmStop(); toast('🎵 背景音乐已关闭'); }
  }
  function renderBgmToggle() {
    var b = document.getElementById('bgmToggle');
    if (!b) return;
    var on = bgmEnabled();
    b.textContent = on ? '开' : '关';
    b.classList.toggle('on', on);
  }
  function startTimer() {
    stopTimer();
    if (!timerEnabled()) return;
    var q = state.q;
    if (!q) return;
    var target = q.isSentence ? q.target : q.word;
    var diffKey = getDiff();
    state.timeTotal = timeForTarget(target, diffKey, (q.type === 'choose') ? 'choose' : 'spell', state.timeScale);
    state.timeLeft = state.timeTotal;
    state.timePaused = false; state.slowTicks = 0;
    document.body.classList.remove('timer-danger');
    renderTimer(); renderItems();
    state.timerId = setInterval(tickTimer, 1000);
  }
  function stopTimer() { if (state.timerId) { clearInterval(state.timerId); state.timerId = 0; } }
  function tickTimer() {
    if (state.answered) return;
    if (state.timePaused) { renderTimer(); return; }
    if (state.slowTicks > 0) { state.slowTicks--; state.timeLeft -= 0.5; }
    else state.timeLeft -= 1;
    renderTimer();
    if (state.timeLeft <= 10) {
      if (global.tickSound) { try { global.tickSound(); } catch (e) {} }
      if (state.timeLeft <= 5 && global.alarmSound) { try { global.alarmSound(); } catch (e) {} }
    }
    if (state.timeLeft <= 0) timeUp();
  }
  function renderTimer() {
    var bar = document.getElementById('timerBar');
    if (!bar) return;
    if (!timerEnabled()) { bar.style.display = 'none'; return; }
    var fill = document.getElementById('timerFill'), txt = document.getElementById('timerText');
    bar.style.display = 'flex';
    var ratio = state.timeTotal > 0 ? (state.timeLeft / state.timeTotal) : 0;
    if (fill) { fill.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
      fill.className = ratio > 0.5 ? 'ok' : ratio > 0.2 ? 'warn' : 'danger'; }
    if (txt) txt.textContent = Math.max(0, Math.ceil(state.timeLeft)) + 's';
    document.body.classList.toggle('timer-danger', state.timeLeft <= 10 && state.timeLeft > 0);
  }
  /* 超时 → 按答错处理 */
  function timeUp() {
    if (state.answered) return;
    stopTimer();
    var q = state.q;
    state.answered = true;
    state.lastLeftRatio = 0; // 超时 → 下一关时间放宽（设计方案 §4）
    state.streak = 0; state.wrongStreak = (state.wrongStreak || 0) + 1;
    showFeedback('err', '⏰ 时间到！', '正确答案：' + (q.isSentence ? q.target : q.word), answerBlock(q));
    adjustDifficulty(false);
    statWord(q, false);
    recordAttempt(q.word, 1);
    finishQuestion();
  }
  /* 道具栏渲染 */
  function renderItems() {
    var bar = document.getElementById('itemBar');
    if (!bar) return;
    if (!timerEnabled()) { bar.style.display = 'none'; return; }
    var it = global.getItems ? global.getItems() : {};
    bar.style.display = 'flex';
    bar.innerHTML =
      '<span class="coin">🪙 <b id="coinNum">' + (global.getCoins ? global.getCoins() : 0) + '</b></span>' +
      '<button class="item" onclick="useItem(\'pause\')">⏸ 暂停×' + (it.pause || 0) + '</button>' +
      '<button class="item" onclick="useItem(\'slow\')">🐌 减速×' + (it.slow || 0) + '</button>' +
      '<button class="item" onclick="useItem(\'bonus\')">⏱ +15s×' + (it.bonus || 0) + '</button>';
  }
  /* 道具：直接用库存；库存不足时用时间币购买（暂停/减速 2 币，加时 3 币） */
  function useItem(type) {
    if (state.answered || !timerEnabled() || state.timeLeft <= 0) return;
    var cost = type === 'bonus' ? 3 : 2;
    if (!global.consumeItem || !global.consumeItem(type)) {
      var coins = global.getCoins ? global.getCoins() : 0;
      if (coins >= cost && global.addCoins && global.addItem) {
        global.addCoins(-cost); global.addItem(type, 1); global.consumeItem(type);
        toast('🪙 已用 ' + cost + ' 币兑换并立即使用');
      } else {
        toast('⏸ 道具不足：答对题目可得时间币，或用 🪙' + cost + ' 购买');
        return;
      }
    }
    if (type === 'pause') {
      state.timePaused = true; toast('⏸ 时间暂停 5 秒！');
      setTimeout(function () { state.timePaused = false; toast('▶ 时间继续'); }, 5000);
    } else if (type === 'slow') {
      state.slowTicks = 10; toast('🐌 时间减慢 10 秒！');
    } else if (type === 'bonus') {
      state.timeLeft += 15;
      if (state.timeLeft > state.timeTotal) state.timeTotal = state.timeLeft;
      toast('⏱ +15 秒！');
    }
    renderItems(); renderTimer();
  }
  /* 作答正确时的时间奖励：金币 + 破纪录检测（设计方案 §2/§5） */
  function applyTimeReward(q) {
    if (!timerEnabled()) return;
    stopTimer();
    var leftMs = Math.max(0, state.timeLeft * 1000);
    state.lastLeftRatio = state.timeTotal > 0 ? (state.timeLeft / state.timeTotal) : 0.5;
    var earned = 1 + (state.lastLeftRatio > 0.4 ? 1 : 0);
    if (global.addCoins) global.addCoins(earned);
    state.timeCoinsEarned += earned;
    var usedMs = state.qStart ? (Date.now() - state.qStart) : leftMs;
    state.newRecord = !!(global.setBestTime && global.setBestTime(q.word, usedMs));
  }
  /* 作答错误时的动态调节输入（设计方案 §4） */
  function applyTimeFail() {
    if (!timerEnabled()) return;
    stopTimer();
    state.lastLeftRatio = 0.1; // 答错 → 下一关放宽
  }
  /* 时间排行榜弹窗（本机最佳） */
  function openRank() {
    var bt = global.getBestTime ? global.getBestTime() : {};
    var rows = Object.keys(bt).map(function (w) {
      return { word: w, ms: bt[w].ms, date: bt[w].date };
    }).sort(function (a, b) { return a.ms - b.ms; });
    var html = rows.length
      ? '<table class="rank"><tr><th>#</th><th>单词</th><th>最佳时间</th><th>日期</th></tr>' +
        rows.slice(0, 20).map(function (r, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + r.word + '</td><td>' + (r.ms / 1000).toFixed(1) + 's</td><td>' + String(r.date || '').slice(0, 10) + '</td></tr>';
        }).join('') + '</table>'
      : '<p style="color:var(--muted);padding:10px">暂无纪录，快去闯关吧！</p>';
    var el = document.getElementById('rankList');
    if (el) el.innerHTML = html;
    var mk = document.getElementById('rankMask');
    if (mk) mk.classList.add('show');
  }
  function closeRank() { var mk = document.getElementById('rankMask'); if (mk) mk.classList.remove('show'); }

  /* ---------- 点击字母键盘 ---------- */
  /* 3.3 形近干扰：进阶档干扰字母优先选与目标词"形近/音近"的字母，
   * 制造真正"看起来像"的难度（如 c→k、i→e、b→d/p/v、s→z/c）。 */
  var CONFUSE = {
    a: ['o', 'e', 'u'], b: ['d', 'p', 'v', 'h'], c: ['k', 's', 'g', 'e'],
    d: ['b', 'p', 't', 'g'], e: ['i', 'a', 'o', 'c'], f: ['v', 't'],
    g: ['j', 'c', 'q', 'd'], h: ['b', 'n'], i: ['e', 'y', 'o'],
    j: ['g', 'i'], k: ['c', 'q'], l: ['r', 'i', 't'],
    m: ['n', 'w'], n: ['m', 'h', 'u'], o: ['a', 'u', 'e'],
    p: ['b', 'd', 'q'], q: ['g', 'k', 'p'], r: ['l', 'n'],
    s: ['z', 'c', 'x'], t: ['d', 'f', 'l'], u: ['o', 'v', 'n', 'w'],
    v: ['b', 'w', 'u'], w: ['v', 'm', 'u'], x: ['s', 'z'],
    y: ['i', 'j'], z: ['s', 'x']
  };
  function confuseDistract(letters, n, isHard) {
    var alpha = 'abcdefghijklmnopqrstuvwxyz'.split('');
    var usedSet = {};
    letters.forEach(function (c) { usedSet[c] = true; });
    var usable = alpha.filter(function (c) { return !usedSet[c]; });
    if (!isHard || n <= 2) return shuffle(usable).slice(0, n);
    // 形近优先：收集目标字母的形近字母（需不在目标词中），随机取；不足再随机补
    var confSet = {};
    letters.forEach(function (l) {
      (CONFUSE[l] || []).forEach(function (c) { if (!usedSet[c]) confSet[c] = true; });
    });
    var out = [], confList = shuffle(Object.keys(confSet));
    for (var i = 0; i < confList.length && out.length < n; i++) out.push(confList[i]);
    var rest = shuffle(usable.filter(function (c) { return out.indexOf(c) < 0; }));
    while (out.length < n && rest.length) out.push(rest.shift());
    return out;
  }
  function letterPadHtml(target, diff) {
    var n = diff.distractors;
    var letters = String(target || '').toLowerCase().replace(/[^a-z]/g, '').split('');
    var distract = confuseDistract(letters, n, !!diff.isHard);
    var tiles = shuffle(letters.concat(distract)).map(function (c, i) { return { id: i, ch: c }; });
    state.tiles = tiles;
    var firstHint = diff.firstHint ? String(target || '').charAt(0).toUpperCase() : '';
    state.firstHint = firstHint;
    var h = '<div class="pad"><div class="slots" id="slots"></div>';
    if (firstHint) h += '<div class="firsthint">首字母提示：' + firstHint + '</div>';
    h += '<div class="keypad">';
    h += tiles.map(function (t) {
      return '<button class="key" id="key' + t.id + '" onclick="tapLetter(' + t.id + ')">' + t.ch + '</button>';
    }).join('');
    h += '<button class="key caps" id="capsKey" onclick="toggleCaps()">⇧ 大写</button>';
    h += '</div><div class="pad-actions"><button onclick="backspace()">⌫ 删除</button><button onclick="clearTyped()">清空重拼</button></div></div>';
    return h;
  }
  function renderSlots() {
    var el = document.getElementById('slots');
    if (!el) return;
    var q = state.q;
    var target = q ? (q.isSentence ? q.target : q.word) : '';
    var targetLen = String(target || '').replace(/[^A-Za-z]/g, '').length;

    if (state.typed.length === 0) {
      // 干净的占位：单条提示，不再 N 个橙色方块
      var html = '<div class="slots-empty">';
      html += '<div class="se-text">点击下方字母组成单词';
      if (targetLen > 0) html += ' · <b>共 ' + targetLen + ' 个字母</b>';
      html += '</div>';
      if (q && q.isSentence && q.targetInitial) {
        html += '<div class="se-tip">💡 首字母需大写，已自动开启大写</div>';
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    // 已输入：实心槽 + 浅色占位槽，让玩家看到剩余进度
    var typedHtml = state.typed.map(function (t, i) {
      return '<span class="slot' + (i === state.lastIdx ? ' pop' : '') + '">' + t.ch + '</span>';
    }).join('');
    var remaining = '';
    for (var i = state.typed.length; i < targetLen; i++) {
      remaining += '<span class="slot empty pending">·</span>';
    }
    el.innerHTML = typedHtml + remaining;
  }
  function renderKeys() {
    state.tiles.forEach(function (t) {
      var k = document.getElementById('key' + t.id);
      // 注意：必须用显式布尔 add/remove，不能用 toggle('used', t.used)——
      // 初始 t.used 是 undefined，浏览器会把 toggle(x, undefined) 当"翻转"，
      // 导致所有字母键一进来就被误标 used 变成灰色不可点
      if (!k) return;
      if (t.used) { k.classList.add('used'); } else { k.classList.remove('used'); }
    });
    var c = document.getElementById('capsKey');
    if (c) {
      c.classList.toggle('on', state.capsOn);
      // LOCK 模式：一次点击 = 开启（可连续输入多个大写字母） / 再次点击 = 关闭
      c.textContent = state.capsOn ? '大写·已开启' : '⇧ 大写';
      c.title = state.capsOn ? '大写已开启。点击关闭。' : '点击开启大写（可连续输入多个大写字母，再次点击关闭）';
    }
  }
  function tapLetter(id) {
    if (state.answered) return;
    var tile = state.tiles.filter(function (t) { return t.id === id; })[0];
    if (!tile || tile.used) return;
    var ch = state.capsOn ? tile.ch.toUpperCase() : tile.ch;
    tile.used = true;
    state.typed.push({ ch: ch, tileId: id });
    state.lastIdx = state.typed.length - 1;
    state.inputVal = state.typed.map(function (t) { return t.ch; }).join('');
    // LOCK 模式：caps 状态保持不变。仅在"句子挖空首字母自动武装"场景下，
    // 输完 1 个首字母后自动关闭（避免后续字母也被大写）
    var q = state.q;
    if (state.capsOn && q && q.isSentence && q.targetInitial && state.typed.length === 1) {
      state.capsOn = false;
    }
    renderSlots(); renderKeys();
    (function () { var len = state.typed.length; setTimeout(function () { if (state.lastIdx === len - 1) state.lastIdx = -1; renderSlots(); }, 320); })();
    var sb = document.getElementById('submitBtn'); if (sb) sb.disabled = false;
  }
  function backspace() {
    if (state.answered) return;
    var t = state.typed.pop();
    if (!t) return;
    var tile = state.tiles.filter(function (x) { return x.id === t.tileId; })[0];
    if (tile) tile.used = false;
    state.lastIdx = state.typed.length - 1;
    state.inputVal = state.typed.map(function (x) { return x.ch; }).join('');
    renderSlots(); renderKeys();
    setTimeout(function () { state.lastIdx = -1; renderSlots(); }, 320);
  }
  function clearTyped() {
    if (state.answered) return;
    state.tiles.forEach(function (t) { t.used = false; });
    state.typed = []; state.lastIdx = -1; state.inputVal = '';
    renderSlots(); renderKeys();
    var sb = document.getElementById('submitBtn'); if (sb) sb.disabled = true;
  }
  function toggleCaps() {
    if (state.answered) return;
    state.capsOn = !state.capsOn; renderKeys();
  }

  /* 3.4 自适应难度（档内微调）：
   *  - 连对 ≥3 → 干扰字母 +1（上限 +2）
   *  - 连错 ≥2 → 干扰字母 -1（下限 -2）；已达下限 → 自动开启首字母提示 */
  function adjustDifficulty(correct) {
    if (correct) {
      state.wrongStreak = 0;
      if (state.streak >= 3 && (state.adj || 0) < 2) {
        state.adj = (state.adj || 0) + 1;
        toast('⬆️ 难度已自动提升：干扰字母 +1');
      }
    } else {
      state.wrongStreak = (state.wrongStreak || 0) + 1;
      if (state.wrongStreak >= 2) {
        state.wrongStreak = 0;
        if ((state.adj || 0) > -2) {
          state.adj = (state.adj || 0) - 1;
          toast('⬇️ 难度已自动降低：干扰字母 -1');
        } else if (!state.adjHint) {
          state.adjHint = true;
          toast('💡 已自动开启首字母提示，助你继续挑战');
        }
      }
    }
  }
  /* 3.7 埋点：记录本词作答统计 */
  function statWord(q, correct) {
    try {
      var ms = Date.now() - (state.qStart || Date.now());
      var pairs = [];
      if (!correct && q && q.type !== 'choose') {
        var target = q.isSentence ? q.target : q.word;
        var fm = firstMismatch(String(state.inputVal || '').toLowerCase(), String(target || '').toLowerCase());
        if (fm) pairs.push({ expected: fm.expected, got: fm.got });
      }
      if (global.recordWordStat) global.recordWordStat(q.word, correct, ms, pairs);
    } catch (e) {}
  }

  /* ---------- 作答判题 ---------- */
  function chooseOption(i) {
    if (state.answered) return;
    var q = state.q, o = q.options[i];
    state.answered = true;
    q.options.forEach(function (op, j) {
      var el = document.getElementById('opt' + j);
      if (!el) return;
      if (op.correct) el.classList.add('correct');
      else if (j === i) el.classList.add('wrong');
    });
    var correct = o.correct;
    if (correct) {
      state.correct++;
      state.streak++;
      // 英语鼓励音（文字+声音双通道：即使设备不支持语音也能在反馈里看到英文鼓励语）
      var pk = state.streak >= 3 ? 'combo' : 'ok';
      var pt = praiseText(pk);
      speakPraise(pk);
      applyTimeReward(q); // 时间奖励：金币 + 破纪录
      showFeedback('ok', '✅ 正确！' + (pt ? ' <b>' + pt + '</b>' : ''), '', answerBlock(q));
    } else {
      state.streak = 0;
      applyTimeFail(); // 答错 → 下一关时间放宽
      showFeedback('err', '❌ 答错了', '正确答案：' + q.testSense.cnDef, answerBlock(q));
    }
    adjustDifficulty(correct);
    statWord(q, correct);
    recordAttempt(q.word, correct ? 5 : 1);
    finishQuestion();
  }
  function onSubmit() {
    var q = state.q;
    if (state.answered) return;
    if (q.type === 'choose') return;
    var target = q.isSentence ? q.target : q.word;
    var res = spellJudge(state.inputVal, target, { caseSensitive: !!q.isSentence });
    if (res.kind === 'empty') { showFeedback('err', '❌ 请先拼出答案', '点击字母按钮组成单词后再提交。'); return; }
    if (res.kind === 'input_method') { showFeedback('ime', res.imeTip || '输入有误', ''); return; }
    state.answered = true;
    var correct = res.correct;
    if (correct) {
      state.correct++;
      state.streak++;
      // 英语鼓励音（文字+声音双通道）
      var pk = state.streak >= 3 ? 'combo' : 'ok';
      var pt = praiseText(pk);
      speakPraise(pk);
      applyTimeReward(q); // 时间奖励：金币 + 破纪录
      showFeedback('ok', '✅ 正确！' + (pt ? ' <b>' + pt + '</b>' : ''), '单词：' + target + '　' + ((q.coreSense ? q.coreSense.enDef : '') || ''), answerBlock(q));
    } else {
      state.streak = 0;
      applyTimeFail(); // 答错 → 下一关时间放宽
      var det = '正确答案：' + target;
      if (res.caseMismatch) det = '⚠️ 大小写不一致——该词在句中需大写/小写与示例完全一致。';
      else {
        var fm = firstMismatch(state.inputVal.toLowerCase(), target.toLowerCase());
        if (fm) det += '（第 ' + fm.index + ' 个字母应为 "' + fm.expected.toUpperCase() + '"，你拼成 "' + fm.got.toUpperCase() + '"）';
      }
      showFeedback('err', '❌ 拼写错误', det, answerBlock(q));
    }
    adjustDifficulty(correct);
    statWord(q, correct);
    recordAttempt(q.word, correct ? 5 : 1);
    finishQuestion();
  }
  function showFeedback(cls, title, det, extra) {
    var fb = document.getElementById('feedback');
    fb.className = 'feedback show ' + cls;
    fb.innerHTML = title + (det ? '<div class="det">' + det + '</div>' : '') + (extra || '');
  }
  /* 答题后该展示哪些释义：
   *  - 听音选义 / 混合(选义)：展示该单词【全部含义】
   *  - 单词拼写练习（拼写·单词 / 句子挖空 / 错词复习）：仅展示【核心义】 */
  function sensesToShow(q) {
    if (q.type === 'choose') {
      return (q.allSenses && q.allSenses.length) ? q.allSenses : (q.senses || []);
    }
    if (q.senses && q.senses.length) {
      var cs = coreSenseOf(q) || q.senses[0];
      return [cs];
    }
    if (q.coreSense) return [q.coreSense];
    return [];
  }
  function answerBlock(q) {
    var senses = sensesToShow(q);
    if (!senses.length) return '';
    var title = q.type === 'choose' ? '📖 单词完整释义' : '📖 核心释义';
    var rows = senses.map(function (s) {
      var tcls = 'st-' + (s.type === '核心' ? 'core' : (s.type === '引申' ? 'ext' : 'rare'));
      return '<div class="srow">' +
        '<span class="st ' + tcls + '">' + (s.type || '') + '</span>' +
        '<span class="sp">' + (s.pos || '') + '</span>' +
        '<div class="scn">' + s.cnDef + ' <span class="sen">/ ' + s.enDef + '</span></div>' +
        (s.example ? '<div class="sex">例句：' + s.example + '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="answer-senses"><div class="as-title">' + title + '</div>' + rows + '</div>';
  }
  function finishQuestion() {
    var sb = document.getElementById('submitBtn');
    sb.textContent = '下一题 →'; sb.className = 'submit next'; sb.disabled = false; sb.onclick = nextQuestion;
    document.getElementById('progBar').style.width = Math.round((state.idx + 1) / state.questions.length * 100) + '%';
    // 提交后 caps 状态重置：下一题不沿用，防止"上一题开了 caps → 这一题意外输出大写"
    state.capsOn = false;
    renderKeys();
  }
  /* 动态时间调节（设计方案 §4）：根据上一题时间余量调整后续时间压力 */
  function adjustTimeScale() {
    if (!timerEnabled()) return;
    if (state.lastLeftRatio > 0.4) state.timeScale = Math.min(1.5, (state.timeScale || 1) * 0.92);
    else if (state.lastLeftRatio < 0.1) state.timeScale = Math.max(0.7, (state.timeScale || 1) * 1.12);
  }
  function nextQuestion() {
    var sb = document.getElementById('submitBtn');
    sb.onclick = onSubmit;
    adjustTimeScale(); // 依据上一题表现调整下一关限时
    state.idx++;
    if (state.idx >= state.questions.length) showResult();
    else renderQuestion();
  }

  /* ---------- 结算 ---------- */
  function showResult() {
    var r = computeResult(state.correct, state.questions.length);
    var rk = r.pct >= 80 ? 'high' : r.pct >= 60 ? 'mid' : 'low';
    var rt = praiseText(rk);
    speakPraise(rk); // 结算英语鼓励音（文字+声音）
    stopTimer();
    // 时间闯关结算信息：金币奖励 + 新纪录（设计方案 §2/§5）
    var timeNote = '';
    if (timerEnabled()) {
      var parts = [];
      if (state.timeCoinsEarned > 0) parts.push('⏱ 时间奖励 +🪙' + state.timeCoinsEarned);
      if (state.newRecord) parts.push('🏆 本关最快纪录！');
      timeNote = parts.length
        ? '<div class="timenote">' + parts.join(' ｜ ') + '</div>'
        : '<button class="iconbtn" style="margin:6px auto 0;display:block" onclick="openRank()">🏆 时间排行榜</button>';
      if (parts.length) timeNote += '<button class="iconbtn" style="margin:6px auto 0;display:block" onclick="openRank()">🏆 查看时间排行榜</button>';
    }
    document.getElementById('resultBox').innerHTML =
      '<div class="stars">' + r.stars + '</div>' +
      '<div class="pct">' + r.pct + ' 分</div>' +
      '<div class="msg">' + r.msg + (rt ? '<br/><span style="font-size:16px;color:var(--primary-d)">' + rt + '</span>' : '') + '</div>' +
      timeNote +
      '<div style="color:var(--muted);margin-bottom:18px">答对 ' + r.correct + ' / ' + r.total + ' 题</div>' +
      '<div class="btns"><button class="submit" onclick="startMode(\'' + state.mode + '\')">🔁 再来一组</button>' +
      '<button class="iconbtn" style="border:1px solid var(--line);border-radius:12px;padding:13px" onclick="goHome()">返回首页</button></div>';
    show('result');
  }

  /* ---------- 词表 ---------- */
  function showVocab() {
    var bt = global.getBestTime ? global.getBestTime() : {};
    var vl = document.getElementById('vlist');
    vl.innerHTML = ALL_WORDS.map(function (w) {
      var best = bt[w.word.toLowerCase()];
      var bestTxt = best ? '<span class="best">🏆 ' + (best.ms / 1000).toFixed(1) + 's</span>' : '';
      return '<div class="vitem"><div class="w">' + w.word +
        ' <span class="pos">' + w.senses[0].pos + '</span> ' + bestTxt +
        '<button class="iconbtn" style="padding:4px 10px;font-size:12px" onclick="speak(\'' + w.word + '\')">🔊</button></div>' +
        w.senses.map(function (s) {
          return '<div class="sense"><span class="t">' + s.type + '</span>' + s.cnDef +
            ' <span class="en">/ ' + s.enDef + '</span><div class="ex">' + s.example + '</div></div>';
        }).join('') + '</div>';
    }).join('');
    show('vocab');
  }

  /* ---------- 分享 ---------- */
  function curUrl() { return global.location.href.split('#')[0]; }
  function enc(s) { return encodeURIComponent(s); }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  /* 三级都失败时，在题面单词处加一个短暂高亮 */
  function flashWordHighlight(word) {
    if (!word) return;
    var el = document.querySelector('.qword, .vc-word');
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1400);
  }
  function copyText(t) {
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) return global.navigator.clipboard.writeText(t);
    return new Promise(function (r) {
      var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); r();
    });
  }
  function openShare() { document.getElementById('shareMask').classList.add('show'); }
  function closeShare() { document.getElementById('shareMask').classList.remove('show'); }
  function nativeShare() {
    if (global.navigator.share) {
      global.navigator.share({
        title: 'XB4 英语单词闯关 · 在线版',
        text: '拼写挑战、听音选义、混合训练、错词本与间隔重复，浏览器直接玩！',
        url: curUrl()
      }).catch(function () {});
      return true;
    }
    return false;
  }
  function shareWeChat() {
    if (nativeShare()) { closeShare(); return; }
    var u = curUrl();
    global.open('https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + enc(u), '_blank');
    toast('已生成二维码，可长按或保存分享');
  }
  function shareQQ() {
    if (nativeShare()) { closeShare(); return; }
    var u = curUrl();
    global.open('https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=' + enc(u) +
      '&title=' + enc('XB4 单词闯关在线版') + '&summary=' + enc('浏览器直接玩的单词闯关游戏') + '&site=' + enc('XB4'), '_blank');
    closeShare();
  }
  function shareGitHub() {
    copyText(curUrl()).then(function () { toast('链接已复制，可粘贴到 GitHub 仓库 / Issue'); });
    global.open('https://github.com', '_blank'); closeShare();
  }
  function copyLink() { copyText(curUrl()).then(function () { toast('✅ 链接已复制'); }); closeShare(); }
  function shareMail() {
    var u = curUrl();
    global.location.href = 'mailto:?subject=' + enc('邀请体验：XB4 英语单词闯关在线版') +
      '&body=' + enc('你好，推荐一个可直接在浏览器玩的英语单词闯关游戏：\n' + u + '\n功能：拼写挑战、听音选义、混合训练、错词本与间隔重复。');
    closeShare();
  }
  function resetProgressConfirm() {
    if (global.confirm('确定要清空学习记录（错词本 / 掌握度）吗？此操作不可恢复。')) {
      resetProgress(); renderHome(); toast('已清空学习记录');
    }
  }

  /* ---------- 新手引导（分步弹窗，替代单条 toast） ---------- */
  var GUIDE_STEPS = [
    { t: '🎮 认识四个模式', d: '拼写挑战：点字母拼出单词/句子词；听音选义：听发音选释义；混合训练：随机组合；错词复习：只练答错/到期的词（智能重复）。' },
    { t: '🎚️ 难度三档', d: '基础：有首字母提示、只出简单词；标准：全部词；进阶：难词 + 形近干扰。难度会随你的表现自动微调。' },
    { t: '✍️ 大小写与发音', d: '默认小写；需要大写时点「⇧ 大写」切换。点 🔊 听单词发音，答对/连对还有英语鼓励音。' },
    { t: '⏱️ 时间挑战与道具', d: '开启「计时闯关」后，每关限时作答，提前完成得时间币；道具栏可用 ⏸暂停 / 🐌减速 / ⏱加时，时间不够可紧急救场。' },
    { t: '🏆 排行榜与词汇总览', d: '首页「时间排行榜」记录每个词的最佳通关时间；「词汇总览」可查看全部词条、义项与例句。' }
  ];
  var guideIdx = 0;
  function showGuide() {
    guideIdx = 0;
    renderGuide();
    var mk = document.getElementById('guideMask');
    if (mk) mk.classList.add('show');
  }
  function renderGuide() {
    var mk = document.getElementById('guideMask');
    if (!mk) return;
    var s = GUIDE_STEPS[guideIdx] || GUIDE_STEPS[0];
    var gt = document.getElementById('guideTitle'), gd = document.getElementById('guideDesc'),
        gdots = document.getElementById('guideDots'), gn = document.getElementById('guideNext');
    if (gt) gt.textContent = s.t;
    if (gd) gd.textContent = s.d;
    if (gdots) gdots.innerHTML = GUIDE_STEPS.map(function (_, i) {
      return '<i class="dot' + (i === guideIdx ? ' on' : '') + '"></i>';
    }).join('');
    if (gn) gn.textContent = guideIdx >= GUIDE_STEPS.length - 1 ? '开始闯关 ▶' : '下一步 →';
  }
  function nextGuide() {
    guideIdx++;
    if (guideIdx >= GUIDE_STEPS.length) { closeGuide(); return; }
    renderGuide();
  }
  function closeGuide() { var mk = document.getElementById('guideMask'); if (mk) mk.classList.remove('show'); }

  /* ---------- 暴露全局（供内联 onclick 调用） ---------- */
  global.show = show;
  global.goHome = goHome;
  global.renderHome = renderHome;
  global.renderDiff = renderDiff;
  global.setDiff = setDiff;
  global.startMode = startMode;
  global.tapLetter = tapLetter;
  global.toggleCaps = toggleCaps;
  global.backspace = backspace;
  global.clearTyped = clearTyped;
  global.chooseOption = chooseOption;
  global.onSubmit = onSubmit;
  global.nextQuestion = nextQuestion;
  global.showVocab = showVocab;
  global.openShare = openShare;
  global.closeShare = closeShare;
  global.shareWeChat = shareWeChat;
  global.shareQQ = shareQQ;
  global.shareGitHub = shareGitHub;
  global.copyLink = copyLink;
  global.shareMail = shareMail;
  global.resetProgressConfirm = resetProgressConfirm;
  global.toast = toast;
  global.flashWordHighlight = flashWordHighlight;
  // 测试/调试辅助（不影响游戏功能）
  global.adjustDifficulty = adjustDifficulty;
  global.getAdaptive = function () { return { adj: state.adj || 0, adjHint: !!state.adjHint }; };
  global.bumpStreak = function (n) { state.streak = (state.streak || 0) + (n || 1); };
  // 时间闯关：全局入口（UI 与测试共用）
  global.useItem = useItem;
  global.openRank = openRank;
  global.closeRank = closeRank;
  global.startTimer = startTimer;
  global.stopTimer = stopTimer;
  global.tickTimer = tickTimer;
  global.timeUp = timeUp;
  global.adjustTimeScale = adjustTimeScale;
  global.timerEnabled = timerEnabled;
  global.toggleTimerMode = toggleTimerMode;
  global.toggleBgm = toggleBgm;
  global.showGuide = showGuide;
  global.nextGuide = nextGuide;
  global.closeGuide = closeGuide;
  global.getTimeState = function () {
    return { left: state.timeLeft, total: state.timeTotal, scale: state.timeScale,
             paused: state.timePaused, slowTicks: state.slowTicks, answered: state.answered,
             coins: state.timeCoinsEarned, newRecord: state.newRecord };
  };
  global.__testSetLeft = function (s) { state.timeLeft = s; state.timeTotal = Math.max(state.timeTotal, s); };
  global.__testSetLastRatio = function (r) { state.lastLeftRatio = r; };
  global.__testSetQStart = function () { state.qStart = Date.now(); };

  /* ---------- 初始化 ---------- */
  global.addEventListener('DOMContentLoaded', function () {
    initVoice();
    renderHome();
    renderDiff();
    renderSlots();
    renderTimerToggle();
    renderBgmToggle();
    // 恢复上次 BGM 状态（仅用户主动开启过才播）
    if (bgmEnabled() && global.bgmStart) global.bgmStart();
    // 新手引导：首次进入自动弹出（也可随时点顶栏 ❓ 查看）
    if (!global.localStorage.getItem('xb4-guide-shown')) { global.localStorage.setItem('xb4-guide-shown', '1'); setTimeout(showGuide, 400); }
    document.getElementById('shareMask').addEventListener('click', function (e) {
      if (e.target.id === 'shareMask') closeShare();
    });
  });
})(typeof window !== 'undefined' ? window : this);
