'use strict';
/**
 * 双路检索 + RRF 融合。
 *
 * 为什么两路都要：关键词能精确命中路径/报错原文/配置数字，向量能跨用词泛化
 * （实测「他爱吃什么主食」→「他喜欢珍珠米」相似度 0.758，一个「米」字都没有）。
 *
 * 为什么用 RRF 而不是加权求和：BM25 分数和余弦相似度量纲不同，
 * 调权重是假精确；RRF 只看名次，score(d) = Σ 1/(60 + rank_i(d))。
 *
 * 关键词路默认走**严**模式（整段短语，见 bigram.buildMatch 的注释）——
 * 这是阶段 B 实测逼出来的：OR 模式给出的命中覆盖率只有 0.17，全是噪声，
 * 再经 RRF 反而把语义路的正确答案挤下去。宁可给 0 条。
 */
const bigram = require('./bigram.cjs');
const embed = require('./embed.cjs');
const audit = require('./audit.cjs');
const rank = require('./rank.cjs');

const RRF_K = 60;
const LOOSE_MIN_COVERAGE = 0.5;

/**
 * 语义距离的下限（cosine distance，0=一模一样）。
 * 量法见 `vectorSearch()` 里的注释；可用环境变量 `MEMORY_MAX_DISTANCE` 覆盖。
 */
const D_MAX = Number(process.env.MEMORY_MAX_DISTANCE ?? 0.47);

function buildFilters({ source, since, entity, kind, includeProcess } = {}) {
  const cond = [];
  const params = [];
  if (source) {
    const arr = Array.isArray(source) ? source : [source];
    cond.push(`o.source IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  }
  if (since) { cond.push('o.ts >= ?'); params.push(since); }
  if (entity) { cond.push('e.name = ?'); params.push(entity); }
  // v2：**默认把 process 挡在检索之外。**
  // process 是我"做过什么"的日志（"我改了 X 文件"），不是"关于他/关于世界的记忆"。
  // 实测教训：可检索 145 条里提到他的只有 30 条 —— 日志把记忆稀释了。
  // 要看日志就显式传 kind:'process'（或 kind:['memory','process','note'] 全都要）。
  if (kind) {
    const arr = Array.isArray(kind) ? kind : [kind];
    cond.push(`o.kind IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  } else if (!includeProcess) {
    cond.push("o.kind <> 'process'");
  }
  return { sql: cond.length ? ' AND ' + cond.join(' AND ') : '', params };
}

const COLS = `o.id, o.content, o.source, o.ts, o.recorded_at, o.provenance,
              o.kind, o.session_id,
              e.name AS entity_name, e.type AS entity_type`;

function runMatch(db, match, limit, f) {
  return db
    .prepare(
      `SELECT ${COLS}, obs_fts.big AS _big, bm25(obs_fts) AS bm25_score
         FROM obs_fts
         JOIN observations o ON o.id = obs_fts.rowid
         JOIN entities e     ON e.id = o.entity_id
        WHERE obs_fts MATCH ?
          AND o.superseded_by IS NULL${f.sql}
        ORDER BY bm25_score
        LIMIT ?`
    )
    .all(match, ...f.params, limit);
}

/** 关键词路：FTS5 + BM25。只出未被更正的条目。 */
function keywordSearch(db, query, limit, f, { loose = false } = {}) {
  const strict = bigram.buildMatch(query);
  if (!strict) return { rows: [], match: null, mode: 'none' };

  let rows = runMatch(db, strict, limit, f);
  let match = strict;
  let mode = 'strict';

  if (!rows.length && loose) {
    const expr = bigram.buildMatch(query, { loose: true });
    if (expr && expr !== strict) {
      const qg = bigram.gramsOf(query);
      const kept = runMatch(db, expr, limit * 3, f).filter(
        (r) => bigram.coverage(r._big, qg) >= LOOSE_MIN_COVERAGE
      );
      if (kept.length) {
        rows = kept.slice(0, limit);
        match = expr;
        mode = 'loose';
      }
    }
  }
  return { rows: rows.map(strip), match, mode };
}

const strip = ({ _big, bm25_score, ...rest }) => rest;

/**
 * 「词汇落地」：库里到底有没有**任何一条**提到查询里的词？
 *
 * 为什么需要它 —— Q06 那个坑（2026-10-07 双跑实测）：
 *   查 `extension loading is not allowed`（当时库里确实没有），关键词 0 命中，
 *   语义路把 19 条全留下了（最近 0.389 比阈值 0.47 还近），于是照样返回 8 条，而真值 0 条。
 *   成因：英文技术长句在嵌入空间里和别的英文技术残片挨得很近，**跟主题无关**。
 *
 * 为什么不能再收紧阈值 —— **分不开**：
 *   Q06 最近 0.389；而「他为什么现在不养猫」0.393、「计划任务为什么从来没跑过」0.393，
 *   后两个是**好答案**。想靠距离砍掉 0.389 却留下 0.393，那是假精度（同 `db.cjs` 删掉
 *   `confidence` 字段的理由）。
 *
 * 能分开的是这个量：**含查询里任一个词的条目数**。
 *   无答案的 Q06 落地 **0**；有答案的语义型查询落地 14–47（猫 24、米 14、删 47、备份 30、计划任务 27）。
 *   它不是相似度判断，是一条能查证的**逻辑事实**：库里没有这个词。
 *
 * ⚠️ 代价（写清楚，别当没有）：**跨语言、完全换了词的真正相关记忆会被一起挡掉**。
 *    本库实测 `cat` 落地 0、最近 0.544（本来就超过阈值，召不回）；
 *    也就是说这条规矩到目前**没造成过实际损失** —— 但这是实测过的边界，不是"绝不会误伤"。
 * ⚠️ 它看的是**当下**库里有什么：把 Q06 这次调查写进记忆之后，库里就有了 13 条含
 *    `extension loading is not allowed` 的条目 ⇒ 同一条查询不再触发本规则（2026-10-07 实测到）。
 */
function lexicalGrounding(db, query, f) {
  const grams = [...bigram.gramsOf(query)].slice(0, 40);
  if (!grams.length) return 0;
  const expr = grams.map((g) => bigram.q(g)).join(' OR ');
  try {
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) n FROM obs_fts
             JOIN observations o ON o.id = obs_fts.rowid
            WHERE obs_fts MATCH ? AND o.superseded_by IS NULL${f.sql}`
        )
        .get(expr, ...f.params).n
    );
  } catch {
    // 表达式拼坏了 = "不知道"，返回 null。**绝不因为算不出来就把结果吞掉**：宁可多给，不可误删。
    return null;
  }
}

/** 语义路：vec0 KNN。超取 4 倍再在 JS 里滤掉被更正的（k 用在过滤之前）。 */
async function vectorSearch(db, query, limit, f, { maxDistance = D_MAX } = {}) {
  const [vec] = await embed.embedBatch(query);
  const knn = db
    .prepare(
      'SELECT obs_id, distance FROM obs_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance'
    )
    .all(JSON.stringify(vec), limit);
  if (!knn.length) return { rows: [], best: null, droppedMin: null, dropped: 0 };
  const ids = knn.map((r) => Number(r.obs_id));
  const ph = ids.map(() => '?').join(',');
  const meta = db
    .prepare(
      `SELECT ${COLS} FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.id IN (${ph}) AND o.superseded_by IS NULL${f.sql}`
    )
    .all(...ids, ...f.params);
  const byId = new Map(meta.map((r) => [Number(r.id), r]));
  const all = knn
    .map((r) => {
      const m = byId.get(Number(r.obs_id));
      return m ? { ...m, distance: Number(r.distance) } : null;
    })
    .filter(Boolean);

  // ── 相关性下限（v2 新增）──────────────────────────────────────────
  // 向量检索**天生会给最近的邻居，不管有多远** —— 查「qqqqzzzz 不存在的东西」
  // 它照样返回 5 条。所以必须自己砍。
  // 阈值是量出来的（scripts\measure-threshold.cjs，2026-10-07 实测）：
  //     相关（他）  最近平均 0.380  最差 0.430
  //     相关（系统）最近平均 0.351  最差 0.440
  //     不相关      最近平均 0.517–0.562，最小的一条 0.475
  //   → 分界在 0.44 与 0.475 之间，取 **0.47**（偏松一侧：宁可给一条边缘的，
  //     也不要说「我不记得」而其实记得）。
  //   ⚠️ 这是 8 相关 + 6 不相关、一天一次的量，**不是定论**。要调就传 maxDistance，
  //      或改环境变量 MEMORY_MAX_DISTANCE。砍掉了多少条会一起报出来，好判断。
  const kept = all.filter((r) => r.distance <= maxDistance);
  // ⚠️ 2026-10-07 修：`best` 是**全体里最近**的，通常属于**留下**的那条。
  // 想在「有几条被砍」那句话里说「最近一条被砍的有多近」，必须取**被砍那堆里最小**的距离 ——
  // 否则会打印出「最近一条 0.350 > 0.47」这种自相矛盾的话（0.350 并不大于 0.47）。
  // `all` 已按 distance 升序，所以第一条被砍的就是 all[kept.length]。
  const droppedMin =
    all.length - kept.length > 0 ? all[kept.length].distance : null;
  return {
    rows: kept,
    best: all.length ? all[0].distance : null,
    droppedMin,
    dropped: all.length - kept.length,
  };
}

/** 倒数名次融合。 */
function fuse(lists, limit) {
  const total = new Map();
  const first = new Map();
  for (const list of lists) {
    list.forEach((row, i) => {
      const id = Number(row.id);
      total.set(id, (total.get(id) || 0) + 1 / (RRF_K + i + 1));
      if (!first.has(id)) first.set(id, row);
    });
  }
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, s]) => ({ ...first.get(id), rrf: Number(s.toFixed(6)) }));
}

/**
 * 主入口。
 * @param {object} [opts]
 * @param {'drop'|'show'} [opts.ungrounded] 关键词 0 命中**且**库里一条都没提到查询里的词时怎么办。
 *   默认 `'drop'`（不返回，明说没有）；`'show'` 是给自己做诊断用的后门（双跑脚本在用）。
 * @returns {{results:Array, keywordHits:number, vectorHits:number, vectorDropped:number,
 *            bestDistance:number|null, droppedMinDistance:number|null, maxDistance:number,
 *            match:string|null, keywordMode:string, vectorError:string|null,
 *            grounding:number|null, ungrounded:boolean}}
 *   `grounding` 只在"关键词 0 命中但语义路有货"时才算（其他情况没有意义，值为 null）；
 *   `ungrounded` = `grounding === 0`，即"库里一条都没提到你问的词"。
 */
async function search(db, query, opts = {}) {
  const limit = opts.limit || 8;
  const over = Math.max(limit * 4, 20);
  const f = buildFilters(opts);
  const maxDistance = opts.maxDistance != null ? Number(opts.maxDistance) : D_MAX;

  const kw = keywordSearch(db, query, over, f, { loose: !!opts.loose });
  let vs = { rows: [], best: null, droppedMin: null, dropped: 0 };
  let vectorError = null;
  if (!opts.keywordOnly) {
    try {
      vs = await vectorSearch(db, query, over, f, { maxDistance });
    } catch (e) {
      vectorError = String((e && e.message) || e);
    }
  }

  // ── 关键词没命中、且库里根本没有你问的词 ⇒ 语义近邻不是答案（见 lexicalGrounding 注释）──
  // 只在"关键词 0 命中 + 语义路真有货"时才算落地，其余情况算它没有意义。
  let grounding = null;
  let ungrounded = false;
  if (!kw.rows.length && vs.rows.length) {
    grounding = lexicalGrounding(db, query, f);
    ungrounded = grounding === 0;      // grounding 为 null（算失败）时按"不是 ungrounded"处理
  }
  // ── 融合 → 加权重排（评审报告 4.2/4.3）──
  // 加权和，**绝不相乘**：相乘会让中性记忆永远进不了前 5。
  // 低于阈值不返回 —— 宁可少给，不要给错的。
  const fused = ungrounded && opts.ungrounded !== 'show' ? [] : fuse([kw.rows, vs.rows], over);
  const ids = fused.map((r) => Number(r.id));
  const metaRows = ids.length
    ? db.prepare(
        'SELECT id, domain, affect, hit_count, last_touch, ts FROM observations WHERE id IN (' +
          ids.map(() => '?').join(',') + ')'
      ).all(...ids)
    : [];
  const metaById = new Map(metaRows.map((m) => [Number(m.id), m]));
  const maxRrf = fused.reduce((mx, r) => Math.max(mx, r.rrf), 0) || 1;
  const ranked = rank.rerank(
    fused.map((r) => ({ ...r, ...(metaById.get(Number(r.id)) || {}), relevance: r.rrf / maxRrf })),
    { threshold: opts.threshold != null ? Number(opts.threshold) : 0.35, limit }
  );
  const results = ranked.kept;

  // ── 提及回升：检索命中即算一次"复习" ──
  // 不接这一步，打分公式里 hit 那一项永远是 0（等于 0.10 权重是假的）。
  // 冷却由 rank.touch() 负责：同一条 24 小时内最多回升一次。
  let touched = 0;
  if (opts.touch !== false) {
    for (const r of results) {
      try { if (rank.touch(db, Number(r.id))) touched++; } catch { /* 回升失败不影响检索 */ }
    }
  }

  // ── 审计：这次检索发生了什么（失败不影响返回）──
  audit.log(db, 'retrieve', {
    session: opts.session || null,
    query,
    candidates: { keyword: kw.rows.length, vector: vs.rows.length, limit, over, fused: fused.length },
    chosen: results.map((r) => Number(r.id)),
    scores: results.map((r) => ({ id: Number(r.id), score: r.score, parts: r.parts, stability: r.stability })),
    reason: 'ungrounded=' + ungrounded + ' grounding=' + grounding +
            ' kwMode=' + kw.mode + ' threshold=' + ranked.threshold +
            ' dropped=' + ranked.droppedByThreshold.length + ' touched=' + touched +
            (vectorError ? ' vectorError=' + vectorError : ''),
  });
  // 被阈值挡掉的单独记一笔 —— 这条能回答「这条为什么被淘汰」
  if (ranked.droppedByThreshold.length) {
    audit.log(db, 'decay', {
      session: opts.session || null,
      query,
      candidates: { fused: fused.length, threshold: ranked.threshold },
      chosen: [],
      scores: ranked.droppedByThreshold.slice(0, 10).map((r) => ({
        id: Number(r.id), score: r.score, parts: r.parts, stability: r.stability,
      })),
      reason: '加权分低于阈值未返回（宁可少给，不要给错）',
    });
  }

  return {
    results,
    keywordHits: kw.rows.length,
    keywordMode: kw.mode,
    vectorHits: vs.rows.length,
    vectorDropped: vs.dropped,
    bestDistance: vs.best,
    droppedMinDistance: vs.droppedMin,
    maxDistance,
    match: kw.match,
    vectorError,
    grounding,
    ungrounded,
    ranked: { threshold: ranked.threshold, dropped: ranked.droppedByThreshold.length, touched },
  };
}

module.exports = {
  search, keywordSearch, vectorSearch, fuse, buildFilters, runMatch, RRF_K, lexicalGrounding,
};
