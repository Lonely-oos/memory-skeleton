#!/usr/bin/env node
/**
 * archive.cjs —— 把长期没被命中的记忆移出检索表（硬归档）
 *
 * 为什么需要它：
 *   `rank.archiveStale()` 写在库里很久了，但**从来没有被调用过** —— 一个只在函数里
 *   存在的策略等于没有。数据会一直长，检索会一直变慢（KNN 约 4.2 ms/千条），
 *   而"该淡出的东西"永远占着候选名额。
 *
 * 它做什么：
 *   把 `COALESCE(last_touch, ts)` 早于 N 天、且未被更正的条目，
 *   在**一个事务里**移到 `archive_observations`，同时删掉 FTS 与向量索引。
 *   **不删除任何内容** —— 归档表里原文、出处、情感分全在，随时可以捞回来。
 *
 * 安全设计（都很朴素，但每条都是为了"别在凌晨四点毁掉库"）：
 *   · 默认 dry-run，只报数不写库；必须显式 `--apply`
 *   · `--days` 小于 30 直接拒绝（防手滑写成 18）
 *   · 库文件不存在就报错，绝不新建（会被误当空库归档）
 *   · 归档量超过总量的 50% 时拒绝执行并报错（异常情况要人看一眼）
 *
 * 用法：
 *   node scripts/archive.cjs --db <库> --days 180            # 只看会归档多少
 *   node scripts/archive.cjs --db <库> --days 180 --apply    # 真的归档
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbm = require(path.join(ROOT, 'src', 'db.cjs'));
const rank = require(path.join(ROOT, 'src', 'rank.cjs'));
const audit = require(path.join(ROOT, 'src', 'audit.cjs'));

function parseArgs(argv) {
  const out = { days: 180, apply: false, db: process.env.MEMORY_DB || path.join(ROOT, 'memory.db') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--apply') out.apply = true;
    else if (a === '--db') out.db = argv[++i];
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv);
  if (!Number.isFinite(a.days) || a.days < 30) {
    console.error('--days 必须是 ≥30 的数字（收到 %s）。小于 30 天几乎一定是手滑。', String(a.days));
    return 2;
  }
  if (!fs.existsSync(a.db)) {
    console.error('数据库不存在：%s\n用 --db 指定（不会替你新建）。', a.db);
    return 2;
  }
  const db = dbm.open(a.db);
  dbm.migrate(db);

  const total = db.prepare('SELECT COUNT(*) n FROM observations WHERE superseded_by IS NULL').get().n;
  const candidates = rank.archiveStale(db, { days: a.days, dryRun: true });
  const ratio = total ? candidates / total : 0;

  const stamp = new Date().toISOString();
  console.log(
    `[${stamp}] 库=${path.basename(a.db)} 天数=${a.days} 现有 ${total} 条，` +
    `可归档 ${candidates} 条（${(ratio * 100).toFixed(1)}%）`
  );

  if (!a.apply) {
    console.log('dry-run：没有写库。加 --apply 才会真的移动。');
    db.close();
    return 0;
  }
  if (candidates === 0) {
    console.log('没有需要归档的条目，退出。');
    db.close();
    return 0;
  }
  // 异常保护：一次要归档掉一半以上，说明天数是错的或者时间字段坏了
  if (ratio > 0.5) {
    console.error('拒绝执行：可归档条目占总量的 %.1f%%（>50%%）。请人工确认天数与时间字段。', ratio * 100);
    db.close();
    return 3;
  }

  const moved = rank.archiveStale(db, { days: a.days, dryRun: false });
  const left = db.prepare('SELECT COUNT(*) n FROM observations WHERE superseded_by IS NULL').get().n;
  const fts = db.prepare('SELECT COUNT(*) n FROM obs_fts').get().n;
  let vec = null;
  try { vec = db.prepare('SELECT COUNT(*) n FROM obs_vec').get().n; } catch { /* 无扩展 */ }
  console.log(`已归档 ${moved} 条；剩余可检索 ${left} 条；FTS ${fts}；向量 ${vec === null ? 'n/a' : vec}`);

  // 审计：归档是可追溯动作，必须留痕（回答"这条为什么搜不到了"）
  try {
    audit.log(db, 'archive', {
      query: null,
      candidates: { days: a.days, before: total, eligible: candidates },
      chosen: [],
      scores: null,
      reason: `归档 ${moved} 条：${a.days} 天未被命中的条目移入 archive_observations（原文件与索引同步清理）`,
    });
  } catch { /* 审计失败不影响已经完成的归档 */ }

  db.close();
  return 0;
}

process.exit(main());
