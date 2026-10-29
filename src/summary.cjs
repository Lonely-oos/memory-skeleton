#!/usr/bin/env node
/**
 * summary.cjs —— 三层巩固（日结 / 周结 / 月结），**必须带 source_ids**
 *
 * 为什么必须带 source_ids：
 *   「锚定核心原始快照」如果没有具体形式，就只是一句希望。
 *   带 ID 之后，任何时候都能拿 ID 读回原文，对比摘要有没有走样；走样了就用原文重写。
 *
 * 为什么先只做"抽取"而不做"改写"：
 *   这一层**不调用模型**。摘要是"挑出当天最该记住的几条原文"，不是"让模型再写一遍"。
 *   后者每多一层就多一次漂移机会，而漂移在摘要上会被下一层放大。
 *   要更自然的文字，等这一层跑稳了再加，且必须继续带 source_ids。
 *
 * 分层：
 *   day   = 当天按 affect 排序取前 N 条原文
 *   week  = 该周内所有日结的并集（source_ids 取并集，正文按日截断拼接）
 *   month = 该月内所有日结的并集
 */
'use strict';

const MAX_CHARS = 120;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => String(ts || '').slice(0, 10);

/** ISO 周：2026-W44 */
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY,
    level TEXT NOT NULL,
    period TEXT NOT NULL,
    text TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(level, period)
  )`);
}

function save(db, { level, period, text, sourceIds }) {
  ensureSchema(db);
  db.prepare(
    `INSERT INTO summaries(level, period, text, source_ids, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(level, period) DO UPDATE SET
       text = excluded.text, source_ids = excluded.source_ids, created_at = excluded.created_at`
  ).run(level, period, text, JSON.stringify(sourceIds), new Date().toISOString());
}

/**
 * 日结：按 affect 降序取当天前 N 条原文。
 * @returns {{level:string, period:string, count:number, text:string, sourceIds:number[]}}
 */
function buildDaily(db, { period, limit = 20 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period || '')) throw new Error('period 必须是 YYYY-MM-DD');
  const rows = db
    .prepare(
      `SELECT id, ts, affect, source, substr(content, 1, ?) AS c
         FROM observations
        WHERE superseded_by IS NULL AND substr(ts, 1, 10) = ?
        ORDER BY COALESCE(affect, 5) DESC, ts ASC
        LIMIT ?`
    )
    .all(MAX_CHARS, period, limit);
  const text = rows.length
    ? rows.map((r) => `- [affect ${Number(r.affect ?? 5).toFixed(1)}] ${String(r.c).replace(/\s+/g, ' ')}`).join('\n')
    : '（这天没有可检索的记录）';
  const sourceIds = rows.map((r) => Number(r.id));
  save(db, { level: 'day', period, text, sourceIds });
  return { level: 'day', period, count: rows.length, text, sourceIds };
}

/** 周结/月结：把范围内已存在的日结并起来（source_ids 取并集） */
function buildRollup(db, { level, period }) {
  ensureSchema(db);
  const re = level === 'week' ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/;
  if (!re.test(period || '')) throw new Error(`period 格式不对：${period}`);
  const pick = db.prepare("SELECT period FROM summaries WHERE level = 'day'").all();
  const inRange = pick
    .filter(({ period: p }) => (level === 'week' ? isoWeek(p) === period : p.slice(0, 7) === period))
    .map(({ period: p }) => p)
    .sort();
  if (!inRange.length) throw new Error(`没有可用的日结覆盖 ${period}，先跑 buildDaily`);
  const days = db
    .prepare(
      `SELECT period, text, source_ids FROM summaries
        WHERE level = 'day' AND period IN (${inRange.map(() => '?').join(',')})
        ORDER BY period`
    )
    .all(...inRange);
  const ids = new Set();
  for (const d of days) for (const id of JSON.parse(d.source_ids)) ids.add(id);
  const text = days
    .map((d) => `## ${d.period}\n${d.text.split('\n').slice(0, 8).join('\n')}`)
    .join('\n\n');
  const sourceIds = [...ids].sort((a, b) => a - b);
  save(db, { level, period, text, sourceIds });
  return { level, period, count: days.length, text, sourceIds };
}

/**
 * 校验摘要：source_ids 是否都能读回原文。
 * **不能**自动判断"摘要有没有走样"——那需要人看；这里只保证追溯链是通的。
 */
function verify(db, { level, period }) {
  const row = db.prepare('SELECT * FROM summaries WHERE level = ? AND period = ?').get(level, period);
  if (!row) throw new Error(`没有这条摘要：${level}/${period}`);
  const ids = JSON.parse(row.source_ids);
  const found = ids.length
    ? db.prepare(`SELECT id FROM observations WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id)
    : [];
  const missing = ids.filter((id) => !found.includes(id));
  return {
    level, period,
    sourceCount: ids.length,
    resolvable: found.length,
    missing,
    traceable: missing.length === 0,
    textLength: row.text.length,
    createdAt: row.created_at,
  };
}

function list(db, { level, limit = 10 } = {}) {
  ensureSchema(db);
  const sql = level
    ? 'SELECT id, level, period, length(text) AS n, source_ids, created_at FROM summaries WHERE level = ? ORDER BY period DESC LIMIT ?'
    : 'SELECT id, level, period, length(text) AS n, source_ids, created_at FROM summaries ORDER BY period DESC LIMIT ?';
  const rows = level ? db.prepare(sql).all(level, limit) : db.prepare(sql).all(limit);
  return rows.map((r) => ({ ...r, sourceCount: JSON.parse(r.source_ids).length }));
}

module.exports = { buildDaily, buildRollup, verify, list, isoWeek, dayKey };
