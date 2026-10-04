#!/usr/bin/env python3
"""Import offline postgraduate English exam prompts and model essays.

The importer intentionally keeps exam data separate from knowledge/templates.json.
It uses the two exam-compilation PDFs for canonical prompts and the two Huangpi
PDFs only for 2010-2024 model essays.  Large-picture assets are extracted from
embedded images when possible; vector charts are rendered from the Part B region.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parents[1]
ATTACHED = Path(r"C:/Users/懒将军/.narrafork/attached")
OUT_JSON = ROOT / "knowledge" / "exams.json"
ASSET_DIR = ROOT / "exam-assets"

SOURCES = {
    "e1": ATTACHED / "考研英语一 大作文+小作文历年真题合集（2005-2025）(1).pdf",
    "e2": ATTACHED / "考研英语二 大作文+小作文历年真题合集（2010-2025）.pdf",
    "h1": ATTACHED / "黄皮书英语一大小作文（2010-2024）｜夫人的秘密花园.pdf",
    "h2": ATTACHED / "黄皮书英语二大小作文（2010-2024）｜夫人的秘密花园.pdf",
}


def compact(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clean_lines(text: str) -> list[str]:
    out = []
    for raw in text.replace("\r", "").split("\n"):
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            out.append("")
            continue
        if "公众号" in line or "夫人的秘密花园" in line:
            continue
        # Page labels and the repeated compiler title are not exam content.
        if re.fullmatch(r"[-–—]?\s*\d+\s*[-–—]?", line):
            continue
        if "英语（一）大小作文合集" in line or "英语（二）大小作文合集" in line:
            continue
        out.append(line)
    return out


def year_from(text: str, fallback: int) -> int:
    m = re.search(r"((?:19|20)\d{2})\s*年", text)
    return int(m.group(1)) if m else fallback


def split_parts(text: str) -> dict[str, str]:
    # The source PDFs contain exactly one Part A and one Part B per exam page.
    matches = list(re.finditer(r"\bPart\s*([AB])\b", text, re.I))
    if len(matches) < 2:
        return {"A": "", "B": ""}
    a, b = matches[0], matches[1]
    return {"A": text[a.end():b.start()], "B": text[b.end():]}


def section_text(raw: str) -> str:
    lines = clean_lines(raw)
    while lines and not lines[0]:
        lines.pop(0)
    text = "\n".join(lines)
    # Keep the actual directions and any answer constraints; drop compiler noise.
    return compact(text)


def requirements(directions: str) -> list[str]:
    req: list[str] = []
    for line in directions.splitlines():
        line = line.strip()
        # Only numbered task bullets are requirements. Exclude question
        # numbers (51./52.), chart percentages (84.8%) and dates.
        if re.match(r"^(?:[1-9]\d?|[a-z])\s*[\)]", line, re.I):
            req.append(line)
    return req


def essay_type(section: str) -> str:
    lower = section.lower()
    has_chart = bool(re.search(r"\b(chart|diagram|bar graph|table|graph)\b", lower))
    has_picture = bool(re.search(r"\b(picture|drawing|photo|photos|cartoon|figures?)\b", lower))
    if has_chart and has_picture:
        return "hybrid"
    if has_chart:
        return "chart"
    if has_picture:
        return "picture"
    # Part B prompts without an explicit visual word still ask for the visual
    # supplied on the answer sheet (notably some older English-I pages).
    return "picture"


def part_b_cutoff(page: fitz.Page, b_start: float) -> float:
    """Return the y coordinate after the Part B directions, before its visual."""
    blocks = page.get_text("blocks")
    candidates: list[tuple[float, str]] = []
    for block in blocks:
        y0, y1, txt = block[1], block[3], block[4]
        if y1 <= b_start:
            continue
        candidates.append((y1, txt.strip()))
    cutoff = b_start + 20
    for y1, txt in candidates:
        if re.search(r"ANSWER\s*SHEET|\(\s*1[05]\s*points?\s*\)|points?\s*\)?", txt, re.I):
            cutoff = max(cutoff, y1)
    return min(cutoff + 5, page.rect.height - 35)


def embedded_visual(page: fitz.Page, b_start: float, asset: Path) -> bool:
    """Extract the largest non-square embedded image belonging to Part B."""
    choices: list[tuple[int, int, fitz.Rect, int]] = []
    for info in page.get_images(full=True):
        xref, width, height = info[0], info[2], info[3]
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            rects = []
        for rect in rects:
            if rect.y1 <= b_start or width < 100 or height < 100:
                continue
            # The 2048x2048 square image used by these PDFs is a page/logo
            # background, not the requested exam visual.
            if width == height and width >= 1000:
                continue
            choices.append((width * height, xref, rect, height))
    if not choices:
        return False
    _, xref, _, _ = max(choices)
    try:
        pix = fitz.Pixmap(page.parent, xref)
        if pix.alpha:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        pix.save(str(asset))
        return True
    except Exception:
        return False


def render_visual(page: fitz.Page, b_start: float, asset: Path) -> None:
    cutoff = part_b_cutoff(page, b_start)
    # Vector charts have no image xref. Render only the lower Part B content,
    # excluding the compiler header and page footer/watermark.
    clip = fitz.Rect(32, cutoff, page.rect.width - 32, page.rect.height - 28)
    if clip.y1 <= clip.y0 + 10:
        clip = fitz.Rect(32, b_start, page.rect.width - 32, page.rect.height - 28)
    pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), clip=clip, alpha=False)
    pix.save(str(asset))


def make_asset(page: fitz.Page, b_start: float, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not embedded_visual(page, b_start, path):
        render_visual(page, b_start, path)
    return f"exam-assets/{path.name}"


def parse_exam_pdf(path: Path, exam_type: str) -> list[dict[str, Any]]:
    doc = fitz.open(path)
    first_year = 2005 if exam_type == "e1" else 2010
    records: list[dict[str, Any]] = []
    for page_index in range(1, len(doc)):
        page = doc[page_index]
        raw = page.get_text("text")
        year = year_from(raw, first_year + page_index - 1)
        parts = split_parts(raw)
        # Locate Part B for reliable visual extraction.
        m = re.search(r"\bPart\s*B\b", raw, re.I)
        b_start = 0.0
        if m:
            for block in page.get_text("blocks"):
                if re.search(r"\bPart\s*B\b", block[4], re.I):
                    b_start = block[1]
                    break
        for letter, section_name in (("A", "small"), ("B", "big")):
            directions = section_text(parts[letter])
            if not directions:
                continue
            eid = f"{exam_type}-{year}-{'a' if letter == 'A' else 'b'}"
            image = None
            if section_name == "big":
                image = make_asset(page, b_start, ASSET_DIR / f"{eid}.png")
            rec: dict[str, Any] = {
                "id": eid,
                "examType": exam_type,
                "year": year,
                "section": section_name,
                "essayType": "small" if section_name == "small" else essay_type(directions),
                "directions": directions,
                "prompt": directions,
                "requirements": requirements(directions),
                "image": image,
                "modelEssay": None,
                "sources": [{"file": path.name, "page": page_index + 1, "kind": "prompt"}],
            }
            records.append(rec)
    doc.close()
    return records


def sentence_list(text: str) -> list[str]:
    """按英文终止符拆句，同时避免把常见缩写中的句点误作段尾。"""
    protected = re.sub(r"\b(Mr|Mrs|Ms|Dr|Prof)\.", lambda m: m.group(1) + "<DOT>", text)
    parts = [s.replace("<DOT>", ".").strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'])", protected)]
    return [s for s in parts if s]


def paragraph_modules(exam_type: str, section: str, paragraph_count: int) -> list[list[str]]:
    if section == "small":
        base = [["small-purpose"], ["small-details", "small-support"], ["small-politeness", "small-format"]]
    elif exam_type == "e2":
        base = [["chart-introduction", "chart-data"], ["chart-reasons", "chart-advice"], ["chart-outlook"]]
    else:
        base = [["picture-scene", "picture-theme"], ["picture-argument"], ["picture-advice", "picture-outlook"]]
    if paragraph_count <= len(base):
        return base[:paragraph_count]
    return base + [base[-1] for _ in range(paragraph_count - len(base))]


def model_from_page(page: fitz.Page, exam_type: str, section: str) -> dict[str, Any] | None:
    # 使用坐标排序后的文本块，避免 PDF 内部对象写入顺序与页面阅读顺序不同。
    page_text = "\n".join(block[4] for block in page.get_text("blocks", sort=True))
    lines = clean_lines(page_text)
    if not lines:
        return None
    # 范文从最后一条 ANSWER SHEET/分值说明之后开始；方向文本不进入范文。
    start = -1
    for i, line in enumerate(lines):
        if re.search(r"\(\s*\d+\s*points?\s*\)|ANSWER\s*SHEET", line, re.I):
            start = i + 1
    if start < 0:
        return None
    body = [x.strip() for x in lines[start:] if x.strip() and not re.fullmatch(r"\d+", x)]
    if not body:
        return None
    sentences = sentence_list(" ".join(body))
    if not sentences:
        return None

    # PDF 文本层经常丢失段落空行。真题范文均采用三段式，故按句子数确定性地
    # 切为三段（不足三句时保留实际段数），不借助 AI，也不改写原文。
    paragraph_count = min(3, len(sentences))
    cuts = [round(i * len(sentences) / paragraph_count) for i in range(paragraph_count + 1)]
    module_groups = paragraph_modules(exam_type, section, paragraph_count)
    paragraphs: list[dict[str, Any]] = []
    sentence_records: list[dict[str, Any]] = []
    for i in range(paragraph_count):
        current = sentences[cuts[i]:cuts[i + 1]]
        modules = module_groups[i]
        records = [{"text": sentence, "modules": modules} for sentence in current]
        paragraphs.append({"text": " ".join(current), "sentences": records, "modules": modules})
        sentence_records.extend(records)
    return {"paragraphs": paragraphs, "sentences": sentence_records}


def load_models(path: Path, exam_type: str) -> dict[tuple[int, str], dict[str, Any]]:
    doc = fitz.open(path)
    result: dict[tuple[int, str], dict[str, Any]] = {}
    for i, page in enumerate(doc):
        year = 2010 + i // 2
        section = "small" if i % 2 == 0 else "big"
        model = model_from_page(page, exam_type, section)
        if model:
            result[(year, section)] = model
    doc.close()
    return result


def main() -> None:
    global ROOT, OUT_JSON, ASSET_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args()
    ROOT = args.root.resolve()
    OUT_JSON = ROOT / "knowledge" / "exams.json"
    ASSET_DIR = ROOT / "exam-assets"
    for key, path in SOURCES.items():
        if not path.exists():
            raise FileNotFoundError(f"缺少源 PDF: {path}")
    records = parse_exam_pdf(SOURCES["e1"], "e1") + parse_exam_pdf(SOURCES["e2"], "e2")
    models = {"e1": load_models(SOURCES["h1"], "e1"), "e2": load_models(SOURCES["h2"], "e2")}
    for rec in records:
        model = models[rec["examType"]].get((rec["year"], rec["section"]))
        if model:
            rec["modelEssay"] = model
            rec["sources"].append({
                "file": SOURCES["h1" if rec["examType"] == "e1" else "h2"].name,
                "page": 1 + (rec["year"] - 2010) * 2 + (0 if rec["section"] == "small" else 1),
                "kind": "modelEssay",
            })
    # Stable examType+year+section de-duplication.
    unique: dict[str, dict[str, Any]] = {}
    for rec in records:
        unique.setdefault(rec["id"], rec)
    records = sorted(unique.values(), key=lambda r: (r["examType"], r["year"], r["section"]))
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({"version": 1, "count": len(records), "exams": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"导入完成: {OUT_JSON}")
    print(f"题目: {len(records)}; 大作文资产: {sum(bool(r['image']) for r in records)}; 范文: {sum(bool(r['modelEssay']) for r in records)}")


if __name__ == "__main__":
    main()
