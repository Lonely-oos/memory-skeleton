'use strict';
/**
 * 中文二元切分（bigram）—— FTS5 索引与查询共用的分词器。
 *
 * 为什么不用 trigram：实测二字词（米饭/四川/显卡/黄瓜）在 trigram 表里 0 命中，
 * 而中文最常见的查询形态恰恰是两个字。为什么不用 jieba：多一个依赖，
 * 而 bigram 对检索这个用途已经够（详见《记忆库改造方案》第 3 节）。
 *
 * 两套用法必须成对出现：
 *   写入 → indexText()   存进 obs_fts.big 列
 *   查询 → buildMatch()  拼成 FTS5 MATCH 表达式
 */

// 汉字（含扩展A、兼容区）+ 日文假名 + 々〆
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uF900-\uFAFF\u3005\u3006]/;
const TOKEN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uF900-\uFAFF\u3005\u3006]+|[A-Za-z0-9_.]+/g;

/** 把一段文本切成「连续段」：每个 CJK 连续段切相邻二字组；ASCII/数字段整段保留。 */
function runs(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    const run = m[0];
    if (!CJK.test(run[0])) {
      out.push([run.toLowerCase()]);          // 路径、报错码、日期：整段当一个 token
      continue;
    }
    if (run.length === 1) {
      out.push([run]);                        // 单字没法成对，原样留一个（召回弱，靠语义那路兜）
      continue;
    }
    const grams = [];
    for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
    out.push(grams);
  }
  return out;
}

/** 写入用：把文本变成 big 列的内容（token 之间空格分隔）。 */
function indexText(text) {
  const flat = [];
  for (const r of runs(text)) for (const t of r) flat.push(t);
  return flat.join(' ');
}

/** FTS5 双引号字符串里，`"` 用 `""` 转义。 */
function q(tok) {
  return '"' + String(tok).replace(/"/g, '""') + '"';
}

/**
 * 查询用：拼 FTS5 MATCH 表达式。
 *
 * **默认走「严」模式**：每个连续段拼成一个短语（FTS5 里 `"a b"` 就是短语，
 * 要求这几个 token 连续出现）。段之间用 AND。
 *
 * 为什么不默认用 OR —— 阶段 B 实测（scripts/diag2.cjs）：
 * 查询「他爱吃什么主食」用 OR 时命中 4 条，每条**只命中 6 个二字组里的 1 个**
 * （都是「什么」），覆盖率 0.17；这堆噪声再被 RRF 抬到语义路正确答案之上。
 * 而严模式要么给出覆盖率 1.00 的精确命中（「珍珠米」2/2、「家里宽带」3/3），
 * 要么给 0 条 —— 后者直接交给语义路，干净得多。
 *
 * loose=true 是给生僻词兜底用的，调用方**必须**再过一遍覆盖率过滤（search.cjs 已做）。
 *
 * 所有 token 一律加引号 —— FTS5 里裸的 `-` 是 NOT 运算符，「2026-09-17」会直接抛异常。
 */
function buildMatch(text, { loose = false } = {}) {
  const rs = runs(text);
  if (!rs.length) return null;
  const parts = [];
  for (const r of rs) {
    if (loose && r.length > 3) parts.push('(' + r.map(q).join(' OR ') + ')');
    else parts.push(r.map(q).join(' '));      // 相邻 → 短语
  }
  return parts.join(' AND ');
}

/** 一段文本里出现过的所有 token 集合（算覆盖率用）。 */
function gramsOf(text) {
  const s = new Set();
  for (const r of runs(text)) for (const t of r) s.add(t);
  return s;
}

/** 一条已索引记录的 token 集合对查询 token 集合的覆盖率。 */
function coverage(bigColumn, queryGrams) {
  if (!queryGrams.size) return 0;
  const have = new Set(String(bigColumn || '').split(/\s+/).filter(Boolean));
  let n = 0;
  for (const g of queryGrams) if (have.has(g)) n++;
  return n / queryGrams.size;
}

module.exports = { runs, indexText, buildMatch, gramsOf, coverage, q, CJK, TOKEN_RE };
