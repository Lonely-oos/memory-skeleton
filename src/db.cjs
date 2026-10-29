'use strict';
/**
 * memory.db 的连接、建表、写入原语。
 *
 * 数据库位置：默认 ./memory.db，可用 MEMORY_DB 环境变量覆盖
 * 扩展：同目录上级的 vec0.dll（sqlite-vec v0.1.9）
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const VEC_DLL = path.join(ROOT, 'vec0.dll');
// 默认放仓库根目录；用 MEMORY_DB 环境变量可覆盖（指向绝对路径）
const DB_PATH = process.env.MEMORY_DB || path.join(ROOT, 'memory.db');

const SCHEMA_VERSION = 2;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY,
  entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  -- 出处（一）：谁说的。三种取值是强约束，不许自由发挥。
  source        TEXT NOT NULL CHECK (source IN ('he-said','i-inferred','observed')),
  -- 出处（二）：这条从哪儿搬来的。手工写的为 NULL；从 graph.jsonl 迁入的记文件名。
  provenance    TEXT,
  -- 【v2 新增】这条记忆属于哪一类。**这是"记忆库别变成工作日志"的那道闸。**
  --   memory  = 关于他、关于项目、关于世界的**长期事实**（默认）
  --   process = **我做过什么**（"我改了 X 文件"、"我跑了 Y"）。默认**不进检索** —— 那是日志，不是记忆。
  --   note    = 还没定型的草稿/待办
  kind          TEXT NOT NULL DEFAULT 'memory'
                CHECK (kind IN ('memory','process','note')),
  -- 【v2 新增】哪条会话写的。MCP server 从环境变量 DSH_SESSION_ID 自动填，不用手写。
  session_id    TEXT,
  -- 时间戳（一）：事情发生的时间。**允许两种精度**（2026-10-07 定，见 README「决定 6」）：
  --   ① 'YYYY-MM-DD'                = 只知道哪一天。目前只有 graph.jsonl 迁入的 100 条
  --      （原文件没有时间戳，migrate.cjs:19 一个 TS 常量写死，所以它们全是同一天）
  --   ② 'YYYY-MM-DDTHH:MM:SS+08:00' = 知道时刻。nowISO() 写的都是这种，25 字符
  --   消费方规则：一律按**字符串前缀**比较（SQL 里 ts >= ? 或 substr(ts,1,10)），
  --   **禁止 new Date(ts)** —— '2026-10-07' 会被当成 UTC 午夜，在 UTC+8 下就是本地 08:00，平白差 8 小时。
  --   （记这条不是因为有代码正踩，而是因为下一个写代码的人会踩。）
  --   ⚠ 别用 recorded_at 回填那 100 条：那是迁移进程跑起来的同一秒，不是事情发生的时间。
  ts            TEXT NOT NULL,
  -- 时间戳（二）：我把它写下来的时间
  recorded_at   TEXT NOT NULL,
  -- 冲突规则：被更正的条目挂指针，不再删除。检索默认只出 superseded_by IS NULL 的。
  supersedes    INTEGER REFERENCES observations(id),
  superseded_by INTEGER REFERENCES observations(id),
  -- 【v2 删除】confidence。
  --   建库时留了这个字段，156 条全部为 NULL —— 一次没用过。
  --   而"给一条记忆打 0.7 的可信度"是**假精度**（同 README 里拒绝加权求和的那个理由）。
  --   **建了不用的字段是负债**：下一个我读 schema 会以为这里有可信度分级。所以删掉。
  version       INTEGER NOT NULL DEFAULT 1,
  -- 0 = 向量还没算（Ollama 没开也算写入成功，后台补）
  embedded      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_obs_entity   ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_obs_live     ON observations(superseded_by);
CREATE INDEX IF NOT EXISTS idx_obs_pending  ON observations(embedded);
-- ⚠️ idx_obs_kind **不能写在这里**：老库的 observations 还没有 kind 列，
--    而 CREATE TABLE IF NOT EXISTS 会被跳过、索引却要建 → 报「no such column: kind」。
--    它挪到 migrate() 里、ALTER 之后建（2026-10-07 实测撞到）。
--    顺带一个坑：**SQL 注释里不能出现反引号** —— 那会提前结束 JS 的模板字符串。

CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  -- 【v2 新增】同上，哪条会话写的
  session_id TEXT,
  ts         TEXT NOT NULL,
  UNIQUE(from_id, to_id, kind)
);

CREATE VIEW IF NOT EXISTS live_observations AS
  SELECT o.*, e.name AS entity_name, e.type AS entity_type
  FROM observations o JOIN entities e ON e.id = o.entity_id
  WHERE o.superseded_by IS NULL;
`;

/**
 * 打开数据库。allowExtension 必须在建连接时就传（阶段 A 实测：
 * 写成 enableLoadExtension 会静默无效，事后调用 loadExtension 报
 * "extension loading is not allowed"）。
 */
function open(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(VEC_DLL);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * 建表 + 升级（幂等）。虚表单独判存在，因为 `CREATE VIRTUAL TABLE IF NOT EXISTS`
 * 各扩展行为不一致。
 *
 * ⚠️ **SQLite 的 ALTER TABLE 不支持"如果不存在才加"** —— 每次都得先查 `PRAGMA table_info`。
 * 这就是为什么下面写成一串 if，而不是一条 SQL。**上面 CREATE 里的新列只对新库生效**，
 * 老库靠这里的 ALTER 补 —— 两边必须手工保持一致，改一处要改两处。
 */
function migrate(db) {
  db.exec(TABLES);
  const has = (name) =>
    !!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name);
  const cols = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

  // ---------- v2：kind / session_id / 删 confidence ----------
  const obsCols = cols('observations');
  db.exec('BEGIN');
  try {
    if (!obsCols.includes('kind')) {
      db.exec(
        "ALTER TABLE observations ADD COLUMN kind TEXT NOT NULL DEFAULT 'memory'"
      );
    }
    if (!obsCols.includes('session_id')) {
      db.exec('ALTER TABLE observations ADD COLUMN session_id TEXT');
    }
    if (obsCols.includes('confidence')) {
      // 156 条全 NULL，一次没用过。留着会骗下一个我「这里有可信度分级」。
      db.exec('ALTER TABLE observations DROP COLUMN confidence');
    }
    if (!cols('relations').includes('session_id')) {
      db.exec('ALTER TABLE relations ADD COLUMN session_id TEXT');
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  if (!has('obs_fts')) {
    db.exec(
      "CREATE VIRTUAL TABLE obs_fts USING fts5(content, entity_name, big, tokenize='unicode61')"
    );
  }
  if (!has('obs_vec')) {
    db.exec(
      'CREATE VIRTUAL TABLE obs_vec USING vec0(' +
        'obs_id INTEGER PRIMARY KEY, embedding FLOAT[1024] distance_metric=cosine)'
    );
  }
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/**
 * 本地时间戳（带时区偏移，如 2026-10-07T06:00:00+08:00）。
 *
 * **不要用 `new Date().toISOString()`** —— 那是 UTC。在 UTC+8 下，每天 08:00 之前
 * 写进去的东西会被记成「昨天」。阶段 C 实测撞到过：2026-10-07 06:00 写的一条更正，
 * 记成了 2026-10-06。日期错一天，在「按时间看演变」的时候就是错的。
 */
function nowISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

/** 取实体 id，没有就建。 */
function upsertEntity(db, { name, type, at }) {
  const now = at || nowISO();
  const found = db.prepare('SELECT id FROM entities WHERE name = ?').get(name);
  if (found) return Number(found.id);
  const r = db
    .prepare(
      'INSERT INTO entities(name, type, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(name, type, now, now);
  return Number(r.lastInsertRowid);
}

/**
 * 写一条观察（含 FTS 索引）。向量不在这里算 —— 见 embed.cjs。
 * 返回新条目 id。
 */
function insertObservation(db, bigram, o) {
  const now = o.recorded_at || nowISO();
  const entityId = o.entity_id != null ? o.entity_id : upsertEntity(db, {
    name: o.entity_name, type: o.entity_type || '未分类', at: now,
  });
  const r = db
    .prepare(
      'INSERT INTO observations ' +
        '(entity_id, content, source, provenance, kind, session_id, ts, recorded_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      entityId, o.content, o.source, o.provenance ?? null,
      o.kind || 'memory', o.session_id ?? null,
      o.ts || now, now
    );
  const id = Number(r.lastInsertRowid);
  indexObservation(db, bigram, id, o.content, o.entity_name);
  return id;
}

/**
 * 写一条实体关系（幂等：同一个 from/to/kind 只会有一条）。
 * 返回 { id, created }。
 *
 * ⚠️ 关系表从阶段 B 迁移进来 10 条之后**一直没长过** —— 因为 5 个工具里根本没有写关系的。
 * 这个函数就是补那个缺口（配套 MCP 工具 `relate`）。
 */
function upsertRelation(db, { from, to, kind, session_id, ts, fromType, toType }) {
  if (!from || !to) throw new Error('relate 需要 from 和 to');
  if (!kind) throw new Error('relate 需要 kind（关系名，如「正在建设」「属于」）');
  const now = ts || nowISO();
  const a = upsertEntity(db, { name: from, type: fromType || '未分类', at: now });
  const b = upsertEntity(db, { name: to, type: toType || '未分类', at: now });
  const found = db
    .prepare('SELECT id FROM relations WHERE from_id = ? AND to_id = ? AND kind = ?')
    .get(a, b, kind);
  if (found) {
    // 已存在就只补 session_id（别覆盖原有信息）
    if (session_id) {
      db.prepare('UPDATE relations SET session_id = COALESCE(session_id, ?) WHERE id = ?')
        .run(session_id, found.id);
    }
    return { id: Number(found.id), created: false };
  }
  const r = db
    .prepare('INSERT INTO relations(from_id, to_id, kind, session_id, ts) VALUES (?, ?, ?, ?, ?)')
    .run(a, b, kind, session_id ?? null, now);
  return { id: Number(r.lastInsertRowid), created: true };
}

/** 取一个实体的全部关系（双向）。 */
function relationsOf(db, entityName) {
  return db
    .prepare(
      `SELECT r.id, r.kind, r.ts,
              a.name AS from_name, b.name AS to_name,
              CASE WHEN a.name = ? THEN 'out' ELSE 'in' END AS direction,
              CASE WHEN a.name = ? THEN b.name ELSE a.name END AS other
       FROM relations r
       JOIN entities a ON a.id = r.from_id
       JOIN entities b ON b.id = r.to_id
       WHERE a.name = ? OR b.name = ?
       ORDER BY r.id`
    )
    .all(entityName, entityName, entityName, entityName);
}

/** 把一条观察写进 FTS（rowid 对齐 observations.id）。 */
function indexObservation(db, bigram, id, content, entityName) {
  const name = entityName || '';
  // 实体名也要进 big 列，否则搜「某某人」「某个项目」这类实体名搜不到东西 ——
  // entity_name 单列走 unicode61，中文会被当成一整个 token。中间的空格保证
  // 「名」和「内容」的二字组不会跨边界粘连（见 bigram.runs 的分段规则）。
  db.prepare('DELETE FROM obs_fts WHERE rowid = ?').run(BigInt(id));
  db.prepare(
    'INSERT INTO obs_fts(rowid, content, entity_name, big) VALUES (?, ?, ?, ?)'
  ).run(BigInt(id), content, name, bigram.indexText(name + ' ' + content));
}

module.exports = {
  ROOT, VEC_DLL, DB_PATH, SCHEMA_VERSION, TABLES,
  open, migrate, nowISO, upsertEntity, insertObservation, indexObservation,
  upsertRelation, relationsOf,
};
