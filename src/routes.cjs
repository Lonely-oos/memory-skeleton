#!/usr/bin/env node
/**
 * routes.cjs —— 四路召回里缺的两路：**时间路** 与 **实体路**
 *
 * 为什么需要：
 *   - 关键词路回答"字面上像不像"，向量路回答"意思近不近"。
 *   - 但「上周发生了什么」字面上没有内容词，向量也抓不到范围；
 *     「关于他的事」同理——那是**范围**问题，不是相似度问题。
 * 所以这两路不做排序，只做**圈定候选**，再交给 fuse + 加权打分去排。
 *
 * 设计上的一条：**时间路只认显式时间词**。
 *   「最近」这类模糊词会被当成 7 天，但绝不猜"大概几周"——猜出来的范围比不召回更糟。
 */
'use strict';

const DAY = 86400000;

/** 时间词 → 距离今天的天数区间 [fromDaysAgo, toDaysAgo]（含两端） */
const HINTS = [
  { re: /(今天|今日|刚才|今天晚上|今天早上)/, from: 0, to: 0, label: '今天' },
  { re: /(昨天|昨晚|昨日)/, from: 1, to: 1, label: '昨天' },
  { re: /(前天)/, from: 2, to: 2, label: '前天' },
  { re: /(大前天)/, from: 3, to: 3, label: '大前天' },
  { re: /(本周|这周|这个星期)/, from: 0, to: 6, label: '本周' },
  { re: /(上周|上个星期|上星期)/, from: 7, to: 13, label: '上周' },
  { re: /(最近|近期|这几天|前两天|这阵子)/, from: 0, to: 7, label: '最近 7 天' },
  { re: /(本月|这个月)/, from: 0, to: 30, label: '本月' },
  { re: /(上个月|上月)/, from: 31, to: 60, label: '上个月' },
];

/**
 * 从查询里解析时间窗。识别不出就返回 null（**不猜**）。
 * @returns {{from:string, to:string, label:string}|null}
 */
function parseTimeWindow(query, { now = Date.now() } = {}) {
  const q = String(query || '');
  // 「N 天前」优先，比固定词更具体
  const m = /(\d{1,3})\s*天前/.exec(q);
  if (m) {
    const d = Number(m[1]);
    const from = new Date(now - (d + 1) * DAY);
    const to = new Date(now - d * DAY);
    return { from: from.toISOString(), to: to.toISOString(), label: `${d} 天前` };
  }
  for (const h of HINTS) {
    if (h.re.test(q)) {
      const from = new Date(now - (h.to + 1) * DAY);
      const to = new Date(now - h.from * DAY);
      return { from: from.toISOString(), to: to.toISOString(), label: h.label };
    }
  }
  return null;
}

const COLS = `o.id, o.content, o.source, o.ts, o.recorded_at, o.provenance,
              o.kind, o.session_id, o.domain, o.affect, o.hit_count, o.last_touch,
              e.name AS entity_name, e.type AS entity_type`;

/** 时间路：给定窗口，按时间倒序取候选 */
function timeSearch(db, win, limit, f = { sql: '', params: [] }) {
  if (!win) return [];
  return db
    .prepare(
      `SELECT ${COLS}, NULL AS _big, NULL AS bm25_score
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.superseded_by IS NULL AND o.ts >= ? AND o.ts < ?${f.sql}
        ORDER BY o.ts DESC
        LIMIT ?`
    )
    .all(win.from, win.to, ...f.params, limit);
}

/** 实体路：查询里出现了已知实体名，就取那个实体的条目 */
function entitySearch(db, query, limit, f = { sql: '', params: [] }) {
  const q = String(query || '');
  const ents = db.prepare('SELECT id, name FROM entities').all();
  // 实体名至少 2 个字符，避免「他」「我」这类单字实体把什么都圈进来
  const matched = ents.filter((e) => e.name && e.name.length >= 2 && q.includes(e.name));
  if (!matched.length) return { rows: [], matched: [] };
  const ph = matched.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ${COLS}, NULL AS _big, NULL AS bm25_score
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.superseded_by IS NULL AND o.entity_id IN (${ph})${f.sql}
        ORDER BY COALESCE(o.affect, 5) DESC, o.ts DESC
        LIMIT ?`
    )
    .all(...matched.map((m) => m.id), ...f.params, limit);
  return { rows, matched: matched.map((m) => m.name) };
}

module.exports = { parseTimeWindow, timeSearch, entitySearch, HINTS, COLS };
