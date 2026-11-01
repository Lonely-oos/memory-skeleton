#!/usr/bin/env node
/**
 * review-fixes.cjs —— 外部审查（2026-11-01）所报问题的回归测试
 *
 * 每条测试对应一个报告编号，断言的是「修完之后的行为」，不是「代码里有这行」。
 * 做法：每个用例自己建临时库，互相不污染。
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
const rank = require(path.join(ROOT, 'src', 'rank.cjs'));

const FAILS = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) FAILS.push(m); };

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const db = dbm.open(path.join(dir, 'memory.db'));
  dbm.migrate(db);
  return { dir, db };
}

(async () => {
  // ── MS-01：更正继承记忆元数据 ────────────────────────────────
  {
    const { dir, db } = freshDb();
    const [id] = writeObservations(db, {
      entity: 'MS01', entityType: '项目', domain: 'tech',
      observations: ['原始内容'], source: 'observed', affect: 8, affectWhy: '测试用：明确给高分',
    });
    const newId = correct(db, id, '更正后的内容', { source: 'observed' });
    const n = db.prepare('SELECT domain, affect, affect_why, hit_count FROM observations WHERE id = ?').get(newId);
    ok(n.domain === 'tech', 'MS-01 更正后 domain 保持 tech（实得 ' + n.domain + '）');
    ok(n.affect === 8, 'MS-01 更正后 affect 保持 8（实得 ' + n.affect + '）');
    ok(!!n.affect_why, 'MS-01 更正后 affect_why 不为空');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── MS-03：归档同步清理 FTS 与向量索引 ───────────────────────
  {
    const { dir, db } = freshDb();
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    writeObservations(db, {
      entity: 'MS03', entityType: '项目', domain: 'tech',
      observations: ['一条很老的记忆，用来验证归档', '第二条很老的记忆'],
      source: 'observed', ts: old,
    });
    const before = {
      obs: db.prepare('SELECT COUNT(*) n FROM observations').get().n,
      fts: db.prepare('SELECT COUNT(*) n FROM obs_fts').get().n,
    };
    const n = rank.archiveStale(db, { days: 180, dryRun: false });
    const after = {
      obs: db.prepare('SELECT COUNT(*) n FROM observations').get().n,
      fts: db.prepare('SELECT COUNT(*) n FROM obs_fts').get().n,
      arch: db.prepare('SELECT COUNT(*) n FROM archive_observations').get().n,
    };
    ok(n === 2, 'MS-03 归档了 2 条（实得 ' + n + '）');
    ok(after.obs === before.obs - 2, 'MS-03 主表减少 2 条');
    ok(after.fts === before.fts - 2, 'MS-03 FTS 索引同步减少 2 条（' + before.fts + ' → ' + after.fts + '）');
    ok(after.arch === 2, 'MS-03 档案表里有 2 条');
    const left = await search(db, '一条很老的记忆', { limit: 5, readonly: true });
    ok(left.results.length === 0, 'MS-03 归档后搜不到（不再有孤儿索引命中）');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── MS-04：归档时间按本地墙钟比较，混合格式不错位 ────────────
  {
    const { dir, db } = freshDb();
    const ins = db.prepare(`INSERT INTO observations(entity_id, content, source, ts, recorded_at, version,
      embedded, kind, domain, affect, hit_count, last_touch)
      VALUES (1,?, 'observed', ?, ?, 1, 0, 'memory', 'person', 5, 0, ?)`);
    db.prepare("INSERT INTO entities(name, type, created_at, updated_at, version) VALUES ('MS04','未分类','2026-01-01','2026-01-01',1)").run();
    const oldDateOnly = '2026-01-05';                                  // 只有日期
    const oldTz = '2026-01-06T10:00:00+08:00';                         // 带时区
    const oldNaive = '2026-01-07T10:00:00';                            // 无时区墙钟
    const recent = new Date().toISOString();
    ins.run('日期格式', oldDateOnly, oldDateOnly, oldDateOnly);
    ins.run('时区格式', oldTz, oldTz, oldTz);
    ins.run('墙钟格式', oldNaive, oldNaive, oldNaive);
    ins.run('新记录', recent, recent, recent);
    const n = rank.archiveStale(db, { days: 180, dryRun: false });
    ok(n === 3, 'MS-04 三种旧格式都被识别为过期（实得 ' + n + '）');
    ok(db.prepare('SELECT COUNT(*) n FROM observations').get().n === 1, 'MS-04 新记录未被误归档');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── MS-05：BACKUP_KEEP 非法值不能删光备份 ────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms05-'));
    const dbFile = path.join(dir, 'memory.db');
    const db = dbm.open(dbFile); dbm.migrate(db);
    writeObservations(db, { entity: 'MS05', entityType: '项目', observations: ['备份保留测试'], source: 'observed' });
    db.close();
    const root = path.join(dir, 'backups');
    fs.mkdirSync(root, { recursive: true });
    // 造 20 个历史备份目录（空目录足够触发剪枝逻辑）
    for (let i = 1; i <= 20; i++) {
      const name = `2020-01-${String(i).padStart(2, '0')}_000000`;
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'manifest.json'), '{}');
    }
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.cjs'), root], {
      env: { ...process.env, MEMORY_DB: dbFile, BACKUP_KEEP: '0' }, stdio: 'pipe',
    });
    const left = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d));
    ok(left.length >= 14, 'MS-05 BACKUP_KEEP=0 时按默认 14 保留，没删光（剩 ' + left.length + ' ）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── MS-06：只读检索不写库 ────────────────────────────────────
  {
    const { dir, db } = freshDb();
    writeObservations(db, { entity: 'MS06', entityType: '项目', observations: ['只读检索测试条目'], source: 'observed' });
    const snap = () => ({
      hit: db.prepare('SELECT hit_count FROM observations').get().hit_count,
      audit: db.prepare('SELECT COUNT(*) n FROM audit').get().n,
    });
    const before = snap();
    await search(db, '只读检索测试条目', { limit: 3, readonly: true });
    const after = snap();
    ok(after.hit === before.hit, 'MS-06 readonly 不增加 hit_count（' + before.hit + ' → ' + after.hit + '）');
    ok(after.audit === before.audit, 'MS-06 readonly 不写审计（' + before.audit + ' → ' + after.audit + '）');
    await search(db, '只读检索测试条目', { limit: 3 });
    const after2 = snap();
    ok(after2.hit > before.hit, 'MS-06 默认模式仍然回升（保持原行为）');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n' + (FAILS.length ? `===== ${FAILS.length} FAILED =====` : '===== all review fixes passed ====='));
  process.exit(FAILS.length ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
