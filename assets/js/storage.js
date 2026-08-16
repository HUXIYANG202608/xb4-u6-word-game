/* ============================================================
 * XB4 单词闯关 · 本地持久化 (storage)
 * ------------------------------------------------------------
 * 基于 localStorage 保存学习记录（错词本 / 掌握度 / 待复习），
 * 并驱动 SM-2 间隔重复调度。所有函数均为纯数据操作，不碰 DOM。
 * ============================================================ */
(function (global) {
  'use strict';

  var LS_KEY = 'xb4-learn-v1';
  var DIFF_KEY = 'xb4-diff';
  var DAY = 86400000;

  function loadLearn() {
    try { return JSON.parse(global.localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveLearn(o) {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // quality: 0~5（SuperMemo SM-2 评分）。答对记 5，答错记 1。
  function recordAttempt(word, quality) {
    var m = loadLearn();
    var w = String(word).toLowerCase();
    var rec = m[w] || { ease: 2.5, interval: 0, reps: 0, wrong: 0, correct: 0, due: Date.now() };
    var r = global.XB4_CORE.sm2(rec.ease, rec.interval, rec.reps, quality);
    rec.ease = r.ease;
    rec.interval = r.interval;
    rec.reps = r.reps;
    rec.due = Date.now() + r.interval * DAY;
    if (quality >= 3) rec.correct = (rec.correct || 0) + 1;
    else rec.wrong = (rec.wrong || 0) + 1;
    m[w] = rec;
    saveLearn(m);
    return rec;
  }

  function getStats() {
    var m = loadLearn();
    var now = Date.now();
    var learned = 0, mastered = 0, due = 0, wrong = 0;
    Object.keys(m).forEach(function (k) {
      var r = m[k];
      learned++;
      if ((r.interval || 0) >= 21 || (r.reps || 0) >= 3) mastered++;
      if ((r.due || 0) <= now) due++;
      if ((r.wrong || 0) > 0) wrong++;
    });
    return { learned: learned, mastered: mastered, due: due, wrong: wrong };
  }

  function getReviewWords() {
    var m = loadLearn();
    var now = Date.now();
    var set = {};
    Object.keys(m).forEach(function (k) {
      var r = m[k];
      if ((r.due || 0) <= now || (r.wrong || 0) > 0) set[k] = true;
    });
    return global.ALL_WORDS.filter(function (w) { return set[w.word.toLowerCase()]; });
  }

  function getDiff() { return global.localStorage.getItem(DIFF_KEY) || 'normal'; }
  function setDiff(k) { global.localStorage.setItem(DIFF_KEY, k); }
  function resetProgress() {
    try { global.localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  /* 3.7 埋点：词级作答统计（正确率 / 平均用时 / 错误字母混淆矩阵）
   * 结构：{ word: { n, ok, totalMs, errs: { 'i>e': 2, 'c>k': 1 } } }
   * 用于数据验证难度合理性：词正确率<40% 判过难、>95% 判过易；混淆矩阵反哺形近干扰池。 */
  var WSTAT_KEY = 'xb4-wstat';
  function loadWstat() {
    try { return JSON.parse(global.localStorage.getItem(WSTAT_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function recordWordStat(word, correct, ms, errPairs) {
    var m = loadWstat();
    var w = String(word == null ? '' : word).toLowerCase();
    if (!w) return null;
    var rec = m[w] || { n: 0, ok: 0, totalMs: 0, errs: {} };
    rec.n = (rec.n || 0) + 1;
    if (correct) rec.ok = (rec.ok || 0) + 1;
    if (typeof ms === 'number' && !isNaN(ms) && ms >= 0) rec.totalMs = (rec.totalMs || 0) + ms;
    (errPairs || []).forEach(function (p) {
      if (!p) return;
      var k = (p.expected || '?') + '>' + (p.got || '?');
      rec.errs[k] = (rec.errs[k] || 0) + 1;
    });
    m[w] = rec;
    try { global.localStorage.setItem(WSTAT_KEY, JSON.stringify(m)); } catch (e) {}
    return rec;
  }
  function getWordStats() { return loadWstat(); }

  /* ============ 时间闯关：道具 / 时间币 / 最佳时间排行榜（设计方案 §3/§5） ============ */
  var ITEMS_KEY = 'xb4-items';
  var COINS_KEY = 'xb4-coins';
  var BEST_KEY = 'xb4-besttime';
  var GIFT_KEY = 'xb4-time-gift';

  function loadJSON(k) { try { return JSON.parse(global.localStorage.getItem(k)) || {}; } catch (e) { return {}; } }
  function saveJSON(k, o) { try { global.localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} }

  /* 新手礼包：首次进入计时模式送 ⏸暂停×1 + ⏱加时×1 */
  function ensureTimeGift() {
    try {
      if (global.localStorage.getItem(GIFT_KEY)) return;
      global.localStorage.setItem(GIFT_KEY, '1');
      var it = loadJSON(ITEMS_KEY);
      it.pause = (it.pause || 0) + 1;
      it.bonus = (it.bonus || 0) + 1;
      saveJSON(ITEMS_KEY, it);
    } catch (e) {}
  }
  function getItems() { return loadJSON(ITEMS_KEY); }
  function addItem(type, n) {
    var it = loadJSON(ITEMS_KEY);
    it[type] = (it[type] || 0) + (n || 1);
    saveJSON(ITEMS_KEY, it);
    return it;
  }
  function consumeItem(type) {
    var it = loadJSON(ITEMS_KEY);
    if (!(it[type] > 0)) return false;
    it[type] -= 1;
    saveJSON(ITEMS_KEY, it);
    return true;
  }
  function getCoins() { var c = parseInt(global.localStorage.getItem(COINS_KEY) || '0', 10); return isNaN(c) ? 0 : c; }
  function addCoins(n) {
    var c = getCoins() + (n || 0);
    try { global.localStorage.setItem(COINS_KEY, String(Math.max(0, c))); } catch (e) {}
    return getCoins();
  }
  function getBestTime() { return loadJSON(BEST_KEY); }
  /* 返回 true 表示破纪录 */
  function setBestTime(word, ms) {
    var m = loadJSON(BEST_KEY);
    var w = String(word == null ? '' : word).toLowerCase();
    if (!w) return false;
    var rec = m[w];
    if (rec && rec.ms <= ms) return false;
    m[w] = { ms: Math.round(ms), date: new Date().toISOString() };
    saveJSON(BEST_KEY, m);
    return true;
  }

  global.XB4_STORE = {
    loadLearn: loadLearn, saveLearn: saveLearn, recordAttempt: recordAttempt,
    getStats: getStats, getReviewWords: getReviewWords, getDiff: getDiff,
    setDiff: setDiff, resetProgress: resetProgress,
    recordWordStat: recordWordStat, getWordStats: getWordStats,
    ensureTimeGift: ensureTimeGift, getItems: getItems, addItem: addItem,
    consumeItem: consumeItem, getCoins: getCoins, addCoins: addCoins,
    getBestTime: getBestTime, setBestTime: setBestTime
  };
  global.getStats = getStats;
  global.getReviewWords = getReviewWords;
  global.getDiff = getDiff;
  global.setDiff = setDiff;
  global.recordAttempt = recordAttempt;
  global.resetProgress = resetProgress;
  global.recordWordStat = recordWordStat;
  global.getWordStats = getWordStats;
  global.ensureTimeGift = ensureTimeGift;
  global.getItems = getItems;
  global.addItem = addItem;
  global.consumeItem = consumeItem;
  global.getCoins = getCoins;
  global.addCoins = addCoins;
  global.getBestTime = getBestTime;
  global.setBestTime = setBestTime;
})(typeof window !== 'undefined' ? window : this);
