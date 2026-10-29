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

### 5. 情感分只打一次，而且必须带理由（`src/affect.cjs`）

写入时打 1–10 分，**之后永不重估**：

- 打分是快照，不是活值。今天觉得重要、三个月后觉得不重要，改变的是判断，不是"当时有多重要"。
- 每次打分必须附一句 `affect_why`。**没有 why 的分数直接抛错，不许入档** —— 宁可写入失败，也不要往库里塞一个说不出理由的数字。
- 打分规则是**可复核的关键词/出处规则**，不是让模型现场凭感觉给分。匹配顺序即优先级：

| 规则 | 条件 | 分数 |
|---|---|---|
| `log-domain` | `domain = log`（对话日志） | 1.0 |
| `confirmed` | 被本人确认过 | 7.0 |
| `heavy-any` | 强情感词：确诊/住院/手术/去世/分手/离婚/哭/撑不住…（**跨分区生效**） | 8.0 |
| `tech-detail` | `domain = tech` 或实体类型为 知识/项目/故障 | 4.5 |
| `person-commit` | 答应/承诺/再也不/最后一次/道歉/保证（**只在 person 区**） | 7.0 |
| `person-plan` | 打算/计划/决定要 | 6.0 |
| `he-said` | 他亲口说的 | 6.5 |
| `process-log` | `kind = process`（我做了什么） | 3.0 |
| `smalltalk` | 寒暄短句（<30 字） | 2.5 |
| `neutral` | 其余 | 5.0 |

> **两条实战教训**（2026-10-29 抽 20 条真实数据核对后改的）：
> ① 关键词必须**按分区隔离**——技术文档里"决定/承诺"是常用词，不加域限制会让一篇技术说明被判 8.0；
> ② 日志区规则必须**在最前面**——否则同一批对话日志走两条路径会得到 1.0 / 5.0 / 8.0 三种结果。
- `confirmed: true` 是一个**外部锚点**：被本人确认过的条目提到 7.0。
  打分者和使用者是同一个模型时是闭环，会漂移（倾向于给"刚才聊得挺好"打高分）；外部信号是唯一解法。

### 6. 衰减在查询时算，tech 区和 person 区用两套口径（`src/rank.cjs`）

```
stability = f(affect, domain, entityType)      # 天
decay     = exp(-(now - last_touch) / stability)
```

| 情感分 | 半衰期 | stability |
|---|---|---|
| 1–3 | 1 天 | 1.4 |
| 3–6 | 10 天 | 14 |
| 6–8 | 25 天 | 36 |
| 8–10 | 45 天 | 65 |

- **person 区**按情感分（上表）；**tech 区按类型**：`知识` → 永真不衰减（Infinity），`项目` / `故障` → 7 天，`环境` → 30 天。
- 不每天跑全库：索引一次、查询时算，O(1)。指数衰减永远不真正归零，所以"想得起来"天然成立。

### 7. 打分用加权和，**绝不用相乘**

```
score = 0.55 * relevance
      + 0.20 * affect_norm      # affect / 10
      + 0.15 * recency          # exp(-Δt/stability)
      + 0.10 * hit_boost        # min(hit_count * 0.1, 0.5)
低于 0.35 不返回，默认取 top 5。
```

> 为什么不能相乘：一条情感分 0.1 的记忆，就算相关性 1.0，乘出来只有 0.1——永远进不了前 5。
> 而「吃了吗」「晚安」这类日常记忆情感分天然低，问"我们平时都聊什么"时恰恰需要它们。
> 加权和下，任一项低只是减分，不会归零。

提及加分**必须封顶**（+0.5），否则一条被反复提到的旧记忆会永久霸占检索位。
`touch(db, id)` 负责回升，同一条 **24 小时内最多回升一次**（否则一次长对话能把它刷到最高分）。

### 8. 四路召回：关键词 + 向量 + **时间** + **实体**

前两路回答"像不像"，后两路回答"范围"：

| 路 | 解决什么 | 实现 |
|---|---|---|
| 关键词 | 字面精确（人名、报错码、术语） | FTS5 + BM25（bigram 切中文） |
| 向量 | 意思相近但用词不同 | bge-m3 + sqlite-vec |
| **时间** | 「上周」「昨天」「3 天前」——字面没有内容词，相似度也抓不到 | `routes.cjs`：解析显式时间词 → 按 `ts` 圈候选 |
| **实体** | 「关于他的事」——不是相似度问题，是归属问题 | `routes.cjs`：查询里出现已知实体名 → 取该实体的条目 |

四路都用 RRF 融合（排名倒数相加），再按上面的加权公式重排。

> **时间路只认显式时间词**：识别不出就返回 `null`，不猜范围。
> 猜出来的窗口比不召回更糟——它会把无关的东西"证明"成相关。

### 9. 三层巩固：日结 / 周结 / 月结，**必须带 source_ids**

```js
const summary = require('./src/summary.cjs');
summary.buildDaily(db, { period: '2026-01-01' });        // 当天按 affect 取前 N 条原文
summary.buildRollup(db, { level: 'week', period: summary.isoWeek('2026-01-01') });
summary.buildRollup(db, { level: 'month', period: '2026-01' });
summary.verify(db, { level: 'day', period: '2026-01-01' });  // 追溯链是否通
```

这一层**不调用模型**：摘要是"挑出最该记住的几条原文"，不是"让模型再写一遍"。
每多一层改写就多一次漂移机会，而漂移在摘要上会被上一层放大。

`verify()` 只保证**追溯链是通的**（source_ids 都能读回原文），
**不能**自动判断"摘要有没有走样"——那个要人看。这是有意为之：
自动判定"摘要忠实度"会用同一个模型去验自己的输出，等于没验。

### 10. 硬归档兜底

「容量自动收缩」在有持续新增时不成立：`archiveStale(db, {days: 180})` 把超过 180 天没被命中的条目
移到 `archive_observations`（默认 `dryRun: true` 只报数不删）。


---

## 表结构（`src/db.cjs`）

| 表 | 作用 |
|---|---|
| `entities` | 实体（人 / 项目 / 知识 / 故障…），`name + type` 唯一 |
| `observations` | 一条一条的观察。带 `source`、`ts`、`provenance`、`kind`、`embedded`、`superseded_by`，以及 `domain` / `affect` / `affect_why` / `hit_count` / `last_touch` |
| `relations` | 实体之间的关系（`from → to`，带 `kind`） |
| `obs_fts` | FTS5 索引（用 **bigram** 切中文，不用英文分词器） |
| `obs_vec` | sqlite-vec 虚拟表，1024 维（bge-m3） |
| `live_observations` | 视图：只含 `superseded_by IS NULL` 的条目 |`r`n| `summaries` | 三层巩固（day/week/month），**必须带 `source_ids`**，否则无法用原文校验 |`r`n| `memory_links` | 相关记忆只建索引、不合并原文（合并是不可逆的信息损失） |`r`n| `archive_observations` | 硬归档（180 天未命中），不参与检索但保留 |

`src/bigram.cjs` 负责中文切分与 `MATCH` 表达式生成；`src/search.cjs` 做四路 RRF 融合
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
