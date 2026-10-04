import assert from 'node:assert/strict';
import { checkGrammar, reviewGrammarWithAi } from '../lib/grammar-check.mjs';

const find = (errors, quote) => errors.find((error) => error.quote.toLowerCase() === quote.toLowerCase());
const hasRule = (errors, rule) => errors.some((error) => error.rule === rule);

/* ------------------------------ 正例：必须命中 ------------------------------ */

const POSITIVE = [
  { text: 'He have a good idea.', rule: '主谓一致', quote: 'He have', fix: 'He has' },
  { text: 'They has finished the work.', rule: '主谓一致', quote: 'They has', fix: 'They have' },
  { text: 'I are very happy today.', rule: '主谓一致', quote: 'I are', fix: 'I am' },
  { text: 'They is working hard.', rule: '主谓一致', quote: 'They is', fix: 'They are' },
  { text: 'There is many people in the street.', rule: '主谓一致', quote: 'There is many', fix: 'there are many' },
  { text: 'This is a apple on the desk.', rule: '冠词', quote: 'a apple', fix: 'an apple' },
  { text: 'She read an book last week.', rule: '冠词', quote: 'an book', fix: 'a book' },
  { text: 'We need to goes there now.', rule: '动词形式', quote: 'to goes', fix: 'to go' },
  { text: 'Students should goes to class on time.', rule: '动词形式', quote: 'should goes', fix: 'should go' },
  { text: 'There are much people here.', rule: '单复数', quote: 'much people', fix: 'many people' },
  { text: 'He gave me many advice.', rule: '单复数', quote: 'many advice', fix: 'much advice' },
  { text: 'We should recognize it\'s importance clearly.', rule: '易混词', quote: "it's importance", fix: 'its importance' },
  { text: 'Parents should respect there own children.', rule: '易混词', quote: 'there own', fix: 'their own' },
  { text: 'I recieve a letter from him.', rule: '拼写', quote: 'recieve', fix: 'receive' },
  { text: 'The enviroment is getting worse.', rule: '拼写', quote: 'enviroment', fix: 'environment' },
  { text: 'Dear Jack: I am writing to invite you.', rule: '标点', quote: 'Dear Jack:', fix: 'Dear Jack,' },
  { text: 'This is the the best solution.', rule: '重复词', quote: 'the the', fix: 'the' },
];

for (const sample of POSITIVE) {
  const errors = checkGrammar(sample.text);
  assert.ok(errors.length > 0, `应命中错误：${sample.text}`);
  const hit = find(errors, sample.quote);
  assert.ok(hit, `应命中片段「${sample.quote}」：${sample.text}（实际：${errors.map((e) => e.quote).join(' / ')}）`);
  assert.equal(hit.rule, sample.rule, `规则应为 ${sample.rule}`);
  assert.equal(hit.replacement.toLowerCase(), sample.fix.toLowerCase(), `改法应为 ${sample.fix}`);
  assert.ok(hit.why, '必须给出中文说明');
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.source, 'offline');
}

// 小写句首与小写 i
const mechanics = checkGrammar('he is a student. i think so.');
assert.ok(hasRule(mechanics, '大小写'), '应命中大小写问题');
assert.ok(mechanics.some((error) => error.quote === 'i' && error.replacement === 'I'), '小写 i 应被命中');

// 时态：过去时间标记 + 现在时
const tense = checkGrammar('Last year he goes to Beijing.');
assert.ok(hasRule(tense, '时态'), `过去时间标记应触发时态检查：${JSON.stringify(tense.map((e) => e.rule))}`);

/* ------------- 带修饰语的主语与不规则复数（学生高频错误） ------------- */

const MODIFIER_CASES = [
  { text: 'Employees above 50 years old has the highest satisfaction.', quote: 'has', fix: 'have' },
  { text: 'Nowadays more and more people cares about this issue.', quote: 'people cares', fix: 'people care' },
  { text: 'Accordingly, companies should pays more attention.', quote: 'should pays', fix: 'should pay' },
  { text: 'The difference relates to there career situation.', quote: 'there career', fix: 'their career' },
  { text: 'They was content with the result.', quote: 'They was', fix: 'They were' },
];
for (const sample of MODIFIER_CASES) {
  const errors = checkGrammar(sample.text);
  const hit = find(errors, sample.quote);
  assert.ok(hit, `应命中「${sample.quote}」：${sample.text}（实际：${errors.map((e) => e.quote).join(' / ') || '无'}）`);
  assert.equal(hit.replacement.toLowerCase(), sample.fix.toLowerCase());
}

// 冲突消解：同一个词已有实质错误时，不得再提"首字母大写"，否则两条建议互相矛盾
const conflict = checkGrammar("it's impact is obvious.");
assert.ok(find(conflict, "it's impact"), '应命中 its 所有格错误');
assert.equal(conflict.some((error) => error.rule === '大小写' && error.quote.toLowerCase() === "it's"), false,
  "已有 it's→its 时不应再报 it's 首字母大写");
// 但纯粹的首字母小写仍要报
assert.ok(find(checkGrammar('he is a student.'), 'he'), '纯首字母小写仍应命中');

// a + 不可数名词复数：必须给出「去掉 a 与 s」的正确改法，而不是改冠词
const uncountable = checkGrammar('The table shows a informations about it.');
const uncountableHit = find(uncountable, 'a informations');
assert.ok(uncountableHit, '应命中 a informations');
assert.equal(uncountableHit.rule, '单复数');
assert.equal(uncountableHit.replacement, 'information', '应提示改为 information，而不是 an informations');

/* ------------------------------ 反例：不得误报 ------------------------------ */

const NEGATIVE = [
  'He has a good idea.',
  'They have finished the work.',
  'I am very happy today.',
  'They are working hard.',
  'There are many people in the street.',
  'This is an apple on the desk.',
  'She read a book last week.',
  // 发音例外：不能按字母机械判断
  'It took me an hour to finish the task.',
  'He is a university student in Beijing.',
  'This is a useful method for students.',
  'She is an honest person.',
  'We should adopt a unique approach.',
  'The European market keeps growing.',
  // 正确的 it's / its / their / there
  "It's important to keep learning.",
  'The company improved its performance.',
  'Parents should respect their own children.',
  'There are three books on the desk.',
  'We need to go there now.',
  'Students should go to class on time.',
  'He gave me much advice about it.',
  'There are many people here.',
  'Last year he went to Beijing.',
  'The environment is getting worse.',
  'Dear Jack, I am writing to invite you.',
  'This is the best solution.',
  // 复杂但正确的句子
  'Employees above 50 years old were most likely to report satisfaction, with 40% of them indicating they were content.',
  'Viewed within the context of everyday life, it is hardly surprising that diligence can bring considerable benefits.',
  'Only in this way can we achieve a better future for the next generation.',
  // of 短语的宾语不是主语，动词用三单是正确的（这类曾被误报，必须守住）
  'A series of measures has been taken.',
  'A number of students has applied.',
  'A variety of methods has been used.',
  'One of the students has finished.',
  'Each of the employees has a task.',
  'Neither of them has replied.',
  'The majority of people prefer online learning.',
  // 以 s 结尾的单数名词与学科名
  'Statistics shows a clear trend.',
  'The process is complicated.',
  'Our awareness is increasing.',
  // 不规则复数用对了动词
  'People care about the environment.',
  'The staff work very hard.',
  'The police have arrived.',
  'Companies should pay more attention.',
  'He pays attention to details.',
  'The government provides support.',
];

for (const sentence of NEGATIVE) {
  const errors = checkGrammar(sentence);
  assert.equal(errors.length, 0,
    `正确句子不应报错：${sentence}\n误报：${errors.map((e) => `${e.rule}「${e.quote}」→${e.replacement}`).join(' / ')}`);
}

/* --------------------------- 定位与去重 --------------------------- */

const essay = 'He have a apple. He have a apple again. They has left.';
const located = checkGrammar(essay);
for (const error of located) {
  // 每条错误必须能在原文中原样找到，否则无法做自动替换。
  assert.ok(essay.includes(error.quote), `片段必须能在原文定位：${error.quote}`);
}
// 同一规则同一片段只报一次
const keys = located.map((error) => `${error.rule}|${error.quote}`);
assert.equal(new Set(keys).size, keys.length, '同一片段不应重复上报');

assert.deepEqual(checkGrammar(''), [], '空文本应返回空数组');
assert.deepEqual(checkGrammar(null), [], 'null 应返回空数组');

// 小数不应被当作句末切分，避免把 87.5% 拆开导致定位错乱
const decimal = checkGrammar('The figure reached 87.5% last year and it have grown.');
assert.ok(decimal.every((error) => decimal.length === 0 || !error.quote.includes('5%')), '小数不应被切断');

/* ------------------------------ AI 复核层 ------------------------------ */

const base = 'He have a apple.';
const offline = checkGrammar(base);

// 模型编造原文中不存在的片段 → 必须丢弃
const fabricated = await reviewGrammarWithAi(base, offline, {
  chatJsonImpl: async () => ({ errors: [{ quote: 'she goes to school', replacement: 'she went to school', rule: '时态', why: '编造的' }] }),
});
assert.deepEqual(fabricated, [], '无法在原文定位的 AI 报错必须被丢弃');

// 与离线重复的不再重复上报
const duplicated = await reviewGrammarWithAi(base, offline, {
  chatJsonImpl: async () => ({ errors: [{ quote: 'He have', replacement: 'He has', rule: '主谓一致', why: '重复' }] }),
});
assert.deepEqual(duplicated, [], '与离线结果重复的应被过滤');

// 合法补充：片段真实存在且离线未发现
const supplementText = 'He has a book, and the informations are useful.';
const supplementOffline = checkGrammar(supplementText);
const supplemented = await reviewGrammarWithAi(supplementText, supplementOffline, {
  chatJsonImpl: async () => ({ errors: [{ quote: 'the informations are', replacement: 'the information is', rule: '单复数', why: 'information 不可数' }] }),
});
assert.equal(supplemented.length, 1, 'AI 合法补充应被保留');
assert.equal(supplemented[0].source, 'ai');
assert.equal(supplemented[0].confidence, 'high');
assert.ok(supplementText.includes(supplemented[0].quote));

// quote 与 replacement 相同视为无效
const noop = await reviewGrammarWithAi(base, [], {
  chatJsonImpl: async () => ({ errors: [{ quote: 'He have', replacement: 'He have', rule: 'x', why: 'y' }] }),
});
assert.deepEqual(noop, [], 'quote 等于 replacement 应被丢弃');

// 模型失败必须静默回退
assert.deepEqual(await reviewGrammarWithAi(base, offline, { chatJsonImpl: async () => { throw new Error('no key'); } }), [],
  '模型失败应回退为空数组');
assert.deepEqual(await reviewGrammarWithAi(base, offline, { chatJsonImpl: async () => ({}) }), [],
  '返回结构异常应回退');

console.log(`grammar-check verification passed: positive=${POSITIVE.length + 2} rules hit, negative=${NEGATIVE.length} no false positives, locate=ok, dedupe=ok, ai-guard=fabrication-rejected`);
