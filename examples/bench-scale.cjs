#!/usr/bin/env node
/**
 * bench-scale.cjs —— 规模基准：不同条目数下的建库耗时、库体积、检索延迟
 *
 * ⚠️ 说明两件事，别被数字骗：
 *   1. 向量是**随机生成的假向量**（1024 维），不是 bge-m3 的输出。
 *      这只测"索引体积 + KNN 查询"，不测语义质量。
 *      —— 真跑 10 万条 embedding 要几小时，那不是这份基准要回答的问题。
 *   2. 查询集是固定的中文短语，关键词路会真的命中；KNN 路对假向量没有语义意义，
 *      所以它的耗时只能看"索引规模对查询延迟的影响"，不能看"召回准不准"。
 *
 * 用法：
 *   node examples/bench-scale.cjs 10000
 *   node examples/bench-scale.cjs 10000 50000
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbm = require(path.join(ROOT, 'src', 'db.cjs'));
const { search } = require(path.join(ROOT, 'src', 'search.cjs'));

const DIM = 1024;
const QUERIES = [
  '长期记忆 衰减', '备份 能否恢复', '昨天做了什么', '关于某个实体',
  '检索 融合 排序', '出处 更正', '向量 索引', '中文 分词',
  '这个短语大概搜不到什么', '开源 发布 版本',
];

const pad = (n, w = 8) => String(n).padStart(w);

function fakeVec() {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.random() * 2 - 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return Array.from(v);
}

async function build(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${n}-`));
  const dbPath = path.join(dir, 'memory.db');
  const t0 = Date.now();
  const db = dbm.open(dbPath);
  dbm.migrate(db);
  const tMigrate = Date.now() - t0;

  // 实体只建 50 个，模拟"少量实体、大量观察"的真实分布
  const ents = [];
  for (let i = 0; i < 50; i++) ents.push(dbm.upsertEntity(db, { name: `实体${i}`, type: i % 3 === 0 ? '项目' : '人物', at: dbm.nowISO() }));

  const insObs = db.prepare(
    `INSERT INTO observations(entity_id, content, source, provenance, ts, recorded_at, version,
       embedded, kind, session_id, domain, affect, affect_why, hit_count, last_touch)
     VALUES (?,?,?,?,?,?,1,1,?,NULL,?,?,?,0,?)`
  );
  const insFts = db.prepare('INSERT INTO obs_fts(rowid, content, entity_name, big) VALUES (?,?,?,?)');
  const insVec = db.prepare('INSERT INTO obs_vec(obs_id, embedding) VALUES (?, ?)');
  const bigram = require(path.join(ROOT, 'src', 'bigram.cjs'));
  const words = ['记忆', '衰减', '检索', '备份', '恢复', '向量', '中文', '排序', '出处', '更正', '昨天', '实体'];

  db.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    const e = ents[i % ents.length];
    const content = `第 ${i} 条：${words[i % words.length]}${words[(i * 7) % words.length]}的记录，用于规模基准。`;
    const ts = new Date(Date.now() - (i % 900) * 86400000).toISOString();
    const r = insObs.run(e, content, i % 5 === 0 ? 'he-said' : 'observed', 'bench', ts, ts,
      i % 11 === 0 ? 'process' : 'memory', i % 3 === 0 ? 'tech' : 'person', 5, '基准数据 · 中性');
    const id = Number(r.lastInsertRowid);
    insFts.run(id, content, `实体${i % 50}`, bigram.indexText(content));
    insVec.run(BigInt(id), JSON.stringify(fakeVec()));
  }
  db.exec('COMMIT');
  const tInsert = Date.now() - t0 - tMigrate;

  // 检索延迟：关键词 + 时间 + 实体路（跳过向量，因为假向量没语义）
  const lat = [];
  for (let round = 0; round < 3; round++) {
    for (const q of QUERIES) {
      const s = Date.now();
      await search(db, q, { limit: 5, touch: false, keywordOnly: true });
      lat.push(Date.now() - s);
    }
  }
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];

  // KNN 索引本身的耗时（假向量，只测索引规模）
  const qv = JSON.stringify(fakeVec());
  const knn = [];
  for (let i = 0; i < 20; i++) {
    const s = Date.now();
    db.prepare('SELECT obs_id, distance FROM obs_vec WHERE embedding MATCH ? AND k = 5 ORDER BY distance').all(qv);
    knn.push(Date.now() - s);
  }
  knn.sort((a, b) => a - b);

  // 备份耗时（VACUUM INTO）
  const t1 = Date.now();
  const snap = path.join(dir, 'snap.db');
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  const tBackup = Date.now() - t1;
  db.close();

  const bytes = fs.statSync(dbPath).size;
  const snapBytes = fs.statSync(snap).size;
  fs.rmSync(dir, { recursive: true, force: true });

  return {
    n, tMigrate, tInsert, bytes, snapBytes, tBackup,
    searchP50: pct(0.5), searchP95: pct(0.95), searchMax: lat[lat.length - 1],
    knnP50: knn[10], knnP95: knn[Math.floor(knn.length * 0.95)],
  };
}

(async () => {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  if (!sizes.length) sizes.push(10000);
  console.log('条目数 | 建库(ms) | 写入(ms) | 库体积 | 快照 | 备份(ms) | 检索p50 | 检索p95 | 检索max | KNN p50 | KNN p95');
  console.log('---'.repeat(9));
  for (const n of sizes) {
    const r = await build(n);
    console.log(
      [pad(r.n), pad(r.tMigrate), pad(r.tInsert),
       pad((r.bytes / 1048576).toFixed(1) + 'MB'), pad((r.snapBytes / 1048576).toFixed(1) + 'MB'),
       pad(r.tBackup), pad(r.searchP50), pad(r.searchP95), pad(r.searchMax),
       pad(r.knnP50 + 'ms'), pad(r.knnP95 + 'ms')].join(' | ')
    );
  }
})().catch((e) => { console.error('bench failed:', e.message); process.exit(1); });
