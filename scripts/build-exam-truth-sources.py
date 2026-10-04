"""
为每道大作文汇集「题图事实」的原文证据，供人工/模型核定标准答案。

来源（全部是用户提供的本地 PDF，不做任何生成）：
  - 真题合集：题干原文（图中文字多为嵌入图片，文本层通常取不到）
  - 黄皮书：专家对照真图写的范文（首段是客观画面描述）
  - 石雷鹏讲义：「N 年英语X：主题」页的观察要点、课堂练笔、参考范文
  - 题库 exams.json：已校对的范文首段

输出 tmp/exam-truth-sources.json：{ examId: { prompt, yellowBook, slp, bank } }
"""
import fitz, json, re, sys, os

sys.stdout.reconfigure(encoding='utf-8')
ATTACHED = r'C:/Users/懒将军/.narrafork/attached/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(ROOT), 'tmp', 'exam-truth-sources.json')

SLP_HDR = re.compile(r'^26\s*石雷鹏[^）]*）\s*公众号【学长小谭考研】免费分享\s*关注获取更多考研的干货资料\s*\d*\s*')
YB_HDR = re.compile(r'^公众号/B\s*站/小红书：夫人的秘密花园\s*\d*\s*')


def page_text(doc, i, hdr=None):
    t = ' '.join(doc[i].get_text().split())
    return hdr.sub('', t).strip() if hdr else t


def yellow_book(path, tag):
    """黄皮书：每年两页（小作文 + 大作文），大作文页以 Part B 的 Directions 开头。"""
    doc = fitz.open(path)
    starts = []
    for i in range(len(doc)):
        m = re.search(r'英语[一二]\s*(20\d{2})\s*年', doc[i].get_text())
        if m:
            starts.append((int(m.group(1)), i))
    out = {}
    for idx, (year, start) in enumerate(starts):
        end = starts[idx + 1][1] if idx + 1 < len(starts) else len(doc)
        text = ' '.join(page_text(doc, i, YB_HDR) for i in range(start, end))
        # 大作文段：第二个 Directions 之后（第一个是小作文）
        parts = re.split(r'Directions\s*:', text)
        big = parts[2] if len(parts) > 2 else (parts[1] if len(parts) > 1 else '')
        body = re.split(r'\(\s*(?:20|15)\s*points?\s*\)\.?', big, maxsplit=1)
        essay = body[1].strip() if len(body) > 1 else ''
        out[f'{tag}-{year}-b'] = {'directions': body[0].strip()[:600], 'essay': essay[:2400]}
    return out


def slp(path, tag):
    """石雷鹏讲义：「19 年英语一：爬山」开头的页起，到下一个同类标题止。"""
    doc = fitz.open(path)
    heads = []
    for i in range(len(doc)):
        t = page_text(doc, i, SLP_HDR)
        m = re.match(r'(\d{2})\s*年\s*英语[一二]\s*[：:]\s*(\S{1,12})', t)
        if m:
            heads.append((2000 + int(m.group(1)), m.group(2), i))
            continue
        # 早年真题以「实训N：主题（YY 年）」形式出现，且可能不在页首
        m = re.search(r'实训\s*\d+\s*[：:]\s*(\S{1,12}?)\s*[（(]\s*(\d{2})\s*年\s*[)）]\s*Directions', t)
        if m:
            heads.append((2000 + int(m.group(2)), m.group(1), i))
    heads.sort(key=lambda h: h[2])
    out = {}
    for idx, (year, topic, start) in enumerate(heads):
        end = heads[idx + 1][2] if idx + 1 < len(heads) else min(start + 4, len(doc))
        text = ' '.join(page_text(doc, i, SLP_HDR) for i in range(start, end))
        # 实训标题可能在页中，从标题处截起，避免混入上一题的尾段
        anchor = re.search(r'实训\s*\d+\s*[：:]\s*\S{1,12}?\s*[（(]\s*%02d\s*年' % (year % 100), text)
        if anchor:
            text = text[anchor.start():]
        observe = ''
        m = re.search(r'(?:解读误区)?观察要点[：:]?(.{0,900}?)(?:课堂练笔|写作思路|•\s*表达技巧)', text)
        if m:
            observe = m.group(1).strip()
        else:
            # 实训题没有「观察要点」，题干里的（图一：…）括注就是图中原文转述
            notes = re.findall(r'[（(]\s*((?:图[一二三四]|注)\s*[：:][^）)]{1,60})[)）]', text[:1500])
            if notes:
                observe = '；'.join(n.strip() for n in notes)
        first_para = ''
        m = re.search(r'课堂练笔[：:]?\s*首段[：:]?(.{0,1400}?)(?:二段|第二段)', text)
        if m:
            first_para = m.group(1).strip()
        ref = ''
        m = re.search(r'参考范文[：:]\s*(.{0,1600}?)(?:参考译文|$)', text)
        if m:
            ref = m.group(1).strip()
        out[f'{tag}-{year}-b'] = {'topic': topic, 'observe': observe, 'firstPara': first_para, 'reference': ref[:1600]}
    return out


def prompts(path, tag):
    doc = fitz.open(path)
    full = '\n'.join(doc[i].get_text() for i in range(len(doc)))
    out = {}
    for m in re.finditer(r'(20\d{2})\s*年考研英语[（(][一二][)）]大小作文(.*?)(?=20\d{2}\s*年考研英语[（(][一二][)）]大小作文|$)', full, re.S):
        year = int(m.group(1))
        block = m.group(2)
        part_b = block.split('Part B', 1)[1] if 'Part B' in block else block
        out[f'{tag}-{year}-b'] = re.sub(r'公众号：英语外刊精读笔记', '', part_b).strip()[:1200]
    return out


def bank():
    with open(os.path.join(ROOT, 'knowledge', 'exams.json'), encoding='utf-8') as f:
        data = json.load(f)
    exams = data if isinstance(data, list) else data.get('exams', [])
    out = {}
    for e in exams:
        if e.get('section') != 'big':
            continue
        paras = (e.get('modelEssay') or {}).get('paragraphs') or []
        out[e['id']] = {
            'essayType': e.get('essayType'),
            'promptTail': re.split(r'\(\s*(?:20|15)\s+points?\s*\)\.?', e.get('prompt') or '', maxsplit=1)[-1].strip()[:800],
            'firstPara': paras[0]['text'] if paras else '',
        }
    return out


def main():
    sources = {
        'yb': {**yellow_book(ATTACHED + '黄皮书英语一大小作文（2010-2024）｜夫人的秘密花园.pdf', 'e1'),
               **yellow_book(ATTACHED + '黄皮书英语二大小作文（2010-2024）｜夫人的秘密花园.pdf', 'e2')},
        'slp': {**slp(ATTACHED + '26石雷鹏大作文笔记 - 英语一【公众号：学长小谭考研】.pdf', 'e1'),
                **slp(ATTACHED + '26石雷鹏大作文笔记 - 英语二【公众号：学长小谭考研】.pdf', 'e2')},
        'prompt': {**prompts(ATTACHED + '考研英语一 大作文+小作文历年真题合集（2005-2025）(1).pdf', 'e1'),
                   **prompts(ATTACHED + '考研英语二 大作文+小作文历年真题合集（2010-2025）.pdf', 'e2')},
        'bank': bank(),
    }
    merged = {}
    for exam_id in sorted(sources['bank']):
        merged[exam_id] = {k: sources[k].get(exam_id) for k in ('bank', 'prompt', 'yb', 'slp')}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)
    for exam_id, v in merged.items():
        flags = ''.join('Y' if v.get(k) else '.' for k in ('prompt', 'yb', 'slp'))
        print(f'{exam_id:10} 题干/黄皮书/讲义={flags}  type={v["bank"]["essayType"]}')
    print('written', OUT)


if __name__ == '__main__':
    main()
