'use strict';
/**
 * 审计日志 —— 记录每一次检索 / 写入 / 更正。
 *
 * 设计约束（很重要）：
 *  1. **失败绝不打断主流程。** 所有操作包在 try/catch 里，审计坏了检索照常。
 *  2. **可关闭。** MEMORY_AUDIT=0 时一行不写（跑批量脚本时可以关）。
 *  3. **不会无限涨。** 超过 MEMORY_AUDIT_KEEP 条（默认 2 万）时删最旧的。
 *
 * 要能回答的三个问题（这是审计存在的理由）：
 *  - 这条记忆为什么被注入了？   → event='retrieve'，看 chosen + scores
 *  - 这条记忆为什么被淘汰了？   → event='decay' / 'archive'（阶段 3 才有）
 *  - 上次说哮喘是从哪条来的？   → 检索 query 或按内容反查
 */

const ENABLED = process.env.MEMORY_AUDIT !== '0';
const KEEP_ROWS = Number(process.env.MEMORY_AUDIT_KEEP ?? 20000);

let counter = 0;

function maybePrune(db) {
  if (++counter % 200 !== 0) return;
  try {
    const max = db.prepare('SELECT MAX(id) m FROM audit').get().m;
    if (!max || max <= KEEP_ROWS) return;
    db.prepare('DELETE FROM audit WHERE id <= ?').run(max - KEEP_ROWS);
  } catch { /* ignore */ }
}

/**
 * @param {object} db  sqlite 连接
 * @param {string} event  retrieve | write | correct | decay | archive | merge | conflict
 * @param {object} [data] {session, query, candidates, chosen, scores, reason}
 */
function log(db, event, data = {}) {
  if (!ENABLED) return;
  try {
    db.prepare(
      'INSERT INTO audit(ts,event,session,query,candidates,chosen,scores,reason) ' +
      'VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      new Date().toISOString(),
      String(event),
      data.session ?? null,
      data.query != null ? String(data.query) : null,
      data.candidates != null ? JSON.stringify(data.candidates) : null,
      data.chosen != null ? JSON.stringify(data.chosen) : null,
      data.scores != null ? JSON.stringify(data.scores) : null,
      data.reason != null ? String(data.reason) : null
    );
    maybePrune(db);
  } catch { /* 审计失败不许影响主流程 */ }
}

function tail(db, n = 20) {
  try {
    return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(n);
  } catch { return []; }
}

function stats(db) {
  try {
    const total = db.prepare('SELECT COUNT(*) n FROM audit').get().n;
    const byEvent = db.prepare('SELECT event, COUNT(*) n FROM audit GROUP BY event ORDER BY n DESC').all();
    return { total, byEvent, enabled: ENABLED };
  } catch { return { total: 0, byEvent: [], enabled: ENABLED }; }
}

module.exports = { log, tail, stats, ENABLED };
