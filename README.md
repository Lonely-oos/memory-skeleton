# memory-skeleton

一套用来"长期记住一个人"的记忆库骨架：**SQLite + FTS5 关键词 + 向量语义**，双路融合排序。

它不是聊天记录摘要器，而是给下面这些问题准备结构：

- 这条记忆**是谁说的**？（他亲口说的 / 我推断的 / 客观观察到的）
- 说错了怎么改？—— 改完还能查回旧的
- 备份怎么才算真的能恢复？
- Ollama 没开的时候，今晚说的话还能不能记住？

---

## 四条设计结论（比代码更重要）

### 1. 出处写进表结构，默认值不许替人签字

`source` 只有三个值：`he-said` / `i-inferred` / `observed`。
**默认值是 `i-inferred`，不是 `he-said`。**

> 为什么：`i-inferred` 错起来最危险——它写下来之后读起来跟事实一模一样。
> 默认值挑"最不冒认"的那个：写错了顶多是自认推断；写成"他说"，就是替他签字。

### 2. 更正不覆盖，新旧之间连双向指针

`correct()` 把旧条目打上 `superseded_by`，新条目记 `supersedes`，**旧的一行都不删**。

> 为什么：删掉就看不出改过。检索默认只返回未被更正的条目，但旧条目永远查得到——
> 需要复盘"我当时为什么这么想"的时候，那才是证据。

### 3. 备份要验"能不能恢复"，不是验"文件在不在"

`backup.cjs` 用 `VACUUM INTO` 做一致性快照（直接复制 WAL 库会**悄悄丢掉**还没并进主文件的提交）；
`verify-backup.cjs` 把快照**当真库打开**，加载扩展、核对计数，再**真做一次向量检索**——
取一条已存在的向量当查询，它必须第一个搜到自己。

> 为什么：前两步通过、第三步不过，说明索引坏了。那种备份恢复回去"读得出但搜不到"，等于只剩一半。

### 4. 语义是"尽力"，不能是"必要"

Ollama / bge-m3 不在时，写入照样成功，条目标记 `embedded = 0`，之后用 `fillPending()` 补算。

> 为什么：绝不允许「因为 Ollama 没开，所以今晚说的全没记住」。
> 反过来也要防：**新写入的行不会自动有向量**——补算入口要单独存在，否则会出现
> "数据在库里、语义搜不到"（我们真实踩过：70 条只有关键词索引）。

---

## 表结构（`src/db.cjs`）

| 表 | 作用 |
|---|---|
| `entities` | 实体（人 / 项目 / 知识 / 故障…），`name + type` 唯一 |
| `observations` | 一条一条的观察。带 `source`、`ts`、`provenance`、`kind`、`embedded`、`superseded_by` |
| `relations` | 实体之间的关系（`from → to`，带 `kind`） |
| `obs_fts` | FTS5 索引（用 **bigram** 切中文，不用英文分词器） |
| `obs_vec` | sqlite-vec 虚拟表，1024 维（bge-m3） |
| `live_observations` | 视图：只含 `superseded_by IS NULL` 的条目 |

`src/bigram.cjs` 负责中文切分与 `MATCH` 表达式生成；`src/search.cjs` 做 RRF 融合
（关键词与向量的排名倒数相加），并对"关键词 0 命中、库里根本没有你问的词"的情况做**语义兜底拦截**。
`src/audit.cjs` 只记"这次写了/搜了什么"，**不记正文**。

## 快速开始

```bash
node examples/smoke-test.cjs
```

它会：建一个临时库 → 写两条 → 关键词检索 → 更正一条 → 备份 → 校验，最后打印临时目录（可删）。

自己用：

```js
const dbm = require('./src/db.cjs');
const { writeObservations, correct } = require('./src/write.cjs');
const { search } = require('./src/search.cjs');

const db = dbm.open('./memory.db');
dbm.migrate(db);

const [id] = writeObservations(db, {
  entity: '某个项目', entityType: '项目',
  observations: ['2026-01-01：今天把 X 改成了 Y，因为 Z。'],
  source: 'he-said', provenance: '会话 2026-01-01',
});

const res = await search(db, '把 X 改成什么了', { limit: 5 });
console.log(res.keywordHits, res.vectorHits, res.results);
```

## 备份与校验

```bash
node scripts/backup.cjs                 # -> ./backups/<时间戳>/
node scripts/verify-backup.cjs backups/2026-01-01_120000
```

环境变量：`MEMORY_DB`（库路径）、`BACKUP_KEEP`（保留份数，默认 14）。
`reindex.cjs` 只重建 FTS；**向量要用 `src/embed.cjs` 的 `fillPending(db)` 补**。

## 依赖

- **Node.js ≥ 22.13**（用到内置 `node:sqlite`，不需要编译原生模块）
- **`vec0.dll`**（sqlite-vec 扩展，随仓库附带；其他平台请换成对应动态库）
- 可选：本机 **Ollama + bge-m3**（1024 维）——没有就自动退化为纯关键词检索
- 可选：`OLLAMA_HOST`、`OLLAMA_EXE` 环境变量

## 已知限制

1. **中文检索靠 bigram**，英文/代码标识符的召回一般；这是有意取舍（中文场景优先）。
2. **向量维度和模型绑定**：`obs_vec` 是 1024 维，换 embedding 模型要重建表。
3. **没有多租户/权限**：单机单人使用。
4. **不自动补向量**：新写入的行需要你调用 `fillPending()`。这是故意的——让"有没有向量"变成可观测状态，而不是隐式行为。
5. `audit` 表会一直长，需要自己定期清（本仓库不替你决定保留策略）。

## 许可

MIT，见 [LICENSE](LICENSE)。
