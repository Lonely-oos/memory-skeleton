#!/usr/bin/env node
/**
 * bench-retrieval.cjs —— 检索质量基准（Recall@k / MRR / 噪音 / 延迟）
 *
 * 为什么需要这个：
 *   在这之前，我们所有关于"它准不准"的判断都是感觉。性能有 bench、完整性有
 *   verify-backup，唯独**检索质量没有数字** —— 而那是这套东西唯一真正想做的事。
 *
 * 用一份"问题 → 应该命中哪些条目"的固定清单，每次改分词、权重、衰减、模型之后
 * 都跑一遍，就能回答三个问题：
 *   · 该被召回的有没有被召回（Recall@k）
 *   · 命中的排得靠不靠前（MRR）
 *   · 返回的里面有多少是无关的（噪音）
 *
 * 用法：
 *   node scripts/bench-retrieval.cjs questions.json
 *   node scripts/bench-retrieval.cjs questions.json --k 5 --db ./memory.db --verbose
 *
 * questions.json 格式：
 *   [
 *     { "q": "自然语言问题", "expect": [12, 34], "note": "可选说明" }
 *   ]
 *   expect 里任意一条进前 k 就算召回；按第一次命中的名次算 MRR。
 *
 * 注意：这份清单**必须写死答案 id**。用"模型觉得对"当正确答案，等于用自己验自己。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbm = require(path.join(ROOT, 'src', 'db.cjs'));
const { search } = require(path.join(ROOT, 'src', 'search.cjs'));

function parseArgs(argv) {
  const out = { file: null, k: 5, db: process.env.MEMORY_DB || path.join(ROOT, 'memory.db'), verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') out.k = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (!out.file) out.file = a;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.file) {
    console.error('usage: node scripts/bench-retrieval.cjs <questions.json> [--k 5] [--db path] [--verbose]');
    process.exit(2);
  }
  const cases = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) {
    console.error('questions.json 必须是非空数组');
    process.exit(2);
  }
  // 绝不静默新建：dbm.open 会 createFile，路径写错时会造出一个空库，
  // 基准于是跑在空库上 —— 看起来"Recall=0"，实际是没数据（第一次就栽在这）。
  if (!fs.existsSync(a.db)) {
    console.error('数据库不存在：%s\n用 --db 指定真实库路径（这个脚本不会替你新建）。', a.db);
    process.exit(2);
  }
  const db = dbm.open(a.db);
  dbm.migrate(db);

  let hit = 0;
  let mrrSum = 0;
  let noiseSum = 0;
  const lat = [];
  const rows = [];

  for (const c of cases) {
    const expect = new Set((c.expect || []).map(Number));
    const t0 = Date.now();
    // readonly：基准测试绝不能改变库状态（否则跑一次基准就等于"复习"了一遍）
    const r = await search(db, c.q, { limit: a.k, readonly: true });
    lat.push(Date.now() - t0);
    const ids = r.results.map((x) => Number(x.id));
    const rank = ids.findIndex((id) => expect.has(id));
    const isHit = rank >= 0;
    if (isHit) hit++;
    mrrSum += isHit ? 1 / (rank + 1) : 0;
    const noise = ids.filter((id) => !expect.has(id)).length;
    noiseSum += noise;
    rows.push({ q: c.q, ids, expect: [...expect], rank: isHit ? rank + 1 : null, noise });
  }
  db.close();

  const n = cases.length;
  lat.sort((x, y) => x - y);
  console.log('查询数 %d · k=%d · 库=%s', n, a.k, path.basename(a.db));
  console.log('');
  console.log('  Recall@%d   %s  (%d/%d)', a.k, (hit / n).toFixed(3), hit, n);
  console.log('  MRR         %s', (mrrSum / n).toFixed(3));
  console.log('  平均噪音    %s 条/问题（返回 %d 条里不属于答案的）', (noiseSum / n).toFixed(2), a.k);
  console.log('  延迟        p50 %d ms · p95 %d ms', pct(lat, 0.5), pct(lat, 0.95));
  console.log('');

  const miss = rows.filter((r) => r.rank === null);
  if (miss.length) {
    console.log('未召回 %d 条：', miss.length);
    for (const m of miss) console.log('  ✗ %s\n    期望 %s，实得 %s', m.q, m.expect.join(','), m.ids.join(',') || '(空)');
    console.log('');
  }
  if (a.verbose) {
    console.log('逐条：');
    for (const r of rows) {
      console.log('  %s %s rank=%s noise=%d', r.rank ? '✓' : '✗', r.q.slice(0, 28), r.rank || '-', r.noise);
    }
  }
  // 退出码：有未召回就不算通过（方便 CI / 定时任务判断）
  process.exit(miss.length ? 1 : 0);
})().catch((e) => { console.error('bench failed:', e); process.exit(1); });
