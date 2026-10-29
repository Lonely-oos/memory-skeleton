'use strict';
/**
 * 只重建 FTS 索引，不动 observations、不动向量。
 * 改了分词规则 / 索引内容（比如把实体名也塞进 big 列）之后跑这个。
 */
const path = require('node:path');
const dbm = require('../src/db.cjs');
const bigram = require('../src/bigram.cjs');

function main() {
  const db = dbm.open();
  const rows = db
    .prepare(
      'SELECT o.id, o.content, e.name AS entity_name FROM observations o ' +
        'JOIN entities e ON e.id = o.entity_id ORDER BY o.id'
    )
    .all();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM obs_fts');
    for (const r of rows) {
      dbm.indexObservation(db, bigram, Number(r.id), r.content, r.entity_name);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  const n = db.prepare('SELECT COUNT(*) n FROM obs_fts').get().n;
  db.close();
  console.log(`reindexed ${rows.length} rows -> obs_fts has ${n}`);
}
main();
