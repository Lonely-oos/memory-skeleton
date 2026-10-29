#!/usr/bin/env node
/**
 * affect.cjs —— 写入时打一次情感分（1–10），永不重估
 *
 * 为什么"一次性"：
 *   重估会让分数漂移。今天觉得重要、三个月后觉得不重要，那改变的是**判断**，
 *   不是「当时这件事对我有多重要」。分数是快照，不是活值。
 *
 * 为什么每条都必须带 why：
 *   没有 why 的分数无法复核，等于把打分者的默认值藏起来了。
 *   没有 why，就抛错 —— 宁可写入失败，也不要往库里塞一个说不出理由的数字。
 *
 * 为什么打分要掺外部信号：
 *   打分者和使用者是同一个模型时是闭环，会漂移（倾向于给"刚才聊得挺好"打高分）。
 *   `confirmed`（被本人确认过）就是外部信号：它不来自打分者自己的判断。
 */
'use strict';

/** 分数 → 人话，用于 why 的可读性 */
const LABEL = (v) => (v >= 8 ? '很重' : v >= 6 ? '偏重' : v >= 4 ? '中性' : v >= 3 ? '偏轻' : '轻');

/**
 * 规则按顺序匹配，**第一条命中即返回**。每条都必须能说出理由。
 * 顺序即优先级：确认 > 健康/关系 > 他亲口说 > 技术细节 > 工作日志 > 寒暄 > 默认。
 */
const RULES = [
  {
    id: 'confirmed',
    when: (c) => c.confirmed === true,
    affect: 7.0,
    why: '他确认过这条（外部信号，不来自打分者自己的判断）',
  },
  {
    id: 'personal-heavy',
    when: (c) => /(病|疼|难受|住院|手术|确诊|抑郁|失眠|撑不住|哭|去世|走了|分手|离婚|吵架|道歉|答应|承诺|决定|再也不|最后一次)/.test(c.content),
    affect: 8.0,
    why: '命中健康/关系/承诺类词：这类话通常会被反复回想，而不是一次就过去',
  },
  {
    id: 'he-said',
    when: (c) => c.source === 'he-said',
    affect: 6.5,
    why: '他亲口说的（不是我的推断）',
  },
  {
    id: 'tech-detail',
    when: (c) => c.domain === 'tech' || ['知识', '项目', '故障'].includes(c.entityType),
    affect: 4.5,
    why: '技术/项目类：会过期或过时，但不会因为"情绪淡了"而失效',
  },
  {
    id: 'process-log',
    when: (c) => c.kind === 'process',
    affect: 3.0,
    why: '工作日志（我做了什么）：属于过程记录，不该占检索位',
  },
  {
    id: 'smalltalk',
    when: (c) => /(吃了吗|晚安|早安|在吗|随便|哈哈|嗯嗯|好的)/.test(c.content) && c.content.length < 30,
    affect: 2.5,
    why: '寒暄/日常短句：真实但密度低',
  },
];

/**
 * @param {{content:string, source?:string, kind?:string, domain?:string, entityType?:string, confirmed?:boolean}} ctx
 * @returns {{affect:number, write:{id:string, label:string}}}
 */
function scoreAffect(ctx) {
  const c = {
    content: String(ctx.content || ''),
    source: ctx.source || 'i-inferred',
    kind: ctx.kind || 'memory',
    domain: ctx.domain || 'person',
    entityType: ctx.entityType || '未分类',
    confirmed: ctx.confirmed === true,
  };
  for (const r of RULES) {
    if (r.when(c)) return { affect: r.affect, write: { id: r.id, label: `${LABEL(r.affect)} · ${r.why}` } };
  }
  return {
    affect: 5.0,
    write: { id: 'neutral', label: `中性 · 没有命中任何特征，按中性处理（默认可复核，不是"随便给个分"）` },
  };
}

module.exports = { scoreAffect, RULES, LABEL };
