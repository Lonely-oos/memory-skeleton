#!/usr/bin/env node
/**
 * backup.cjs —— 记忆库一致性快照 + 可校验清单
 *
 * 为什么不用「复制 memory.db」：
 *   库开着 WAL，还没并进主文件的那几条会**悄悄丢掉，而且不报错**。
 *   这里用 SQLite 的 `VACUUM INTO`：一致性快照，能读到 WAL 里已提交的内容，
 *   也不需要停服务。
 *
 * 为什么清单里要存 sha256：
 *   「文件复制过去了」和「备份能用」是两件事。sha256 + 计数是给
 *   `verify-backup.cjs` 用的 —— 它会把快照当真库打开、真查一次。
 *
 * 用法：
 *   node scripts/backup.cjs                # 存到 ./backups/<时间戳>/
 *   node scripts/backup.cjs /some/dir      # 存到指定根目录下
 *   MEMORY_DB=/path/to/memory.db node scripts/backup.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const HERE = path.resolve(__dirname, '..');
const DB = process.env.MEMORY_DB || path.join(HERE, 'memory.db');
const ROOT = process.argv[2] || path.join(HERE, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (!fs.existsSync(DB)) {
  console.error(`database not found: ${DB}\nSet MEMORY_DB, or create one in this directory.`);
  process.exit(2);
}

const dest = path.join(ROOT, stamp());
const snapDir = path.join(dest, 'snapshot');
fs.mkdirSync(snapDir, { recursive: true });
const snap = path.join(snapDir, 'memory.db');

// ── 1. 一致性快照 ────────────────────────────────────────────────
const src = new DatabaseSync(DB, { allowExtension: true });
src.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
src.close();

// ── 2. 计数（从快照本身数，不从原库数）──────────────────────────
const db = new DatabaseSync(snap, { allowExtension: true });
try { db.loadExtension(path.join(HERE, 'vec0.dll')); } catch { /* 没装扩展也能数别的表 */ }
const one = (sql) => {
  try { return db.prepare(sql).get().n; } catch { return undefined; }
};
const counts = {
  entities: one('SELECT COUNT(*) n FROM entities'),
  observations: one('SELECT COUNT(*) n FROM observations'),
  live: one('SELECT COUNT(*) n FROM live_observations'),
  relations: one('SELECT COUNT(*) n FROM relations'),
  fts: one('SELECT COUNT(*) n FROM obs_fts'),
  vec: one('SELECT COUNT(*) n FROM obs_vec'),
};
db.close();

// ── 3. 清单 + 恢复说明 ──────────────────────────────────────────
const files = [{
  label: 'snapshot/memory.db',
  to: snap,
  bytes: fs.statSync(snap).size,
  sha256: sha(snap),
}];

const manifest = {
  at: new Date().toISOString(),
  source: DB,
  counts,
  files,
};
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

fs.writeFileSync(path.join(dest, 'HOW-TO-RESTORE.txt'), `Backup: ${path.basename(dest)}
Taken at: ${manifest.at}
Counts: ${JSON.stringify(counts)}

What is here
  snapshot/memory.db   consistent snapshot (VACUUM INTO), includes committed WAL content
  manifest.json        file size + sha256 + counts, used by verify-backup.cjs

How to verify (do this before trusting it)
  node scripts/verify-backup.cjs "${dest}"

How to restore
  1) Stop the process that holds the live database.
  2) Rename the current memory.db (do NOT delete it), and remove memory.db-wal / memory.db-shm.
  3) Copy snapshot/memory.db into place.
  4) Start again.

Why not just copy the file
  A live SQLite database with WAL has committed pages that are not yet in the main
  file. A plain copy silently loses them. VACUUM INTO gives a consistent snapshot.
`, 'utf8');

console.log(`[backup] -> ${dest}`);
console.log(`[backup] file ${(files[0].bytes / 1048576).toFixed(2)} MB`);
console.log(`[backup] counts ${JSON.stringify(counts)}`);

// ── 4. 修剪（只动看着像本脚本产出的目录）───────────────────────
if (fs.existsSync(ROOT)) {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const extra = dirs.length - KEEP;
  if (extra > 0) {
    const drop = dirs.slice(0, extra);
    for (const name of drop) {
      fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
    }
    console.log(`[backup] keep ${KEEP}, pruned ${drop.length}: ${drop.join(', ')}`);
  }
}
