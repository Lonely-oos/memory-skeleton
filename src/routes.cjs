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

/** 本地墙钟 'YYYY-MM-DDTHH:mm:ss' —— 与库里主流格式（+08:00）对齐后截断比较 */
function wallClock(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 某天 00:00 的 Date（daysAgo>0 往过去；负数 = 未来） */
function dayStart(now, daysAgo) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/**
 * 「昨天」= 整个日历日，不是滚动 24 小时。
 * 用户说「昨天」时想的是那一整天，而不是"从此刻往回 24 小时"。
 * 窗口取半开区间 [最oldest那天 00:00, newest那天的次日 00:00)。
 */
function windowFor(daysAgoNewest, daysAgoOldest, label, now) {
  return {
    from: wallClock(dayStart(now, daysAgoOldest)),
    to: wallClock(dayStart(now, daysAgoNewest - 1)),
    label,
  };
}

/**
 * 从查询里解析时间窗。识别不出就返回 null（**不猜**）。
 *
 * ⚠️ 边界用**本地墙钟**（不带 Z、不带 +08:00），并且在 SQL 里用 `substr(o.ts,1,19)` 比较。
 * 原因（2026-10-29 实测）：库里的 ts 混了三种格式 —— `+08:00` 本地、只有日期、
 * 无时区的本地墙钟。拿 UTC 的 Z 边界去字符串比，跨格式会错位 8 小时。
 * @returns {{from:string, to:string, label:string}|null}
 */
function parseTimeWindow(query, { now = Date.now() } = {}) {
  const q = String(query || '');
  // 「N 天前」优先，比固定词更具体
  const m = /(\d{1,3})\s*天前/.exec(q);
  if (m) {
    const d = Number(m[1]);
    return windowFor(d, d, `${d} 天前`, now);
  }
  for (const h of HINTS) {
    if (h.re.test(q)) return windowFor(h.from, h.to, h.label, now);
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
        WHERE o.superseded_by IS NULL
          AND substr(o.ts, 1, 19) >= ? AND substr(o.ts, 1, 19) < ?${f.sql}
        ORDER BY substr(o.ts, 1, 19) DESC
        LIMIT ?`
    )
    .all(win.from, win.to, ...f.params, limit);
}

/** 实体路：查询里出现了已知实体名，就取那个实体的条目 */
function entitySearch(db, query, limit, f = { sql: '', params: [] }) {
  const q = String(query || '');
  const ents = db.prepare('SELECT id, name FROM entities').all();
  // 单字实体在中文里很常见（人名「汐」「暮」），不能一律挡掉；
  // 但代词必须挡：否则「我」会把半个库圈进来。（2026-10-29 实测：去掉长度守卫后
  // 「关于汐的记录」实体路从 0 变成有命中。）
  const PRONOUNS = new Set(['他', '她', '我', '你', '它', '您', '谁', '的', '人']);
  const matched = ents.filter((e) => {
    if (!e.name) return false;
    if (e.name.length >= 2) return q.includes(e.name);
    return !PRONOUNS.has(e.name) && q.includes(e.name);
  });
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
