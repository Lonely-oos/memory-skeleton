#!/usr/bin/env node
/**
 * smoke-test.cjs —— 建一个空库、写两条、搜一次、备份、再校验。
 *
 * 这个脚本存在的意义：证明这套东西**在别人的机器上也能跑**，
 * 而不是只在作者的环境里能跑。跑完会把临时目录打印出来，可自行删除。
 *
 *   node examples/smoke-test.cjs
 *
 * 语义检索需要本机 Ollama + bge-m3；没有的话会自动退化成纯关键词，
 * 并在输出里说明（这是设计的一部分，不是失败）。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const dbm = require(path.join(ROOT, 'src', 'db.cjs'));
const { writeObservations, correct } = require(path.join(ROOT, 'src', 'write.cjs'));
const { search } = require(path.join(ROOT, 'src', 'search.cjs'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-skeleton-'));
  const dbPath = path.join(tmp, 'memory.db');
  console.log('tmp db:', dbPath);

  const db = dbm.open(dbPath);
  dbm.migrate(db);

  const ids = writeObservations(db, {
    entity: 'demo-project',
    entityType: '项目',
    observations: [
      '2026-01-01：第一条观察，用来验证写入链路。',
      '2026-01-02：第二条观察，用来验证语义检索能把相关的两条排在一起。',
    ],
    source: 'observed',
    provenance: 'smoke-test',
    kind: 'memory',
    domain: 'tech',
  });
  console.log('wrote ids:', ids.join(', '));

  // 情感分必须带 why（这是硬约束：没有 why 的分数不许入档）
  let whyGuard = 'NOT TESTED';
  try {
    writeObservations(db, {
      entity: 'demo-person', entityType: '人物', domain: 'person',
      observations: ['他确诊了，住院三天。'], source: 'he-said', affect: 9,
    });
    whyGuard = 'FAILED: 给了 affect 但没给 why，却写进去了';
  } catch (e) {
    whyGuard = 'ok: 无 why 的分数被拒绝 (' + e.message.slice(0, 20) + '...)';
  }
  console.log('why guard ->', whyGuard);

  const [id2] = writeObservations(db, {
    entity: 'demo-person', entityType: '人物', domain: 'person',
    observations: ['他确诊了，住院三天，说话比平时少。'], source: 'he-said',
  });
  const row2 = db.prepare('SELECT affect, affect_why, domain FROM observations WHERE id = ?').get(id2);
  console.log('auto affect ->', row2.affect, '| why:', row2.affect_why);

  const res = await search(db, '第一条观察', { limit: 3 });
  console.log('keyword hits:', res.keywordHits, '(' + res.keywordMode + ')',
              '| vector hits:', res.vectorHits, res.vectorError ? '| vector error: ' + res.vectorError : '');

  const hits = res.results || [];
  console.log('hits:', hits.length, '| threshold:', res.ranked.threshold, '| dropped by threshold:', res.ranked.dropped);
  for (const h of hits.slice(0, 3)) {
    const p = h.parts || {};
    console.log(`  #${h.id} score=${h.score} (rel ${p.relevance?.toFixed(2)} affect ${p.affect?.toFixed(2)} rec ${p.recency?.toFixed(3)} hit ${p.hit}) stability=${h.stability}`);
  }

  // 衰减：把一条改成 100 天前的低情感记忆，它应当被阈值挡掉
  const rank = require(path.join(ROOT, 'src', 'rank.cjs'));
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  db.prepare('UPDATE observations SET affect = 1, last_touch = ? WHERE id = ?').run(old, ids[1]);
  const decayed = rank.scoreOf({ relevance: 1, affect: 1, last_touch: old, domain: 'person' });
  console.log('decay check -> 100 天前 + affect 1 的分数:', decayed.score, '(stability', decayed.stability, '天)');

  const newId = correct(db, ids[0], '2026-01-01：第一条观察（已更正），用来验证"更正而不覆盖"。', {
    source: 'observed',
  });
  console.log('corrected -> new id', newId);

  db.close();

  // 备份 + 校验：真正证明"备份能用"
  const env = { ...process.env, MEMORY_DB: dbPath };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.cjs'), path.join(tmp, 'backups')], { env, encoding: 'utf8' });
  const backupDir = (out.match(/-> (.+)/) || [])[1];
  console.log(String(out).trim().split('\n').map((l) => '  ' + l).join('\n'));

  if (backupDir && fs.existsSync(backupDir)) {
    const v = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-backup.cjs'), backupDir], { encoding: 'utf8' });
    console.log(String(v).trim().split('\n').map((l) => '  ' + l).join('\n'));
  }

  console.log('\nOK. 临时目录（可删）：', tmp);
})().catch((e) => {
  console.error('smoke test failed:', e);
  process.exit(1);
});
