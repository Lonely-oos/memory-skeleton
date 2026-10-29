'use strict';
/**
 * embedding —— 走本机 Ollama 的 bge-m3（1024 维）。
 *
 * 铁律：**算向量失败不许阻塞写入。** 先写 SQLite + FTS（本地必成功），
 * 再「尽力」算向量；Ollama 没开就标 embedded = 0，后台补算。
 * 绝不允许「因为 Ollama 没开，所以今晚说的全没记住」。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.MEMORY_EMBED_MODEL || 'bge-m3';
const DIM = 1024;
/** ollama.exe 在哪 —— 找不到就只报错、不硬编。 */
const OLLAMA_EXE =
  process.env.OLLAMA_EXE ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'Programs', 'Ollama', 'ollama.exe'
  );

/** Ollama 活着吗（顺便预热）。 */
async function ping(timeoutMs = 3000) {
  try {
    const r = await fetch(`${OLLAMA}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.version || 'unknown';
  } catch {
    return null;
  }
}

/**
 * **保证 Ollama 活着** —— 不在就自己拉起来（2026-10-07 新增）。
 *
 * 为什么要有这个：先前是拿计划任务 `dsh-ollama-serve` 常驻的，但
 * （a）AtLogOn 触发器在「登录之后才建任务」的情况下**永远不会补跑**；
 * （b）重建任务要管理员权限（实测 `Access is denied`）。
 * 所以把「确保活着」这件事收到代码里：**每次要用之前先探一下，不在就 detached 拉起来**。
 *
 * `detached: true` 是关键 —— 不这么写，ollama 就是 DSH 进程树里的子进程，
 * **DSH 一死它陪葬**（这是 2026-10-07 那次 Ollama 半夜掉线的真正原因）。
 */
let _lastUp = 0;
const UP_TTL = 30_000; // 30 秒内不重复探测，免得每次都打一次网络

async function ensureOllama({ bootTimeoutMs = 30_000 } = {}) {
  if (Date.now() - _lastUp < UP_TTL) return { ok: true, cached: true };
  if (await ping(1500)) {
    _lastUp = Date.now();
    return { ok: true, cached: false };
  }
  if (!fs.existsSync(OLLAMA_EXE)) {
    return { ok: false, started: false, error: `找不到 ollama.exe：${OLLAMA_EXE}` };
  }
  try {
    const child = spawn(OLLAMA_EXE, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(OLLAMA_EXE),
    });
    child.unref();
  } catch (e) {
    return { ok: false, started: false, error: String((e && e.message) || e) };
  }
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (await ping(1500)) {
      _lastUp = Date.now();
      return { ok: true, started: true };
    }
  }
  return { ok: false, started: true, error: `拉起来了，但 ${bootTimeoutMs}ms 内没就绪` };
}

/** 一批文本 → 一批向量。input 可以是 string 或 string[]。 */
async function embedBatch(input, { timeoutMs = 120000 } = {}) {
  await ensureOllama(); // 不在就拉起来；失败也不抛，下面 fetch 会报错
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!Array.isArray(j.embeddings)) throw new Error('ollama 响应里没有 embeddings');
  for (const v of j.embeddings) {
    if (!Array.isArray(v) || v.length !== DIM) {
      throw new Error(`维度不对：期望 ${DIM}，实得 ${v && v.length}`);
    }
  }
  return j.embeddings;
}

/** 向量写进 vec0（主键必须是 BigInt，阶段 A 实测）。 */
function putVector(db, obsId, vec) {
  const id = BigInt(obsId);
  db.prepare('DELETE FROM obs_vec WHERE obs_id = ?').run(id);
  db.prepare('INSERT INTO obs_vec(obs_id, embedding) VALUES (?, ?)').run(
    id, JSON.stringify(vec)
  );
  db.prepare('UPDATE observations SET embedded = 1 WHERE id = ?').run(id);
}

/** 补算所有 embedded = 0 的条目。返回 {total, ok, failed} —— 绝不抛。 */
async function fillPending(db, { batchSize = 32, limit = 100000 } = {}) {
  const rows = db
    .prepare(
      'SELECT id, content FROM observations WHERE embedded = 0 ORDER BY id LIMIT ?'
    )
    .all(limit);
  const total = rows.length;
  if (!total) return { total: 0, ok: 0, failed: 0 };
  // 一条都没有要补的时候不碰 Ollama；有的话先确保它活着
  const up = await ensureOllama();
  if (!up.ok) {
    return {
      total, ok: 0, failed: total,
      error: up.error || 'Ollama 起不来', aborted: true,
    };
  }
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    try {
      const vecs = await embedBatch(chunk.map((r) => r.content));
      // 不显式开事务：单条写够快（实测 100 条全量重嵌 1.8 秒）
      chunk.forEach((row, k) => putVector(db, row.id, vecs[k]));
      ok += chunk.length;
    } catch (e) {
      failed += chunk.length;
      // 一旦整批失败（通常是 Ollama 没开），不再往下试，直接返回
      return { total, ok, failed, error: String(e && e.message || e), aborted: true };
    }
  }
  return { total, ok, failed };
}

module.exports = {
  OLLAMA, MODEL, DIM, OLLAMA_EXE,
  ping, ensureOllama, embedBatch, putVector, fillPending,
};
