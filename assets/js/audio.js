/* ================================================================
 * XB4 单词闯关 · 发音 (audio)
 * ----------------------------------------------------------------
 * 四级回退，兼容安卓 / iOS / 桌面 / 离线环境：
 *   0) 本地预打包 mp3（assets/audio/{word}.mp3）—— 100% 命中，无网也响
 *   1) Web Speech API (SpeechSynthesis) —— 桌面 Chrome/Edge、iOS Safari
 *   2) 在线 TTS：<audio> 元素逐个尝试有道 / 百度 / Google
 *   3) 文本兜底（全部失败时）—— 题面单词短暂高亮 + 温和提示
 * ================================================================ */
(function (global) {
  'use strict';

  var voiceReady = false;
  var voiceChecked = false;
  var enVoice = null;
  var audioCache = Object.create(null);
  var HAS_LOCAL = true;

  /* 本地预打包 mp3 词表改为【动态派生】（修复安卓点单词无声的根因之一）：
   *  - 优先从 XB4_DATA.WORDS / SENTENCES 取全部单词，合并版与单单元版自动覆盖；
   *  - 任何“单个英文单词 / 连字符词”也视为本地候选：缺 mp3 时 onerror 快速回退，
   *    不再因硬编码白名单漏词而跳过 Tier-0 本地发音。 */
  var LOCAL_LOOKUP = Object.create(null);
  function initLocalVocab() {
    try {
      var d = global.XB4_DATA;
      var list = [];
      if (d && Array.isArray(d.WORDS)) d.WORDS.forEach(function (w) { if (w && w.word) list.push(String(w.word)); });
      if (d && Array.isArray(d.SENTENCES)) d.SENTENCES.forEach(function (s) { if (s && s.word) list.push(String(s.word)); });
      list.forEach(function (w) { LOCAL_LOOKUP[String(w).toLowerCase().trim()] = true; });
    } catch (_) {}
  }
  initLocalVocab();
  var WORD_RE = /^[a-z]+(?:[-'][a-z]+)*$/i;

  /* ---------------- Tier 0: 本地预打包 mp3 ---------------- */
  function localUrlFor(word) {
    var raw = String(word == null ? '' : word).trim().toLowerCase();
    if (!raw) return '';
    return 'assets/audio/' + raw + '.mp3';
  }
  function canLocalFor(text) {
    if (!HAS_LOCAL) return false;
    if (!text) return false;
    var t = String(text).toLowerCase().trim();
    return !!LOCAL_LOOKUP[t] || WORD_RE.test(t);
  }
  /* ---------------- 移动端手势解锁 ---------------- */
  var audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    // 移动端浏览器要求首个声音必须由用户手势触发。首次交互时用一段静音 wav
    // “解锁”媒体播放引擎，并预热 speechSynthesis 语音通道（iOS/部分安卓需要）。
    try {
      var s = new Audio();
      s.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
      var pr = s.play();
      if (pr && typeof pr.catch === 'function') pr.catch(function () {});
    } catch (_) {}
    try { if ('speechSynthesis' in global) global.speechSynthesis.cancel(); } catch (_) {}
  }
  function attachGestureUnlock() {
    if (typeof global.addEventListener === 'undefined') return;
    var events = ['touchstart', 'pointerdown', 'mousedown', 'keydown', 'click'];
    function handler() {
      unlockAudio();
      events.forEach(function (e) { try { global.removeEventListener(e, handler); } catch (_) {} });
    }
    events.forEach(function (e) { try { global.addEventListener(e, handler, { passive: true }); } catch (_) {} });
  }

  function speakViaLocalMp3(text) {
    return new Promise(function (resolve, reject) {
      if (typeof global.Audio === 'undefined') return reject(new Error('no-audio-api'));
      var key = text.toLowerCase().trim();
      var a = audioCache[key];
      if (!a) {
        try { a = new Audio(); a.preload = 'auto'; a.src = localUrlFor(text); audioCache[key] = a; }
        catch (e) { return reject(e); }
      } else {
        try { a.currentTime = 0; } catch (_) {}
      }
      var settled = false;
      function ok() { if (settled) return; settled = true; resolve(true); }
      function bad(err) { if (settled) return; settled = true; reject(err || new Error('local-failed')); }
      a.onerror = function () { bad(new Error('local-load-failed')); };
      // 关键修复：play() 被自动播放策略（安卓/微信更严格）拒绝时，必须 reject
      // 让上一级 fall through 到 SpeechSynthesis，而不是靠 oncanplay 误报“成功”。
      var watchdog = setTimeout(function () { bad(new Error('local-play-timeout')); }, 1500);
      var p;
      try { p = a.play(); } catch (e) { clearTimeout(watchdog); return bad(e); }
      if (p && typeof p.then === 'function') {
        p.then(function () { clearTimeout(watchdog); ok(); })
         .catch(function (err) { clearTimeout(watchdog); bad(err || new Error('play-rejected')); });
      } else {
        clearTimeout(watchdog); ok();
      }
    });
  }

  /* ---------------- Tier 1: Web Speech API ---------------- */
  function setVoice() {
    if (!('speechSynthesis' in global)) return;
    try {
      var vs = global.speechSynthesis.getVoices() || [];
      enVoice = vs.filter(function (v) { return /^en[-_]US/i.test(v.lang); })[0] ||
                vs.filter(function (v) { return /^en/i.test(v.lang); })[0] || null;
      voiceReady = !!enVoice;
    } catch (_) { enVoice = null; voiceReady = false; }
    voiceChecked = true;
  }
  function initVoice() {
    attachGestureUnlock();
    if (!('speechSynthesis' in global)) { voiceChecked = true; return; }
    setVoice();
    try { global.speechSynthesis.onvoiceschanged = setVoice; } catch (_) { voiceChecked = true; }
  }
  function canSpeakSync() {
    if (!('speechSynthesis' in global)) return false;
    if (voiceReady) return true;
    try {
      var vs = global.speechSynthesis.getVoices() || [];
      if (vs.length > 0) { setVoice(); return voiceReady; }
    } catch (_) {}
    return false;
  }
  function speakViaSpeechSynthesis(text) {
    return new Promise(function (resolve, reject) {
      if (!('speechSynthesis' in global)) return reject(new Error('no-speech-api'));
      try {
        global.speechSynthesis.cancel();
        var u = new global.SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = 0.9;
        if (enVoice) u.voice = enVoice;
        var done = false;
        function finish(ok, err) { if (done) return; done = true; ok ? resolve(true) : reject(err || new Error('speech-failed')); }
        u.onend = function () { finish(true); };
        u.onerror = function (e) { finish(false, e); };
        global.speechSynthesis.speak(u);
        setTimeout(function () { finish(true); }, 5000);
      } catch (e) { reject(e); }
    });
  }

  /* ---------------- Tier 2: 在线 TTS ---------------- */
  var TTS_ENDPOINTS = [
    { name: 'youdao-en',    url: function (w) { return 'https://dict.youdao.com/dictvoice?type=2&audio=' + encodeURIComponent(w); } },
    { name: 'youdao-en-uk', url: function (w) { return 'https://dict.youdao.com/dictvoice?type=1&audio=' + encodeURIComponent(w); } },
    { name: 'baidu-fanyi',  url: function (w) { return 'https://fanyi.baidu.com/gettts?lan=en&text=' + encodeURIComponent(w) + '&spd=3&source=web'; } },
    { name: 'google-gtx',   url: function (w) { return 'https://translate.googleapis.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(w) + '&tl=en&client=gtx'; } }
  ];
  function speakViaHttpTTS(text) {
    return new Promise(function (resolve, reject) {
      if (typeof global.Audio === 'undefined') return reject(new Error('no-audio-api'));
      var idx = 0, settled = false, audio = null, timer = null;
      function cleanup() { if (timer) { clearTimeout(timer); timer = null; } }
      function tryNext() {
        if (settled) return;
        if (idx >= TTS_ENDPOINTS.length) { settled = true; cleanup(); try { if (audio) { audio.oncanplay = null; audio.onerror = null; } } catch (_) {} reject(new Error('all-tts-failed')); return; }
        var ep = TTS_ENDPOINTS[idx++];
        try {
          audio = new Audio();
          audio.preload = 'auto';
          // 注意：不要设置 crossOrigin（有道/百度/Google 均无 CORS 头），
          // 否则音频元素会因 CORS 校验失败而 onerror，导致在线 TTS 全部落空。
          audio.oncanplay = function () {
            if (settled) return;
            var p;
            try { p = audio.play(); } catch (e) { tryNext(); return; }
            if (p && typeof p.then === 'function') {
              p.then(function () { if (!settled) { settled = true; cleanup(); resolve(ep.name); } }).catch(function () { tryNext(); });
            } else { settled = true; cleanup(); resolve(ep.name); }
          };
          audio.onerror = function () { tryNext(); };
          audio.src = ep.url(text);
        } catch (_) { tryNext(); }
      }
      timer = setTimeout(function () { if (!settled) { settled = true; cleanup(); reject(new Error('tts-timeout')); } }, 10000);
      tryNext();
    });
  }

  /* ---------------- Tier 3: 文本兜底 ---------------- */
  function speakViaFallback(text) {
    try { if (global.flashWordHighlight) global.flashWordHighlight(text); } catch (_) {}
    if (global.toast) global.toast('🔇 当前网络不可用，请参照题面上的单词和释义朗读');
  }

  /* ---------------- 对外主入口 ---------------- */
  function speak(text, opts) {
    opts = opts || {};
    if (!text) { var empty = { ok: false, method: 'none', error: 'empty-text' }; if (opts.callback) opts.callback(empty); return Promise.resolve(empty); }
    function finalize(r) { if (opts.callback) { try { opts.callback(r); } catch (_) {} } return r; }

    unlockAudio(); // 确保首次发音前媒体引擎已解锁（移动端）

    // 安卓（尤其微信内置浏览器）：SpeechSynthesis 常“报成功却无声”，
    // 而在线 TTS 走 <audio> 真实播放反而更稳 → 本地失败后【优先在线 TTS，再 Speech】；
    // iOS/桌面：SpeechSynthesis 稳定 → 保持“Speech 优先、在线 TTS 兜底”。
    var UA = (global.navigator && global.navigator.userAgent) || '';
    var isAndroid = /Android/i.test(UA) && !/iP(hone|ad|od)/i.test(UA);

    function tryHttpThenSpeech() {
      return speakViaHttpTTS(text).then(function (ep) {
        return finalize({ ok: true, method: 'http', text: text, endpoint: ep });
      }).catch(function () {
        if (canSpeakSync()) {
          return speakViaSpeechSynthesis(text).then(function () {
            return finalize({ ok: true, method: 'speech', text: text });
          }).catch(function (err) {
            speakViaFallback(text);
            return finalize({ ok: false, method: 'none', text: text, error: String((err && err.message) || err) });
          });
        }
        speakViaFallback(text);
        return finalize({ ok: false, method: 'none', text: text, error: 'all-failed' });
      });
    }
    function trySpeechThenHttp() {
      if (canSpeakSync()) {
        return speakViaSpeechSynthesis(text).then(function () {
          return finalize({ ok: true, method: 'speech', text: text });
        }).catch(function () {
          return speakViaHttpTTS(text).then(function (ep) {
            return finalize({ ok: true, method: 'http', text: text, endpoint: ep });
          }).catch(function (err) {
            speakViaFallback(text);
            return finalize({ ok: false, method: 'none', text: text, error: String((err && err.message) || err) });
          });
        });
      }
      return speakViaHttpTTS(text).then(function (ep) {
        return finalize({ ok: true, method: 'http', text: text, endpoint: ep });
      }).catch(function (err) {
        speakViaFallback(text);
        return finalize({ ok: false, method: 'none', text: text, error: String((err && err.message) || err) });
      });
    }

    if (canLocalFor(text)) {
      return speakViaLocalMp3(text).then(function () {
        return finalize({ ok: true, method: 'local', text: text, endpoint: localUrlFor(text) });
      }).catch(function () {
        // 本地 mp3 失败（404 / 解码失败 / 自动播放被拦截）→ 按平台走最优回退
        return isAndroid ? tryHttpThenSpeech() : trySpeechThenHttp();
      });
    }
    return isAndroid ? tryHttpThenSpeech() : trySpeechThenHttp();
  }

  /* ---------------- 英语鼓励音（用户要求：适当处添加） ----------------
   * praiseText(kind)：取一句鼓励语（供 UI 文字同步展示，保证"看得到"）
   * speakPraise(kind)：朗读该句（供"听得到"）
   * 播放链：SpeechSynthesis（只要有就尝试，不依赖语音列表是否就绪）
   *        → 在线 TTS（有道/百度/Google，短句都能读）→ 全部失败静默，绝不阻塞作答。
   */
  var PRAISE_POOL = {
    ok:   ['Great job!', 'Well done!', 'Perfect!', 'Nice work!', 'Excellent!', 'You got it!'],
    combo:["You\'re on fire!", 'Amazing!', 'Incredible!', 'Brilliant!', 'Fantastic!'],
    err:  ['Try again!', 'Don\'t give up!', 'Almost there!', 'Keep going!'],
    high: ['Amazing! You did it!', 'That\'s fantastic!', 'You are a star!'],
    mid:  ['Good job! Keep going!', 'Nice work! Well done!'],
    low:  ['Practice makes perfect!', 'Don\'t worry, keep trying!']
  };
  function praiseText(kind) {
    var pool = PRAISE_POOL[kind] || [];
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
  }
  /* 鼓励短句本地预打包 mp3（22 句，assets/audio/praise/），
   * 与 18 个单词同一 Tier-0 机制：手势内同步 play，安卓最稳，
   * 不依赖网络 / 英文语音包 / WebView 内核。 */
  function praiseSlug(phrase) {
    return String(phrase).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '-') + '.mp3';
  }
  function praiseLocalUrl(phrase) { return 'assets/audio/praise/' + praiseSlug(phrase); }
  function speakPraiseViaLocal(phrase) {
    return new Promise(function (resolve, reject) {
      if (typeof global.Audio === 'undefined') return reject(new Error('no-audio-api'));
      var a;
      try { a = new Audio(); a.preload = 'auto'; a.src = praiseLocalUrl(phrase); }
      catch (e) { return reject(e); }
      var settled = false;
      function ok() { if (settled) return; settled = true; resolve(true); }
      function bad(err) { if (settled) return; settled = true; reject(err || new Error('praise-local-failed')); }
      a.onerror = function () { bad(new Error('praise-local-load-failed')); };
      // 关键：play() 在 speakPraise 的调用栈内同步执行（用户手势内）→ 安卓放行
      var watchdog = setTimeout(function () { bad(new Error('praise-local-timeout')); }, 3000);
      var p;
      try { p = a.play(); } catch (e) { clearTimeout(watchdog); return bad(e); }
      if (p && typeof p.then === 'function') {
        p.then(function () { clearTimeout(watchdog); ok(); })
         .catch(function (err) { clearTimeout(watchdog); bad(err || new Error('praise-play-rejected')); });
      } else {
        clearTimeout(watchdog); ok();
      }
    });
  }
  /* 鼓励音播放链：
   *   Tier 0 本地 mp3（手势内同步 play，安卓最稳，与单词发音同机制）
   *   Tier 1 SpeechSynthesis（等 onend 才算成功；onerror/2.5s 无回调→下一级；
   *           Chrome Android cancel 后延迟 150ms；iOS 手势内同步）
   *   Tier 2 在线 TTS（有道/百度/Google）
   *   全失败 → 静默（UI 文字仍显示英文鼓励语，双通道兜底） */
  function speakPraise(kind) {
    var phrase = praiseText(kind);
    if (!phrase) return Promise.resolve({ ok: false, method: 'none', kind: kind });
    unlockAudio(); // 移动端必须先解锁媒体引擎，否则首音被拦截
    // Tier 0：本地预打包短句 mp3
    return speakPraiseViaLocal(phrase).then(function () {
      return { ok: true, method: 'local', kind: kind, phrase: phrase, endpoint: praiseLocalUrl(phrase) };
    }).catch(function () {
      return speakPraiseFallback(phrase, kind);
    });
  }
  function speakPraiseFallback(phrase, kind) {
    if (!('speechSynthesis' in global)) {
      // 无语音 API（jsdom / 极老浏览器）→ 静默
      return Promise.resolve({ ok: false, method: 'none', kind: kind, phrase: phrase });
    }
    var UA = (global.navigator && global.navigator.userAgent) || '';
    var isWeChatAndroid = /MicroMessenger/i.test(UA) && /Android/i.test(UA);
    if (isWeChatAndroid) {
      // 安卓微信：speechSynthesis 不可靠 → 在线 TTS
      return speakViaHttpTTS(phrase).then(function (ep) {
        return { ok: true, method: 'http', kind: kind, phrase: phrase, endpoint: ep };
      }).catch(function () {
        return { ok: false, method: 'none', kind: kind, phrase: phrase };
      });
    }
    // 普通环境：SpeechSynthesis，等 onend/onerror/超时判定成败
    return new Promise(function (resolve) {
      var settled = false;
      function settle(res) { if (settled) return; settled = true; resolve(res); }
      try {
        var speakNow = function () {
          try {
            var u = new global.SpeechSynthesisUtterance(phrase);
            u.lang = 'en-US'; u.rate = 1.05; u.volume = 0.95;
            if (enVoice) u.voice = enVoice;
            u.onend = function () { settle({ ok: true, method: 'speech', kind: kind, phrase: phrase }); };
            u.onerror = function () { settle({ ok: false, method: 'speech-failed', kind: kind, phrase: phrase }); };
            global.speechSynthesis.speak(u);
            setTimeout(function () {
              settle({ ok: false, method: 'speech-timeout', kind: kind, phrase: phrase });
            }, 2500);
          } catch (e) {
            settle({ ok: false, method: 'speech-error', kind: kind, phrase: phrase });
          }
        };
        // iOS Safari：speak() 必须在用户手势内同步调用（延迟会被忽略）→ 直接播
        // 安卓 Chrome：cancel() 后立即 speak() 会无声 → 延迟 150ms 再播
        var isIOS = /iP(hone|ad|od)/i.test(UA);
        if (isIOS) {
          try { global.speechSynthesis.cancel(); } catch (_) {}
          speakNow();
        } else {
          try { global.speechSynthesis.cancel(); } catch (_) {}
          setTimeout(speakNow, 150);
        }
      } catch (e) {
        settle({ ok: false, method: 'speech-error', kind: kind, phrase: phrase });
      }
    }).then(function (r) {
      if (r.ok) return r;
      // speech 失败/超时 → 在线 TTS 兜底
      return speakViaHttpTTS(phrase).then(function (ep) {
        return { ok: true, method: 'http', kind: kind, phrase: phrase, endpoint: ep };
      }).catch(function () {
        return { ok: false, method: 'none', kind: kind, phrase: phrase };
      });
    });
  }

  function detect() {
    return { speech: canSpeakSync(), audio: typeof global.Audio !== 'undefined', local: HAS_LOCAL, cacheSize: Object.keys(audioCache).length };
  }

  /* ---------------- 时间闯关：紧张音效（Web Audio 合成，零依赖） ----------------
   * tickSound：剩余 ≤10s 每秒滴答（800Hz 短促）；alarmSound：≤5s 双音告警。 */
  var _audioCtx = null;
  function ctx() {
    try {
      if (!_audioCtx) {
        var AC = global.AudioContext || (global.webkitAudioContext);
        if (!AC) return null;
        _audioCtx = new AC();
      }
      if (_audioCtx.state === 'suspended') { try { _audioCtx.resume(); } catch (e) {} }
      return _audioCtx;
    } catch (e) { return null; }
  }
  function beep(freq, dur, when, vol) {
    var c = ctx();
    if (!c) return;
    try {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'square'; o.frequency.value = freq;
      var t0 = c.currentTime + (when || 0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.08));
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + (dur || 0.08) + 0.02);
    } catch (e) {}
  }
  function tickSound() { beep(800, 0.06, 0, 0.06); }
  function alarmSound() { beep(1200, 0.12, 0, 0.09); beep(1600, 0.12, 0.15, 0.09); }

  /* ---------------- 背景音乐（Web Audio 合成柔和琶音，零依赖） ----------------
   * 默认关闭（课堂场景安全），由首页开关主动开启。低音量、循环上行/下行琶音。 */
  var BGM_NOTES = [261.63, 329.63, 392.00, 440.00, 392.00, 329.63, 293.66, 261.63]; // C E G A G E D C
  var bgmTimer = null, bgmStep = 0;
  function bgmNote() {
    var c = ctx();
    if (!c) return;
    try {
      var f = BGM_NOTES[bgmStep % BGM_NOTES.length]; bgmStep++;
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      var t0 = c.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.028, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + 0.45);
    } catch (e) {}
  }
  function bgmStart() {
    if (bgmTimer) return;
    if (!ctx()) return; // 无 AudioContext（老浏览器/测试环境）→ 静默
    bgmStep = 0;
    bgmTimer = setInterval(bgmNote, 560);
  }
  function bgmStop() { if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; } }

  global.XB4_AUDIO = { initVoice: initVoice, speak: speak, speakPraise: speakPraise, praiseText: praiseText, detect: detect, canSpeakSync: canSpeakSync, canLocalFor: canLocalFor, tickSound: tickSound, alarmSound: alarmSound, bgmStart: bgmStart, bgmStop: bgmStop };
  global.initVoice = initVoice;
  global.speak = speak;
  global.speakPraise = speakPraise;
  global.praiseText = praiseText;
  global.tickSound = tickSound;
  global.alarmSound = alarmSound;
  global.bgmStart = bgmStart;
  global.bgmStop = bgmStop;
})(typeof window !== 'undefined' ? window : this);
