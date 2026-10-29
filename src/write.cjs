'use strict';
/**
 * 写入原语。**所有写入必须走这里，不要裸 SQL INSERT** ——
 * 裸 INSERT 不会更新 obs_fts，条目在库里但搜不到（阶段 B 核验时踩到过一次）。
 */
const bigram = require('./bigram.cjs');
const audit = require('./audit.cjs');
const dbm = require('./db.cjs');

/**
 * 一次写多条观察（同一个实体）。
 *
 * `kind` 三选一（v2 新增，**这是"记忆库别变成工作日志"的那道闸**）：
 *   memory（默认）= 关于他、关于项目、关于世界的长期事实
 *   process       = 我做过什么。**默认不进检索** —— 那是日志，不是记忆。
 *   note          = 还没定型的草稿/待办
 *
 * @returns {number[]} 新条目 id
 */
function writeObservations(db, {
  entity, entityType, observations,
  source = 'i-inferred', ts, provenance = null,
  kind = 'memory', session_id = null,
} = {}) {
  if (!entity) throw new Error('必须给 entity');
  if (!Array.isArray(observations) || !observations.length) {
    throw new Error('observations 必须是非空数组');
  }
  const now = dbm.nowISO();
  const t = ts || now;
  db.exec('BEGIN');
  try {
    const entityId = dbm.upsertEntity(db, {
      name: entity, type: entityType || '未分类', at: now,
    });
    const ids = [];
    for (const content of observations) {
      const id = dbm.insertObservation(db, bigram, {
        entity_id: entityId, entity_name: entity, content,
        source, provenance, kind, session_id, ts: t,
      });
      ids.push(id);
    }
    db.exec('COMMIT');
    // ── 审计：写了什么（失败不影响写入结果）──
    audit.log(db, 'write', {
      session: session_id,
      candidates: { entity, count: ids.length, kind, source, ts: t },
      chosen: ids,
      reason: 'provenance=' + (provenance || 'null'),
    });
    return ids;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 更正一条观察：**不删除旧的**，新旧之间连双向指针。
 * 旧条目从此不再出现在检索结果里（superseded_by IS NOT NULL），但永远查得到。
 *
 * source 默认 `i-inferred`，不是 `he-said` —— 我刚才自己发现一处过时信息就改了，
 * 那不是「他说的」。默认值要挑「最不冒认」的那个：写错了顶多是自认推断，
 * 写成「他说」就是替他签字。（阶段 C 实测把这句写反过，已改。）
 *
 * @returns {number} 新条目 id
 */
function correct(db, obsId, newContent, {
  source = 'i-inferred', reason = null, ts, session_id = null, kind = null,
} = {}) {
  const old = db.prepare('SELECT * FROM observations WHERE id = ?').get(obsId);
  if (!old) throw new Error(`没有 #${obsId} 这条`);
  if (old.superseded_by != null) {
    throw new Error(`#${obsId} 已被 #${old.superseded_by} 更正过，不能再更正一次（不许链式盖掉历史）`);
  }
  const ent = db.prepare('SELECT name FROM entities WHERE id = ?').get(old.entity_id);
  const now = dbm.nowISO();
  const t = ts || now;
  // 更正继承原条目的 kind —— 改一条记忆还是一记忆，不该因为"改过"就掉进 process。
  const newKind = kind || old.kind || 'memory';

  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        'INSERT INTO observations(entity_id, content, source, provenance, kind, session_id, ts, recorded_at, supersedes) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        old.entity_id, newContent, source,
        reason ? `更正 #${obsId}：${reason}` : `更正 #${obsId}`,
        newKind, session_id, t, now, obsId
      );
    const newId = Number(r.lastInsertRowid);
    db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(newId, obsId);
    // FTS 索引在事务内写，保证「搜得到」和「写成功」是同一件事
    dbm.indexObservation(db, bigram, newId, newContent, ent ? ent.name : '');
    db.exec('COMMIT');
    return newId;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { writeObservations, correct };
