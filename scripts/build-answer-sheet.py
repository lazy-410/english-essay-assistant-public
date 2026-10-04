#!/usr/bin/env python3
r"""从 D:\Dome 原工具构建真实答题卡运行时素材。

开发阶段使用 PyMuPDF 完成两件事：
1. 按原工具完全相同的 clip / A4 target，把原答题卡区域原样放进 A4 页面，
   输出 400 DPI 无损 PNG（网页预览）和 RGB zlib 数据（Node PDF 背景）。
2. 将 D:\Dome\Font 下全部 TTF 逐文件复制到 public/fonts/dome。

运行期只需要 Node，不需要 Python、PyMuPDF 或原始模板 PDF。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DOME = Path(r"D:\Dome")
DEFAULT_SOURCE = DEFAULT_DOME / "assets" / "answer_sheet_template.pdf"
DEFAULT_FONT_SOURCE = DEFAULT_DOME / "Font"

DATA_DIR = ROOT / "assets" / "answer-sheets"
WEB_BG_DIR = ROOT / "public" / "answer-sheet-assets"
FONT_TARGET = ROOT / "public" / "fonts" / "dome"
FONT_MANIFEST = DATA_DIR / "dome-fonts.json"

A4_WIDTH = 595.28
A4_HEIGHT = 841.89
A4_TARGET = (28.0, 30.0, 567.0, 811.0)
BACKGROUND_DPI = 400


@dataclass(frozen=True)
class TemplateSpec:
    key: str
    label: str
    exam: str
    part: str
    source_page: int
    side: str
    clip: tuple[float, float, float, float]


# 与 D:\Dome\answer_sheet_generator.py 完全一致。
TEMPLATES = (
    TemplateSpec("english1_a", "英语一 Part A（小作文）", "英语一", "A", 1, "left", (49.8, 73.7, 543.7, 787.5)),
    TemplateSpec("english1_b", "英语一 Part B（大作文）", "英语一", "B", 1, "right", (645.9, 73.8, 1139.9, 787.3)),
    TemplateSpec("english2_a", "英语二 Part A（小作文）", "英语二", "A", 3, "left", (49.8, 73.5, 543.7, 787.3)),
    TemplateSpec("english2_b", "英语二 Part B（大作文）", "英语二", "B", 3, "right", (645.9, 73.8, 1139.9, 787.3)),
)


def color_is_magenta(color: tuple[float, float, float] | None) -> bool:
    if color is None:
        return False
    red, green, blue = color
    return red > 0.65 and green < 0.25 and blue > 0.25


def extract_writing_lines(page: fitz.Page, clip: fitz.Rect) -> list[dict[str, float]]:
    """逐字复现原工具的作文横线识别逻辑。"""
    candidates: list[dict[str, float]] = []
    for drawing in page.get_drawings():
        if not color_is_magenta(drawing.get("color")):
            continue
        for item in drawing.get("items", []):
            if not item or item[0] != "l":
                continue
            first, second = item[1], item[2]
            if abs(first.y - second.y) > 0.25:
                continue
            start_x = min(first.x, second.x)
            end_x = max(first.x, second.x)
            if end_x - start_x < 300:
                continue
            if start_x < clip.x0 + 20 or end_x > clip.x1 - 15:
                continue
            if first.y < clip.y0 + 50 or first.y > clip.y1 - 20:
                continue
            candidates.append({"baseline": first.y, "startX": start_x, "endX": end_x})

    deduplicated: dict[float, dict[str, float]] = {}
    for line in candidates:
        key = round(line["baseline"], 1)
        old = deduplicated.get(key)
        if old is None or line["endX"] - line["startX"] > old["endX"] - old["startX"]:
            deduplicated[key] = line

    lines = sorted(deduplicated.values(), key=lambda line: line["baseline"])
    if len(lines) < 10:
        raise RuntimeError("无法从原答题卡中识别作文横线")
    return lines


def map_x(value: float, clip: fitz.Rect, target: fitz.Rect) -> float:
    return target.x0 + (value - clip.x0) * target.width / clip.width


def map_y(value: float, clip: fitz.Rect, target: fitz.Rect) -> float:
    return target.y0 + (value - clip.y0) * target.height / clip.height


def map_lines(lines: list[dict[str, float]], clip: fitz.Rect, target: fitz.Rect) -> list[dict[str, float]]:
    return [
        {
            "baseline": round(map_y(line["baseline"], clip, target), 4),
            "startX": round(map_x(line["startX"], clip, target), 4),
            "endX": round(map_x(line["endX"], clip, target), 4),
        }
        for line in lines
    ]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sync_dome_fonts(source_dir: Path) -> list[dict[str, object]]:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"未找到原字体目录：{source_dir}")

    source_files = sorted(source_dir.rglob("*.ttf"), key=lambda path: path.as_posix().lower())
    if not source_files:
        raise RuntimeError(f"{source_dir} 中没有 TTF 字体")

    if FONT_TARGET.exists():
        shutil.rmtree(FONT_TARGET)
    FONT_TARGET.mkdir(parents=True, exist_ok=True)

    manifest: list[dict[str, object]] = []
    for source in source_files:
        relative = source.relative_to(source_dir)
        target = FONT_TARGET / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        source_hash = sha256(source)
        target_hash = sha256(target)
        if source_hash != target_hash or source.stat().st_size != target.stat().st_size:
            raise RuntimeError(f"字体复制校验失败：{relative}")
        manifest.append(
            {
                "relativePath": relative.as_posix(),
                "publicPath": f"fonts/dome/{relative.as_posix()}",
                "bytes": target.stat().st_size,
                "sha256": target_hash,
            }
        )

    FONT_MANIFEST.write_text(
        json.dumps(
            {
                "source": str(source_dir),
                "count": len(manifest),
                "totalBytes": sum(int(item["bytes"]) for item in manifest),
                "fonts": manifest,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return manifest


def build_template(document: fitz.Document, spec: TemplateSpec) -> dict[str, object]:
    source_page = document[spec.source_page]
    clip = fitz.Rect(*spec.clip)
    target = fitz.Rect(*A4_TARGET)
    source_lines = extract_writing_lines(source_page, clip)
    lines = map_lines(source_lines, clip, target)

    output = fitz.open()
    output_page = output.new_page(width=A4_WIDTH, height=A4_HEIGHT)
    output_page.show_pdf_page(target, document, spec.source_page, clip=clip)
    pixmap = output_page.get_pixmap(dpi=BACKGROUND_DPI, colorspace=fitz.csRGB, alpha=False)
    output.close()

    samples = bytes(pixmap.samples)
    expected_samples = pixmap.width * pixmap.height * 3
    if len(samples) != expected_samples:
        raise RuntimeError(f"{spec.key} RGB 数据长度异常：{len(samples)} != {expected_samples}")

    png_bytes = pixmap.tobytes("png")
    # 用 MuPDF 重新解码 PNG，确认网页背景与 PDF 背景像素完全一致。
    decoded = fitz.Pixmap(png_bytes)
    if decoded.width != pixmap.width or decoded.height != pixmap.height or bytes(decoded.samples) != samples:
        raise RuntimeError(f"{spec.key} PNG 与 RGB 背景像素不一致")

    compressed_rgb = zlib.compress(samples, level=9)
    png_path = WEB_BG_DIR / f"{spec.key}.png"
    rgb_path = DATA_DIR / f"{spec.key}.rgb.deflate"
    png_path.write_bytes(png_bytes)
    rgb_path.write_bytes(compressed_rgb)

    gaps = [round(lines[index + 1]["baseline"] - lines[index]["baseline"], 4) for index in range(len(lines) - 1)]
    return {
        "key": spec.key,
        "label": spec.label,
        "exam": spec.exam,
        "part": spec.part,
        "page": {"width": A4_WIDTH, "height": A4_HEIGHT},
        "target": {"x0": target.x0, "y0": target.y0, "x1": target.x1, "y1": target.y1},
        "lines": {
            "count": len(lines),
            "items": lines,
            "minGap": min(gaps),
            "maxGap": max(gaps),
        },
        "background": {
            "url": f"/answer-sheet-assets/{spec.key}.png",
            "png": f"public/answer-sheet-assets/{spec.key}.png",
            "rgbDeflate": f"assets/answer-sheets/{spec.key}.rgb.deflate",
            "width": pixmap.width,
            "height": pixmap.height,
            "dpi": BACKGROUND_DPI,
            "colorSpace": "DeviceRGB",
            "bitsPerComponent": 8,
            "pngBytes": len(png_bytes),
            "rgbDeflateBytes": len(compressed_rgb),
            "pngSha256": hashlib.sha256(png_bytes).hexdigest(),
            "rgbDeflateSha256": hashlib.sha256(compressed_rgb).hexdigest(),
        },
        "source": {
            "template": "D:/Dome/assets/answer_sheet_template.pdf",
            "page": spec.source_page,
            "side": spec.side,
            "clip": list(spec.clip),
            "a4Target": list(A4_TARGET),
        },
    }


def main() -> int:
    dome = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DOME
    source_pdf = dome / "assets" / "answer_sheet_template.pdf"
    font_source = dome / "Font"
    if not source_pdf.is_file():
        raise FileNotFoundError(f"未找到原答题卡：{source_pdf}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WEB_BG_DIR.mkdir(parents=True, exist_ok=True)

    # 清除旧版人工复刻素材和上次构建的背景。
    for pattern in ("*.json", "*.rgb.deflate"):
        for file in DATA_DIR.glob(pattern):
            file.unlink()
    for file in WEB_BG_DIR.glob("*.png"):
        file.unlink()

    font_manifest = sync_dome_fonts(font_source)
    document = fitz.open(source_pdf)
    templates: list[dict[str, object]] = []
    for spec in TEMPLATES:
        item = build_template(document, spec)
        templates.append(item)
        (DATA_DIR / f"{spec.key}.json").write_text(
            json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        bg = item["background"]
        print(
            f"{spec.key}: {item['lines']['count']} 行, {bg['width']}x{bg['height']} @ {bg['dpi']}dpi, "
            f"PNG {bg['pngBytes'] // 1024}KiB, PDF背景 {bg['rgbDeflateBytes'] // 1024}KiB"
        )
    document.close()

    (DATA_DIR / "index.json").write_text(
        json.dumps(
            {
                "source": "D:/Dome/answer_sheet_generator.py",
                "a4Target": list(A4_TARGET),
                "backgroundDpi": BACKGROUND_DPI,
                "templates": [
                    {
                        "key": item["key"],
                        "label": item["label"],
                        "exam": item["exam"],
                        "part": item["part"],
                        "lineCount": item["lines"]["count"],
                        "backgroundUrl": item["background"]["url"],
                    }
                    for item in templates
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    if len(font_manifest) != 21:
        raise RuntimeError(f"Dome 字体应为 21 个，实际 {len(font_manifest)} 个")
    print(
        f"字体同步：{len(font_manifest)} 个 / {sum(int(item['bytes']) for item in font_manifest) / 1024 / 1024:.2f}MiB"
    )
    print("REAL_ANSWER_SHEET_ASSETS_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
