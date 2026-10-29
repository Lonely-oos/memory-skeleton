#!/usr/bin/env node
/**
 * verify-backup.cjs —— 校验一份备份**能不能用**，不是"文件在不在"
 *
 * 做三件事：
 *   1) 清单里每个文件：大小 + sha256 对不对
 *   2) 把快照**当成真的库打开**：vec0 扩展能加载、各表计数与备份时一致
 *   3) **真做一次向量检索**：取一条已存在的向量当查询，它必须第一个搜到自己
 *
 * 第 3 步是关键。前两步通过、第 3 步不过，说明索引是坏的 —— 那种备份
 * 恢复回去，读得出条目但搜不到语义，等于只剩一半。
 *
 * 用法：
 *   node scripts/verify-backup.cjs backups/2026-01-01_120000
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/verify-backup.cjs <backup-directory>');
  process.exit(2);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const fails = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { fails.push(m); console.log(`  FAIL ${m}`); };

console.log(`verify: ${dir}\n`);

// ── 1. 文件完整性 ───────────────────────────────────────────────
console.log('[1] files (size + sha256)');
const manPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manPath)) {
  console.error('manifest.json not found — not a backup directory produced by backup.cjs');
  process.exit(2);
}
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
for (const f of man.files) {
  if (!fs.existsSync(f.to)) { bad(`${f.label} - missing`); continue; }
  const sz = fs.statSync(f.to).size;
  if (sz !== f.bytes) { bad(`${f.label} - size ${sz} != ${f.bytes}`); continue; }
  if (sha(f.to) !== f.sha256) { bad(`${f.label} - sha256 mismatch`); continue; }
  ok(`${f.label} (${sz} bytes)`);
}

// ── 2. 快照可用性 + 计数 ────────────────────────────────────────
console.log('\n[2] snapshot opens and counts match');
const snap = path.join(dir, 'snapshot', 'memory.db');
let db = null;
if (!fs.existsSync(snap)) {
  bad('snapshot/memory.db missing');
} else {
  try {
    db = new DatabaseSync(snap, { allowExtension: true });
    ok('snapshot opens');
  } catch (e) {
    bad(`cannot open: ${e.message}`);
  }
  if (db) {
    // 扩展按平台可选：没有 vec0 动态库时只做关键词库，这不算备份失败
    try {
      db.loadExtension(path.join(path.resolve(__dirname, '..'), 'vec0.dll'));
      ok('vec0 extension loads');
    } catch (e) {
      ok(`vec0 extension not available here (${String(e.message).slice(0, 40)}) - keyword-only mode`);
    }
  }
}
if (db) {
  const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return undefined; } };
  const counts = {
    entities: one('SELECT COUNT(*) n FROM entities'),
    observations: one('SELECT COUNT(*) n FROM observations'),
    live: one('SELECT COUNT(*) n FROM live_observations'),
    relations: one('SELECT COUNT(*) n FROM relations'),
    fts: one('SELECT COUNT(*) n FROM obs_fts'),
    vec: one('SELECT COUNT(*) n FROM obs_vec'),
  };
  for (const [k, v] of Object.entries(counts)) {
    if (v === undefined) continue;
    if (man.counts[k] === undefined) ok(`count ${k} = ${v} (not recorded at backup time)`);
    else if (v === man.counts[k]) ok(`count ${k} = ${v}`);
    else bad(`count ${k} = ${v}, but backup recorded ${man.counts[k]}`);
  }

  // ── 3. 真做一次向量检索 ──────────────────────────────────────
  console.log('\n[3] vector search round-trip');
  const hasVec = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'obs_vec'").get();
  if (!hasVec) {
    ok('no obs_vec table in this snapshot (keyword-only database) - skipped');
  } else {
  const row = db.prepare('SELECT obs_id, embedding FROM obs_vec LIMIT 1').get();
  if (!row) {
    // 空向量表是合法状态：没开 Ollama 时就是只做关键词检索
    if (!man.counts.vec) ok('no vectors in this backup (semantic search not in use) - skipped');
    else bad('backup recorded ' + man.counts.vec + ' vectors, but obs_vec is empty');
  } else {
    const hits = db.prepare(
      'SELECT obs_id, distance FROM obs_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 3'
    ).all(row.embedding);
    if (!hits.length) bad('vector search returned nothing - index is probably broken');
    else if (hits[0].obs_id !== row.obs_id || hits[0].distance > 1e-4) {
      bad(`vector search wrong: query #${row.obs_id} -> #${hits[0].obs_id} (distance ${hits[0].distance})`);
    } else {
      ok(`vector search ok: #${row.obs_id} finds itself, distance ${hits[0].distance.toFixed(6)}`);
    }
  }
  }
  db.close();
}

console.log('\n' + (fails.length ? `===== ${fails.length} FAILED =====` : '===== all checks passed ====='));
process.exit(fails.length ? 1 : 0);
