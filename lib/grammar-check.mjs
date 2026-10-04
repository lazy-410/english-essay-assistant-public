/**
 * 高置信语法检查。
 *
 * 设计取向：宁可漏报，也不误报。
 * 把学生写对的地方说成错，比漏掉一处错误更糟——前者会让人不敢相信整份批改。
 * 因此这里只做「能确定是错」的判定，全部基于词序列与有限词表，不依赖外部词典。
 *
 * 覆盖：主谓一致、冠词、时态一致、双动词/非原形、单复数搭配、
 *      it's/its 与 their/there、高频误拼、大小写标点、重复词。
 * 不覆盖：搭配不当、句子结构混乱等需要句法分析的问题（会在文档中如实说明）。
 *
 * AI 复核为可选层，且模型报的错必须能在原文中原样定位，否则丢弃。
 */

import { chatJson } from './deepseek.mjs';

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];

/* ------------------------------ 词表 ------------------------------ */

// 第三人称单数主语（不含 I / you / we / they）
const SINGULAR_SUBJECTS = new Set(['he', 'she', 'it', 'this', 'that', 'someone', 'somebody', 'everyone', 'everybody', 'nobody', 'anyone', 'anybody', 'nothing', 'something']);
const PLURAL_SUBJECTS = new Set(['we', 'they', 'these', 'those', 'people', 'students', 'employees', 'children', 'men', 'women', 'others']);

// 只列高频且不会歧义的动词，避免把名词当动词误判。
const VERB_PAIRS = [
  ['have', 'has'], ['do', 'does'], ['go', 'goes'], ['come', 'comes'], ['take', 'takes'], ['make', 'makes'],
  ['know', 'knows'], ['think', 'thinks'], ['need', 'needs'], ['want', 'wants'], ['like', 'likes'],
  ['live', 'lives'], ['work', 'works'], ['study', 'studies'], ['help', 'helps'], ['become', 'becomes'],
  ['feel', 'feels'], ['seem', 'seems'], ['show', 'shows'], ['give', 'gives'], ['find', 'finds'],
  ['keep', 'keeps'], ['play', 'plays'], ['learn', 'learns'], ['use', 'uses'], ['spend', 'spends'],
  ['reach', 'reaches'], ['pay', 'pays'], ['care', 'cares'], ['bring', 'brings'], ['improve', 'improves'],
  ['provide', 'provides'], ['develop', 'develops'], ['choose', 'chooses'], ['face', 'faces'],
  ['cause', 'causes'], ['create', 'creates'], ['realize', 'realizes'], ['reflect', 'reflects'],
  ['deserve', 'deserves'], ['prefer', 'prefers'], ['suffer', 'suffers'], ['benefit', 'benefits'],
];
const BASE_VERBS = new Set(VERB_PAIRS.map(([base]) => base));
const THIRD_SINGULAR_VERBS = new Set(VERB_PAIRS.map(([, third]) => third));
const BASE_OF_THIRD = new Map(VERB_PAIRS.map(([base, third]) => [third, base]));
const THIRD_OF_BASE = new Map([...BASE_OF_THIRD].map(([third, base]) => [base, third]));

// 情态动词后必须接原形
const MODALS = new Set(['can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must']);

// 过去式（仅高频不规则 + 规则动词由 -ed 判定）
const PAST_FORMS = new Set(['went', 'came', 'took', 'made', 'knew', 'thought', 'had', 'did', 'was', 'were', 'gave', 'found', 'kept', 'felt', 'became', 'spent']);
const BASE_OF_PAST = new Map([['went', 'go'], ['came', 'come'], ['took', 'take'], ['made', 'make'], ['knew', 'know'], ['thought', 'think'], ['gave', 'give'], ['found', 'find'], ['kept', 'keep'], ['felt', 'feel'], ['became', 'become'], ['spent', 'spend']]);

// a/an 例外：拼写首字母与实际发音不一致的高频词
const VOWEL_SOUND_CONSONANT_LETTER = new Set(['hour', 'honest', 'honour', 'honor', 'heir']);
const CONSONANT_SOUND_VOWEL_LETTER = new Set(['university', 'universal', 'user', 'useful', 'unique', 'union', 'united', 'european', 'one', 'once', 'uniform']);

// 明确不可数的高频名词
const UNCOUNTABLE = new Set(['information', 'advice', 'knowledge', 'progress', 'research', 'equipment', 'furniture', 'homework', 'money', 'water', 'air', 'time', 'work', 'news', 'traffic']);

// 高频误拼（只收确定错误，不做通用拼写检查）
const MISSPELLINGS = new Map([
  ['recieve', 'receive'], ['acheive', 'achieve'], ['beleive', 'believe'], ['enviroment', 'environment'],
  ['goverment', 'government'], ['occured', 'occurred'], ['seperate', 'separate'], ['definately', 'definitely'],
  ['neccessary', 'necessary'], ['sucessful', 'successful'], ['begining', 'beginning'], ['tommorrow', 'tomorrow'],
  ['untill', 'until'], ['wich', 'which'], ['thier', 'their'], ['becuase', 'because'], ['reccomend', 'recommend'],
  ['oppurtunity', 'opportunity'], ['knowlege', 'knowledge'], ['advantagous', 'advantageous'],
  ['comunication', 'communication'], ['developement', 'development'], ['independant', 'independent'],
  ['persuit', 'pursuit'], ['reponsible', 'responsible'], ['sincerly', 'sincerely'], ['succesful', 'successful'],
]);

const PAST_MARKERS = /\b(yesterday|last\s+(?:year|month|week|term|semester|summer|winter|night)|in\s+(?:19|20)\d{2}|ago|once\s+upon)\b/i;

/**
 * 是否为可靠的复数名词。
 * 只认「-s 结尾且不在例外表内」，例外表覆盖以 s 结尾的单数名词与不可数名词，
 * 宁可漏判也不能把 business / analysis 当成复数。
 */
const S_ENDING_SINGULAR = new Set([
  'business', 'analysis', 'basis', 'crisis', 'emphasis', 'thesis', 'campus', 'status', 'focus', 'bonus',
  'series', 'species', 'means', 'news', 'process', 'access', 'success', 'progress', 'stress', 'address',
  'class', 'glass', 'grass', 'press', 'less', 'loss', 'mass', 'pass', 'illness', 'awareness', 'happiness',
  'this', 'his', 'its', 'us', 'yes', 'perhaps', 'various', 'serious', 'previous', 'obvious', 'numerous',
  'physics', 'economics', 'politics', 'mathematics', 'statistics', 'always', 'sometimes', 'thus', 'is', 'was', 'has',
]);

// 不以 s 结尾但语义为复数的高频名词
const IRREGULAR_PLURALS = new Set(['people', 'children', 'men', 'women', 'youth', 'police', 'staff']);

function isPluralNoun(lower) {
  if (IRREGULAR_PLURALS.has(lower)) return true;
  if (!lower.endsWith('s') || lower.length < 4) return false;
  if (S_ENDING_SINGULAR.has(lower)) return false;
  if (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) return false;
  // 所有格与缩写不算
  if (lower.includes("'")) return false;
  // 三单动词形式不能当作名词主语
  if (THIRD_SINGULAR_VERBS.has(lower)) return false;
  if (UNCOUNTABLE.has(lower.slice(0, -1))) return false;
  return true;
}

/* ------------------------------ 分词 ------------------------------ */

/** 保留原始位置，便于把错误精确定位回原文。 */
function tokenize(sentence) {
  const tokens = [];
  const regex = /[A-Za-z][A-Za-z']*/g;
  let match;
  while ((match = regex.exec(sentence))) {
    tokens.push({ word: match[0], lower: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function splitSentences(body) {
  const out = [];
  const source = text(body);
  let buffer = '';
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    buffer += character;
    if (!'.!?'.includes(character)) continue;
    const before = source[index - 1] ?? '';
    const after = source[index + 1] ?? '';
    if (character === '.' && /\d/.test(before) && /\d/.test(after)) continue;
    if (/[A-Za-z0-9]/.test(after)) continue;
    if (buffer.trim()) out.push({ text: buffer.trim(), offset: start + (buffer.length - buffer.trimStart().length) });
    start = index + 1;
    buffer = '';
  }
  if (buffer.trim()) out.push({ text: buffer.trim(), offset: start + (buffer.length - buffer.trimStart().length) });
  return out;
}

/* ------------------------------ 规则 ------------------------------ */

function makeError(rule, quote, replacement, why, { sentence = '', offset = null } = {}) {
  return { rule, quote, replacement, why, confidence: 'high', sentence, offset, source: 'offline' };
}

/** 主谓一致 */
function checkAgreement(tokens, errors, context) {
  /**
   * of 短语的宾语不是句子主语：
   * 「a number of students has applied」「one of the employees has a task」都是正确英文。
   * of 可能隔着冠词，因此往前看两个词。
   */
  const isOfObject = (index) => tokens[index - 1]?.lower === 'of' || tokens[index - 2]?.lower === 'of';

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const subject = tokens[index];
    const verb = tokens[index + 1];
    if (isOfObject(index)) continue;
    // he have → he has
    if (SINGULAR_SUBJECTS.has(subject.lower) && BASE_VERBS.has(verb.lower)) {
      const fixed = THIRD_OF_BASE.get(verb.lower);
      if (fixed) {
        errors.push(makeError('主谓一致', `${subject.word} ${verb.word}`, `${subject.word} ${fixed}`,
          `第三人称单数主语「${subject.word}」后动词要用三单形式`, context));
      }
    }
    // they has → they have
    if (PLURAL_SUBJECTS.has(subject.lower) && THIRD_SINGULAR_VERBS.has(verb.lower)) {
      const fixed = BASE_OF_THIRD.get(verb.lower);
      if (fixed) {
        errors.push(makeError('主谓一致', `${subject.word} ${verb.word}`, `${subject.word} ${fixed}`,
          `复数主语「${subject.word}」后动词要用原形`, context));
      }
    }
    // I are / I is → I am
    if (subject.lower === 'i' && (verb.lower === 'are' || verb.lower === 'is')) {
      errors.push(makeError('主谓一致', `${subject.word} ${verb.word}`, `${subject.word} am`, 'I 后面的 be 动词是 am', context));
    }
    if (PLURAL_SUBJECTS.has(subject.lower) && verb.lower === 'is') {
      errors.push(makeError('主谓一致', `${subject.word} ${verb.word}`, `${subject.word} are`,
        `复数主语「${subject.word}」后 be 动词用 are`, context));
    }
    if (SINGULAR_SUBJECTS.has(subject.lower) && verb.lower === 'are') {
      errors.push(makeError('主谓一致', `${subject.word} ${verb.word}`, `${subject.word} is`,
        `单数主语「${subject.word}」后 be 动词用 is`, context));
    }
  }
  // 名词短语主语：复数名词 + 三单动词 / was。
  // 学生最常见的错误是「Employees … has」「they was」，只靠代词词表会全部漏掉。
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const noun = tokens[index];
    const verb = tokens[index + 1];
    if (!isPluralNoun(noun.lower)) continue;
    // 「a series of measures has」「one of the students has」这类结构里，真正的主语
    // 是 of 之前的名词，复数名词只是 of 的宾语，动词用三单是正确的。
    // of 可能隔着冠词（of the students），因此往前看两个词。
    if (tokens[index - 1]?.lower === 'of' || tokens[index - 2]?.lower === 'of') continue;
    const previous = tokens[index - 1]?.lower ?? '';
    if (previous === 'a' || previous === 'an' || previous === 'one') continue;
    if (THIRD_SINGULAR_VERBS.has(verb.lower)) {
      errors.push(makeError('主谓一致', `${noun.word} ${verb.word}`, `${noun.word} ${BASE_OF_THIRD.get(verb.lower)}`,
        `复数主语「${noun.word}」后动词用原形`, context));
    } else if (verb.lower === 'was') {
      errors.push(makeError('主谓一致', `${noun.word} ${verb.word}`, `${noun.word} were`,
        `复数主语「${noun.word}」后 be 动词用 were`, context));
    } else if (verb.lower === 'is') {
      errors.push(makeError('主谓一致', `${noun.word} ${verb.word}`, `${noun.word} are`,
        `复数主语「${noun.word}」后 be 动词用 are`, context));
    }
  }
  // they was / we was
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!PLURAL_SUBJECTS.has(tokens[index].lower)) continue;
    if (tokens[index + 1].lower !== 'was') continue;
    errors.push(makeError('主谓一致', `${tokens[index].word} was`, `${tokens[index].word} were`,
      `复数主语「${tokens[index].word}」后 be 动词用 were`, context));
  }

  /*
   * 带修饰语的主语：Employees above 50 years old has …
   * 只在句首主语与谓语之间全是修饰成分（介词短语/形容词/数词）时判定，
   * 一旦中间出现连词、逗号或另一个动词就放弃，避免把从句主语算错。
   */
  const firstVerbIndex = tokens.findIndex((token) => THIRD_SINGULAR_VERBS.has(token.lower) || token.lower === 'was');
  if (firstVerbIndex > 1) {
    const subject = tokens[0];
    const middle = tokens.slice(1, firstVerbIndex);
    const BLOCKERS = new Set(['and', 'or', 'but', 'that', 'which', 'who', 'whom', 'whose', 'if', 'when', 'while', 'because', 'to']);
    const clean = middle.every((token) => !BLOCKERS.has(token.lower)
      && !THIRD_SINGULAR_VERBS.has(token.lower)
      && !BASE_VERBS.has(token.lower)
      && !PAST_FORMS.has(token.lower));
    const isPluralSubject = PLURAL_SUBJECTS.has(subject.lower) || isPluralNoun(subject.lower);
    // 「A number of students has …」的真主语是 number（单数），不能按 students 判。
    const hasOfPhrase = middle.some((token) => token.lower === 'of');
    if (clean && isPluralSubject && !hasOfPhrase && middle.length <= 5) {
      const verb = tokens[firstVerbIndex];
      const fixed = verb.lower === 'was' ? 'were' : BASE_OF_THIRD.get(verb.lower);
      if (fixed) {
        errors.push(makeError('主谓一致', verb.word, fixed,
          `主语「${subject.word}」是复数，谓语「${verb.word}」应改为 ${fixed}`, context));
      }
    }
  }

  // more and more people cares → care
  // 这里也必须排除 of 前置，否则「a number of students has」会被误判。
  const quantified = tokens.findIndex((token, index) => isPluralNoun(token.lower)
    && tokens[index - 1]?.lower !== 'of' && tokens[index - 2]?.lower !== 'of'
    && THIRD_SINGULAR_VERBS.has(tokens[index + 1]?.lower ?? ''));
  if (quantified >= 0) {
    const noun = tokens[quantified];
    const verb = tokens[quantified + 1];
    const fixed = BASE_OF_THIRD.get(verb.lower);
    if (fixed) {
      errors.push(makeError('主谓一致', `${noun.word} ${verb.word}`, `${noun.word} ${fixed}`,
        `复数主语「${noun.word}」后动词用原形`, context));
    }
  }

  // there is + 明确复数
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].lower !== 'there') continue;
    if (tokens[index + 1].lower !== 'is') continue;
    const next = tokens[index + 2];
    if (PLURAL_SUBJECTS.has(next.lower) || /^(?:many|several|few|both)$/.test(next.lower)) {
      // 必须沿用原文大小写，否则片段无法在原文中定位而被丢弃。
      const original = tokens[index].word;
      errors.push(makeError('主谓一致', `${original} ${tokens[index + 1].word} ${next.word}`,
        `${original} are ${next.word}`, '后接复数时用 There are', context));
    }
  }
}

/** 冠词 a / an */
function checkArticles(tokens, errors, context) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const article = tokens[index];
    const next = tokens[index + 1];
    if (article.lower !== 'a' && article.lower !== 'an') continue;
    // 不可数名词误加复数时由单复数规则处理，避免给出"改冠词"的错误建议。
    if (next.lower.endsWith('s') && UNCOUNTABLE.has(next.lower.slice(0, -1))) continue;
    const startsVowelLetter = /^[aeiou]/.test(next.lower);
    // 例外优先：a university（发音辅音）、an hour（发音元音）
    if (CONSONANT_SOUND_VOWEL_LETTER.has(next.lower)) {
      if (article.lower === 'an') {
        errors.push(makeError('冠词', `${article.word} ${next.word}`, `a ${next.word}`,
          `${next.word} 首音是辅音，用 a`, context));
      }
      continue;
    }
    if (VOWEL_SOUND_CONSONANT_LETTER.has(next.lower)) {
      if (article.lower === 'a') {
        errors.push(makeError('冠词', `${article.word} ${next.word}`, `an ${next.word}`,
          `${next.word} 首音是元音，用 an`, context));
      }
      continue;
    }
    if (article.lower === 'a' && startsVowelLetter) {
      errors.push(makeError('冠词', `${article.word} ${next.word}`, `an ${next.word}`,
        `${next.word} 以元音音素开头，用 an`, context));
    }
    if (article.lower === 'an' && !startsVowelLetter) {
      errors.push(makeError('冠词', `${article.word} ${next.word}`, `a ${next.word}`,
        `${next.word} 以辅音开头，用 a`, context));
    }
  }
}

/** 双动词、非原形 */
function checkVerbForms(tokens, errors, context) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    // to goes / to went → to go
    if (current.lower === 'to') {
      if (THIRD_SINGULAR_VERBS.has(next.lower)) {
        errors.push(makeError('动词形式', `to ${next.word}`, `to ${BASE_OF_THIRD.get(next.lower)}`,
          'to 后面接动词原形', context));
      } else if (BASE_OF_PAST.has(next.lower)) {
        errors.push(makeError('动词形式', `to ${next.word}`, `to ${BASE_OF_PAST.get(next.lower)}`,
          'to 后面接动词原形', context));
      }
    }
    // should goes → should go
    if (MODALS.has(current.lower)) {
      if (THIRD_SINGULAR_VERBS.has(next.lower)) {
        errors.push(makeError('动词形式', `${current.word} ${next.word}`, `${current.word} ${BASE_OF_THIRD.get(next.lower)}`,
          `情态动词「${current.word}」后接动词原形`, context));
      } else if (BASE_OF_PAST.has(next.lower)) {
        errors.push(makeError('动词形式', `${current.word} ${next.word}`, `${current.word} ${BASE_OF_PAST.get(next.lower)}`,
          `情态动词「${current.word}」后接动词原形`, context));
      } else {
        // 情态动词后出现 -s 结尾词，且还原出的原形在动词表中时，视为误用三单（should pays）。
        const base = next.lower.replace(/ies$/, 'y').replace(/(?:es|s)$/, '');
        if (base !== next.lower && BASE_VERBS.has(base)) {
          errors.push(makeError('动词形式', `${current.word} ${next.word}`, `${current.word} ${base}`,
            `情态动词「${current.word}」后接动词原形`, context));
        }
      }
    }
  }
}

/** 单复数搭配 */
function checkNumber(tokens, errors, context) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    // a/an + 不可数名词的复数形式（a informations）：真正的问题是名词不该加 s，
    // 若只提示改冠词会给出错误建议，因此这里优先命中并给出正确改法。
    if ((current.lower === 'a' || current.lower === 'an') && next.lower.endsWith('s')
      && UNCOUNTABLE.has(next.lower.slice(0, -1))) {
      errors.push(makeError('单复数', `${current.word} ${next.word}`, next.word.slice(0, -1),
        `${next.lower.slice(0, -1)} 不可数，既不加 a/an 也不加复数 s`, context));
      continue;
    }
    // much + 可数复数（仅用明确复数词表，避免误判）
    if (current.lower === 'much' && PLURAL_SUBJECTS.has(next.lower)) {
      errors.push(makeError('单复数', `${current.word} ${next.word}`, `many ${next.word}`,
        `${next.word} 是可数复数，用 many`, context));
    }
    // many + 明确不可数
    if (current.lower === 'many' && UNCOUNTABLE.has(next.lower)) {
      errors.push(makeError('单复数', `${current.word} ${next.word}`, `much ${next.word}`,
        `${next.word} 不可数，用 much`, context));
    }
    // a + 明确复数
    if ((current.lower === 'a' || current.lower === 'an') && PLURAL_SUBJECTS.has(next.lower) && next.lower !== 'people') {
      errors.push(makeError('单复数', `${current.word} ${next.word}`, next.word,
        `${next.word} 是复数，前面不加 a/an`, context));
    }
  }
}

/** it's / its、their / there */
function checkConfusables(sentence, errors, context) {
  // it's + 名词 → its（所有格）
  const possessive = sentence.match(/\bit's\s+(own|importance|significance|impact|influence|role|value|meaning|purpose)\b/i);
  if (possessive) {
    errors.push(makeError('易混词', possessive[0], possessive[0].replace(/it's/i, 'its'),
      '表示「它的」用所有格 its，it\'s 是 it is 的缩写', context));
  }
  // its + is/was → it's
  const contraction = sentence.match(/\bits\s+(?:is|was)\b/i);
  if (contraction) {
    errors.push(makeError('易混词', contraction[0], contraction[0].replace(/\bits\b/i, "it's"),
      'it is 的缩写是 it\'s，its 是所有格', context));
  }
  // there + 名词所有格位置 → their
  const theirs = sentence.match(/\bthere\s+(own|opinions?|views?|lives?|parents?|children|future|study|studies|jobs?|career|careers|families|family|work|attitudes?|behaviou?rs?)\b/i);
  if (theirs) {
    errors.push(makeError('易混词', theirs[0], theirs[0].replace(/there/i, 'their'),
      '表示「他们的」用 their，there 表示「那里」', context));
  }
}

/** 时态一致：过去时间标记 + 现在时动词 */
function checkTense(sentence, tokens, errors, context) {
  if (!PAST_MARKERS.test(sentence)) return;
  for (const token of tokens) {
    if (!THIRD_SINGULAR_VERBS.has(token.lower)) continue;
    // 已有过去式则不判定（可能是并列结构）
    if (tokens.some((item) => PAST_FORMS.has(item.lower) || /ed$/.test(item.lower))) return;
    errors.push(makeError('时态', token.word, '（改为过去式）',
      '句中出现过去时间标记，动词应用过去式', context));
    return;
  }
}

/** 拼写 */
function checkSpelling(tokens, errors, context) {
  for (const token of tokens) {
    const fixed = MISSPELLINGS.get(token.lower);
    if (fixed) {
      errors.push(makeError('拼写', token.word, fixed, `${token.word} 拼写错误`, context));
    }
  }
}

/** 大小写与标点 */
function checkMechanics(sentence, errors, context) {
  const first = sentence.match(/^[a-z]/);
  if (first) {
    // 只取首个单词，避免片段里裹进别的错误（如 it's/its）而给出互相矛盾的改法。
    const firstWord = sentence.match(/^[a-z][A-Za-z']*/)?.[0] ?? sentence.charAt(0);
    errors.push(makeError('大小写', firstWord,
      firstWord.charAt(0).toUpperCase() + firstWord.slice(1),
      '句首字母要大写', context));
  }
  // 单独的小写 i 作主语
  const lowerI = sentence.match(/(?:^|\s)i(?=\s|'|,)/);
  if (lowerI) {
    errors.push(makeError('大小写', 'i', 'I', '第一人称 I 永远大写', context));
  }
  // 称谓后用冒号（讲义 P9 明确提醒）
  const salutation = sentence.match(/\b(Dear\s+[A-Z][A-Za-z]*)\s*:/);
  if (salutation) {
    errors.push(makeError('标点', salutation[0], `${salutation[1]},`,
      '称谓后用逗号，不用冒号（讲义 P9）', context));
  }
  // 重复词
  const repeat = sentence.match(/\b(the|is|are|was|were|a|an|to|of|and|that|in)\s+\1\b/i);
  if (repeat) {
    errors.push(makeError('重复词', repeat[0], repeat[1], '出现重复词', context));
  }
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 离线语法检查。
 * @returns {Array<{rule,quote,replacement,why,confidence,sentence,offset,source}>}
 */
export function checkGrammar(body) {
  const source = text(body);
  if (!source) return [];
  const errors = [];
  for (const { text: sentence, offset } of splitSentences(source)) {
    const tokens = tokenize(sentence);
    const context = { sentence, offset };
    checkAgreement(tokens, errors, context);
    checkArticles(tokens, errors, context);
    checkVerbForms(tokens, errors, context);
    checkNumber(tokens, errors, context);
    checkConfusables(sentence, errors, context);
    checkTense(sentence, tokens, errors, context);
    checkSpelling(tokens, errors, context);
    checkMechanics(sentence, errors, context);
  }
  // 同一片段只报一次，且必须能在原文中定位。
  const seen = new Set();
  const filtered = errors.filter((error) => {
    if (error.confidence !== 'high') return false;
    if (!source.includes(error.quote)) return false;
    const key = `${error.rule}|${error.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  /*
   * 冲突消解：若某个词已有更实质的错误（如 it's → its），
   * 就不要再对同一个词提"首字母大写"，否则两条建议互相矛盾，用户无从下手。
   */
  const substantive = new Set();
  for (const error of filtered) {
    if (error.rule === '大小写') continue;
    for (const word of error.quote.toLowerCase().split(/\s+/)) substantive.add(word);
  }
  return filtered.filter((error) => {
    if (error.rule !== '大小写') return true;
    return !substantive.has(error.quote.toLowerCase());
  });
}

const AI_SYSTEM = `你是英语作文语法检查助手，面向考研英语作文。
已给出规则引擎发现的错误列表，请只补充列表中【没有】的明显语法错误。
硬性要求：
1. quote 必须是原文中【原样存在】的连续片段，不得改写、不得省略、不得加引号；
2. 只报明显的语法或拼写错误（主谓、时态、冠词、词形、拼写、标点），不报文风或用词偏好；
3. 不确定的一律不报；
4. replacement 给出改正后的片段。
严格返回 JSON：{"errors":[{"quote":"","replacement":"","rule":"","why":"中文说明，30字内"}]}`;

/** AI 复核层：只补充离线未覆盖的错误，且 quote 必须能在原文定位。 */
export async function reviewGrammarWithAi(body, offlineErrors = [], { chatJsonImpl } = {}) {
  const source = text(body);
  if (!source) return [];
  const impl = typeof chatJsonImpl === 'function' ? chatJsonImpl : chatJson;
  try {
    const response = await impl({
      tier: 'fast',
      system: AI_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          essay: source,
          alreadyFound: array(offlineErrors).map((error) => error.quote),
        }),
      }],
      temperature: 0,
      maxTokens: 1600,
      responseFormat: { type: 'json_object' },
    });
    const raw = response?.data && typeof response.data === 'object' ? response.data : response;
    const known = new Set(array(offlineErrors).map((error) => error.quote));
    const out = [];
    for (const item of array(raw?.errors)) {
      const quote = text(item?.quote);
      const replacement = text(item?.replacement);
      // 模型编造的片段一律丢弃：这是防止"凭空报错"的关键闸门。
      if (!quote || !replacement || quote === replacement) continue;
      if (!source.includes(quote)) continue;
      if (known.has(quote)) continue;
      known.add(quote);
      out.push({
        rule: text(item?.rule) || '语法',
        quote,
        replacement,
        why: text(item?.why) || 'AI 复核发现的语法问题',
        confidence: 'high',
        sentence: '',
        offset: null,
        source: 'ai',
      });
    }
    return out.slice(0, 8);
  } catch {
    return [];
  }
}

export default { checkGrammar, reviewGrammarWithAi };
