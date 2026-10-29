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
  });
  console.log('wrote ids:', ids.join(', '));

  const res = await search(db, '第一条观察', { limit: 3 });
  console.log('keyword hits:', res.keywordHits, '(' + res.keywordMode + ')',
              '| vector hits:', res.vectorHits, res.vectorError ? '| vector error: ' + res.vectorError : '');

  const hits = res.results || [];
  console.log('hits:', hits.length);
  for (const h of hits.slice(0, 3)) {
    console.log(`  #${h.id} [${h.source}] ${String(h.content).slice(0, 40)}`);
  }

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
