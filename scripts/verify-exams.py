#!/usr/bin/env python3
"""Validate generated offline exam data and picture assets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

EXPECTED = {"e1": 42, "e2": 32}
YEARS = {"e1": range(2005, 2026), "e2": range(2010, 2026)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = ap.parse_args()
    root = args.root.resolve()
    path = root / "knowledge" / "exams.json"
    if not path.exists():
        print(f"FAIL missing {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))
    exams = data.get("exams")
    errors: list[str] = []
    if not isinstance(exams, list):
        errors.append("exams must be an array")
        exams = []
    ids = [x.get("id") for x in exams if isinstance(x, dict)]
    if len(ids) != len(set(ids)):
        errors.append("duplicate ids")
    if len(exams) != 74:
        errors.append(f"expected 74 exams, got {len(exams)}")
    for exam_type, expected in EXPECTED.items():
        rows = [x for x in exams if x.get("examType") == exam_type]
        if len(rows) != expected:
            errors.append(f"{exam_type}: expected {expected}, got {len(rows)}")
        for year in YEARS[exam_type]:
            for section in ("small", "big"):
                key = f"{exam_type}-{year}-{'a' if section == 'small' else 'b'}"
                row = next((x for x in rows if x.get("id") == key), None)
                if not row:
                    errors.append(f"missing {key}")
                    continue
                for field in ("id", "examType", "year", "section", "essayType", "directions", "prompt", "requirements", "sources"):
                    if field not in row:
                        errors.append(f"{key}: missing {field}")
                if section == "big":
                    image = row.get("image")
                    if not image:
                        errors.append(f"{key}: missing big image")
                    elif not (root / image).exists():
                        errors.append(f"{key}: asset not found {image}")
    model_count = sum(bool(x.get("modelEssay")) for x in exams)
    expected_models = 60
    if model_count != expected_models:
        errors.append(f"expected {expected_models} model essays, got {model_count}")
    missing_models = [x.get("id") for x in exams if not x.get("modelEssay")]
    print(f"题目总数: {len(exams)} (e1={sum(x.get('examType') == 'e1' for x in exams)}, e2={sum(x.get('examType') == 'e2' for x in exams)})")
    print(f"大作文题图: {sum(bool(x.get('image')) for x in exams if x.get('section') == 'big')}/37")
    print(f"范文: {model_count}/60")
    print(f"无范文: {', '.join(missing_models) if missing_models else '无'}")
    if errors:
        print("验证失败:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("验证通过: 计数、ID、字段、题图路径和范文数量均符合目标")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
