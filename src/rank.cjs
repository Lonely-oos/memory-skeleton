#!/usr/bin/env node
/**
 * rank.cjs —— 衰减 + 加权打分 + 重排（按《记忆系统 v3 设计评审》）
 *
 * 三条硬约束（评审报告里明确写成"不许"的）：
 *
 *   1. **打分用加权和，绝不用相乘。**
 *      相乘会让中性记忆永远进不了前 5：情感分 0.1 的「吃了吗」，就算相关性 1.0，
 *      乘出来也只有 0.1；而「我们平时都聊什么」这类问题恰恰需要它。
 *
 *   2. **衰减在查询时算，不每天跑全库。**
 *      每天全表更新，库一大就慢；按需计算是 O(1)。指数衰减永远不会真正归零，
 *      所以「想得起来」天然成立。
 *
 *   3. **情感分只驱动 person 区；tech 区按类型。**
 *      技术结论会过期，但不会因为"情绪淡了"而变错 —— 拿情感分筛选技术知识是错的。
 */
'use strict';

/** 权重：相关性 > 情感 > 新鲜度 > 提及。加起来 1.0 */
const WEIGHTS = { relevance: 0.55, affect: 0.20, recency: 0.15, hit: 0.10 };

/** 情感分 → 稳定度（天）。来自评审报告表 5：半衰期 1/10/25/45 天。 */
const AFFECT_BANDS = [
  { max: 3, stability: 1.4, halfLife: 1 },
  { max: 6, stability: 14, halfLife: 10 },
  { max: 8, stability: 36, halfLife: 25 },
  { max: 10, stability: 65, halfLife: 45 },
];

/** tech 区按实体类型给稳定度（天）；Infinity = 永真不衰减 */
const TECH_STABILITY = {
  知识: Infinity,
  项目: 7,
  故障: 7,
  环境: 30,
};

const DAY_MS = 86400000;

/** 情感分 → 稳定度（天） */
function stabilityFor({ affect = 5, domain = 'person', entityType = '未分类' } = {}) {
  if (domain === 'tech') {
    const v = TECH_STABILITY[entityType];
    if (v === Infinity) return Infinity;
    if (typeof v === 'number') return v;
    return 14; // tech 区里没登记的实体类型：按"项目现状"量级处理
  }
  const a = Math.min(10, Math.max(1, Number(affect) || 5));
  for (const b of AFFECT_BANDS) if (a <= b.max) return b.stability;
  return 65;
}

/** 衰减：exp(-Δt/stability)。Infinity 稳定度 → 1（永不衰减） */
function decayFactor({ lastTouch, stability, now = Date.now() }) {
  if (!stability || stability === Infinity) return 1;
  const t = lastTouch ? new Date(lastTouch).getTime() : now;
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (now - t) / DAY_MS);
  return Math.exp(-days / stability);
}

/** 提及加分：min(0.1 * hit, 0.5)，**必须封顶**，否则一条老记忆会永久霸占检索位 */
function hitBoost(hitCount = 0) {
  return Math.min(0.1 * Math.max(0, Number(hitCount) || 0), 0.5);
}

/**
 * 单条打分。relevance 需已归一化到 0..1。
 * @returns {{score:number, parts:{relevance:number, affect:number, recency:number, hit:number}, stability:number}}
 */
function scoreOf(row, { now = Date.now() } = {}) {
  const relevance = Math.min(1, Math.max(0, Number(row.relevance) || 0));
  const affect = Math.min(1, Math.max(0, (Number(row.affect) || 5) / 10));
  const stability = stabilityFor(row);
  const recency = decayFactor({ lastTouch: row.last_touch || row.ts, stability, now });
  const hit = row.hit_count ? hitBoost(row.hit_count) : 0;
  const raw =
    WEIGHTS.relevance * relevance +
    WEIGHTS.affect * affect +
    WEIGHTS.recency * recency +
    WEIGHTS.hit * hit;
  return {
    score: Math.round(raw * 1e6) / 1e6,
    parts: { relevance, affect, recency, hit },
    stability,
  };
}

/**
 * 重排：先打分，再按阈值过滤，再取 top N。
 * **宁可少给，不要给错的** —— 低于阈值的一律不返回。
 */
function rerank(rows, { now = Date.now(), threshold = 0.35, limit = 5 } = {}) {
  const scored = rows.map((r) => {
    const s = scoreOf(r, { now });
    return { ...r, ...s };
  });
  const kept = scored.filter((r) => r.score >= threshold).sort((a, b) => b.score - a.score);
  return {
    kept: kept.slice(0, limit),
    droppedByThreshold: scored.filter((r) => r.score < threshold),
    threshold,
  };
}

/**
 * 提及回升（= 复习）：hit_count += 1、last_touch = now。
 * 冷却：同一条 24 小时内最多回升一次 —— 否则一次长对话里反复提到同一个词，
 * 会把它刷到最高分。
 * @returns {boolean} 是否真的回升了
 */
function touch(db, obsId, { now = new Date() } = {}) {
  const row = db.prepare('SELECT id, last_touch, hit_count FROM observations WHERE id = ?').get(obsId);
  if (!row) return false;
  const last = row.last_touch ? new Date(row.last_touch).getTime() : 0;
  const hit = Number(row.hit_count) || 0;
  // 冷却只拦「重复回升」：**首次必须放行**。
  // 曾经写成 `if (last && ...) return false`，结果刚写入的条目（last_touch = 写入时间）
  // 永远拿不到第一次 hit，hit 权重等于死的（2026-10-29 测试抓到的）。
  if (hit > 0 && last && now.getTime() - last < DAY_MS) return false;
  db.prepare('UPDATE observations SET hit_count = COALESCE(hit_count,0) + 1, last_touch = ? WHERE id = ?')
    .run(now.toISOString(), obsId);
  return true;
}

/**
 * 硬归档：超过 `days` 天没被命中过的条目移到 archive_observations。
 * 「容量自动收缩」在有持续新增时不成立，必须有一条硬线兜底。
 * @returns {number} 归档条数
 */
function archiveStale(db, { days = 180, now = Date.now(), dryRun = true } = {}) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS archive_observations (
    id INTEGER PRIMARY KEY, entity_id INTEGER, content TEXT, source TEXT,
    provenance TEXT, ts TEXT, recorded_at TEXT, supersedes INTEGER,
    superseded_by INTEGER, version INTEGER, embedded INTEGER, kind TEXT,
    session_id TEXT, domain TEXT, affect REAL, affect_why TEXT,
    hit_count INTEGER, last_touch TEXT, archived_at TEXT
  )`);
  const rows = db.prepare(
    'SELECT id FROM observations WHERE COALESCE(last_touch, ts) < ? AND superseded_by IS NULL'
  ).all(cutoff);
  if (dryRun) return rows.length;
  const ins = db.prepare(`INSERT INTO archive_observations
    (id, entity_id, content, source, provenance, ts, recorded_at, supersedes, superseded_by,
     version, embedded, kind, session_id, domain, affect, affect_why, hit_count, last_touch, archived_at)
    SELECT id, entity_id, content, source, provenance, ts, recorded_at, supersedes, superseded_by,
     version, embedded, kind, session_id, domain, affect, affect_why, hit_count, last_touch, ?
    FROM observations WHERE id = ?`);
  const del = db.prepare('DELETE FROM observations WHERE id = ?');
  const at = new Date(now).toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) { ins.run(at, r.id); del.run(r.id); }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return rows.length;
}

module.exports = {
  WEIGHTS, AFFECT_BANDS, TECH_STABILITY,
  stabilityFor, decayFactor, hitBoost, scoreOf, rerank, touch, archiveStale,
};
