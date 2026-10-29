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
 *
 * ⚠️ 2026-10-29 21:1x 抽 20 条真实数据核对后改过一轮（变更记录第十五节）：
 *   ① 日志区（domain=log）必须先判 → 1.0。此前日志区没有规则，全靠 chat-memory.py 硬写，
 *      而同一批内容走 scoreAffect() 会得到 5.0 或 8.0 —— 两条路径不一致。
 *   ② 关键词按分区隔离：「承诺/决定/道歉」只在 person 区生效；只有「病/住院/去世/分手/哭」
 *      这类强情感词可以跨区。此前技术文档里**列举**这些词时被自己命中（#891 被判 8.0）。
 *   ③ 「打算/计划」与「答应/承诺」分开档：前者是计划（6.0），后者是关系承诺（7.0）。
 */
'use strict';

const LABEL = (v) => (v >= 8 ? '很重' : v >= 6 ? '偏重' : v >= 4 ? '中性' : v >= 3 ? '偏轻' : '轻');

/** 强情感词：跨分区生效（技术分类里出现"住院"也不正常，值得高分） */
const HEAVY_ANY = /(确诊|住院|手术|去世|走了|分手|离婚|哭|撑不住|抑郁|自杀|抢救|化疗)/;
/** 关系/承诺类：只在 person 区生效 —— 技术文档里"决定"是常用词，不该得 8 分 */
const COMMIT_PERSON = /(答应|承诺|再也不|最后一次|道歉|对不起|保证)/;
const PLAN_PERSON = /(打算|计划|准备做|想去做|决定要)/;
const SMALLTALK = /(吃了吗|晚安|早安|在吗|随便|哈哈|嗯嗯|好的|再见|谢谢|不用谢)/;

const RULES = [
  {
    id: 'log-domain',
    when: (c) => c.domain === 'log',
    affect: 1.0,
    why: '对话日志（domain=log）：值低量多，进 FTS 但不占核心区；要挑内容请另立实体',
  },
  {
    id: 'confirmed',
    when: (c) => c.confirmed === true,
    affect: 7.0,
    why: '他确认过这条（外部信号，不来自打分者自己的判断）',
  },
  {
    id: 'heavy-any',
    when: (c) => HEAVY_ANY.test(c.content),
    affect: 8.0,
    why: '命中强情感词（健康/生死/关系破裂类）：这类话会被反复回想，跨分区一律高分',
  },
  {
    id: 'tech-detail',
    when: (c) => c.domain === 'tech' || ['知识', '项目', '故障'].includes(c.entityType),
    affect: 4.5,
    why: '技术/项目类：会过期或过时，但不会因为"情绪淡了"而失效（情感分不该驱动技术区衰减）',
  },
  {
    id: 'person-commit',
    when: (c) => COMMIT_PERSON.test(c.content),
    affect: 7.0,
    why: '命中关系/承诺类词（答应、承诺、最后一次…）：属于人和人之间的事',
  },
  {
    id: 'person-plan',
    when: (c) => PLAN_PERSON.test(c.content),
    affect: 6.0,
    why: '命中计划类词（打算、决定要…）：是"我们准备做什么"，比日常重、比承诺轻',
  },
  {
    id: 'he-said',
    when: (c) => c.source === 'he-said',
    affect: 6.5,
    why: '他亲口说的（不是我的推断）',
  },
  {
    id: 'process-log',
    when: (c) => c.kind === 'process',
    affect: 3.0,
    why: '工作日志（我做了什么）：属于过程记录，不该占检索位',
  },
  {
    id: 'smalltalk',
    when: (c) => SMALLTALK.test(c.content) && c.content.length < 30,
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
    if (r.when(c)) {
      return { affect: r.affect, write: { id: r.id, label: `${LABEL(r.affect)} · ${r.why}` } };
    }
  }
  return {
    affect: 5.0,
    write: { id: 'neutral', label: '中性 · 没有命中任何特征，按中性处理（默认可复核，不是"随便给个分"）' },
  };
}

module.exports = { scoreAffect, RULES, LABEL };
