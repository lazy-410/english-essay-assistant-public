#!/usr/bin/env python3
"""自动启动真实软件并采集使用说明截图。"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image
from playwright.sync_api import Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "public" / "manual-assets"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
START_PORT = 17682
VIEWPORT = {"width": 1440, "height": 960}
EXAM_ID = "e1-2023-b"
EXPECTED_FILES = [
    "01-start.png",
    "02-settings.png",
    "03-exam-bank.png",
    "04-exam-detail.png",
    "05-write-with-image.png",
    "06-facts-plan.png",
    "07-skeletons.png",
    "08-result-sources.png",
    "09-kb-dictionary.png",
    "10-kb-modules.png",
    "11-kb-practice.png",
    "12-handwriting.png",
]


def find_free_port(start: int = START_PORT) -> int:
    for port in range(start, 65536):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("没有可用的本地端口")


def node_executable() -> str:
    bundled = ROOT / "runtime" / "node.exe"
    if bundled.is_file():
        return str(bundled)
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("未找到项目 runtime/node.exe 或系统 Node.js")


def wait_for_server(base_url: str, process: subprocess.Popen[Any], timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    health_url = f"{base_url}/api/health"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("本地服务启动失败")
        try:
            with urllib.request.urlopen(health_url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.25)
    raise TimeoutError("等待本地服务启动超时")


def collect_secret_values(value: Any, path: tuple[str, ...] = ()) -> list[str]:
    """仅在内存中收集敏感值，用于确认它们没有进入页面或截图。"""
    secrets: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_lower = str(key).lower().replace("-", "").replace("_", "")
            child_path = (*path, str(key))
            if isinstance(child, str) and any(word in key_lower for word in ("apikey", "secretkey", "token")):
                stripped = child.strip()
                if len(stripped) >= 8:
                    secrets.append(stripped)
            else:
                secrets.extend(collect_secret_values(child, child_path))
    elif isinstance(value, list):
        for child in value:
            secrets.extend(collect_secret_values(child, path))
    return secrets


def load_secrets_for_verification() -> list[str]:
    config_path = ROOT / "config.json"
    if not config_path.is_file():
        return []
    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    return list(dict.fromkeys(collect_secret_values(config)))


def assert_secrets_absent(page: Page, secrets: list[str]) -> None:
    html = page.content()
    for secret in secrets:
        if secret in html:
            raise RuntimeError("页面 DOM 中出现了完整敏感配置值")
    for selector in ("#cfgKey", "#cfgVisionKey", "#cfgBdKey", "#cfgBdSecret"):
        field = page.locator(selector)
        if field.count() and field.input_value():
            raise RuntimeError("设置页敏感输入框不是空值")


def normalize_and_check(path: Path) -> tuple[int, int, int]:
    if not path.is_file():
        raise RuntimeError(f"截图未生成：{path.name}")
    with Image.open(path) as source:
        image = source.convert("RGB")
        width, height = image.size
        image.save(path, format="PNG", optimize=True)
    size = path.stat().st_size
    if width < 600 or height < 260:
        raise RuntimeError(f"截图尺寸异常：{path.name} ({width}x{height})")
    if size < 10_000:
        raise RuntimeError(f"截图文件过小：{path.name} ({size} bytes)")
    return width, height, size


def capture_locator(page: Page, locator: Locator, filename: str, secrets: list[str]) -> None:
    path = OUTPUT_DIR / filename
    locator.wait_for(state="visible", timeout=30_000)
    locator.evaluate("el => window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 70))")
    page.wait_for_timeout(250)
    assert_secrets_absent(page, secrets)
    locator.screenshot(path=str(path), animations="disabled")
    normalize_and_check(path)
    print(f"captured {filename}")


def capture_viewport(page: Page, filename: str, secrets: list[str], focus: Locator | None = None) -> None:
    path = OUTPUT_DIR / filename
    if focus is None:
        page.evaluate("window.scrollTo(0, 0)")
    else:
        focus.wait_for(state="visible", timeout=30_000)
        focus.evaluate("el => window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 70))")
    page.wait_for_timeout(300)
    assert_secrets_absent(page, secrets)
    page.screenshot(path=str(path), full_page=False, animations="disabled")
    normalize_and_check(path)
    print(f"captured {filename}")


def click_tab(page: Page, view: str) -> None:
    tab = page.locator(f'nav.tabs button[data-view="{view}"]')
    tab.click()
    page.locator(f"#view-{view}").wait_for(state="visible")


def wait_for_success_box(page: Page, container: str, label: str, secrets: list[str], timeout: int) -> None:
    page.wait_for_function(
        """selector => {
            const node = document.querySelector(selector);
            return Boolean(node?.querySelector('.ok-box') || node?.querySelector('.err-box'));
        }        """,
        arg=container,
        timeout=timeout,
    )

    if page.locator(f"{container} .err-box").count():
        message = page.locator(f"{container} .err-box").inner_text()
        for secret in secrets:
            message = message.replace(secret, "[REDACTED]")
        print(f"{label} failed: {message}")
        raise RuntimeError(f"{label}连通性测试失败")
    print(f"{label} passed")


def wait_for_image(image: Locator, timeout: int = 30_000) -> None:
    image.wait_for(state="visible", timeout=timeout)
    image.evaluate(
        """(img, timeoutMs) => new Promise((resolve, reject) => {
            if (img.complete && img.naturalWidth > 0) return resolve();
            const timer = setTimeout(() => reject(new Error('image timeout')), timeoutMs);
            img.addEventListener('load', () => { clearTimeout(timer); resolve(); }, {once: true});
            img.addEventListener('error', () => { clearTimeout(timer); reject(new Error('image error')); }, {once: true});
        })""",
        timeout,
    )


def set_compose_details(page: Page, open_terms: list[str]) -> None:
    page.locator("#steps details.step").evaluate_all(
        """(items, terms) => {
            for (const item of items) {
                const title = item.querySelector(':scope > summary')?.textContent || '';
                item.open = terms.some(term => title.includes(term));
            }
        }""",
        open_terms,
    )
    page.wait_for_timeout(200)


def detail_with_title(page: Page, title: str) -> Locator:
    details = page.locator("#steps details.step")
    for index in range(details.count()):
        item = details.nth(index)
        summary = item.locator(":scope > summary").inner_text()
        if title in summary:
            return item
    raise RuntimeError(f"未找到成文步骤：{title}")


def run_real_compose(page: Page) -> None:
    for attempt in range(2):
        page.locator("#btnCompose").click()
        try:
            page.wait_for_function(
                """() => Boolean(document.querySelector('#result > .card')) ||
                    Boolean(document.querySelector('#composeErr .err-box'))""",
                timeout=420_000,
            )
        except PlaywrightTimeoutError:
            if attempt == 0:
                page.reload(wait_until="networkidle")
                raise RuntimeError("真实成文请求超时，页面状态无法安全恢复")
            raise RuntimeError("真实成文请求超时")
        if page.locator("#result > .card").count():
            return
        if attempt == 0:
            page.locator("#btnCompose").wait_for(state="visible")
            page.wait_for_timeout(800)
            continue
    raise RuntimeError("真实成文请求未成功")


def fill_practice_placeholders(page: Page) -> None:
    values = [
        "traditional Chinese culture",
        "cultural confidence",
        "dragon boat racing",
        "young people",
        "rural development",
        "heritage protection",
        "take practical action",
        "a sustainable future",
    ]
    fields = page.locator("#practiceFills input[data-fill]")
    for index in range(fields.count()):
        fields.nth(index).fill(values[index % len(values)])
    page.wait_for_timeout(300)


def capture_all(page: Page, base_url: str, secrets: list[str]) -> None:
    page.goto(base_url, wait_until="networkidle", timeout=60_000)
    page.locator("#statusText").wait_for(state="visible")
    page.wait_for_function("() => !document.querySelector('#statusText').textContent.includes('检查中')")

    capture_viewport(page, "01-start.png", secrets)

    print("testing configured providers")
    click_tab(page, "set")
    print("settings view opened")
    page.wait_for_function(
        """() => document.querySelector('#cfgKeyMask').textContent.trim().length > 0 ||
            Boolean(document.querySelector('#cfgMsg .err-box'))""",
        timeout=30_000,
    )
    if page.locator("#cfgMsg .err-box").count():
        raise RuntimeError("设置页配置读取失败")
    print("masked settings loaded")
    for selector in ("#cfgKey", "#cfgVisionKey"):
        page.locator(selector).fill("")
    page.locator("#btnTestCfg").click()
    print("waiting for DeepSeek response")
    wait_for_success_box(page, "#cfgMsg", "DeepSeek", secrets, 800_000)
    page.locator("#btnTestVisionCfg").click()
    print("waiting for Qwen vision response")
    wait_for_success_box(page, "#visionCfgMsg", "Qwen vision", secrets, 600_000)
    capture_locator(page, page.locator("#view-set"), "02-settings.png", secrets)

    print("capturing exam bank")
    click_tab(page, "exams")
    page.locator("#examStats .stat").first.wait_for(state="visible", timeout=30_000)
    page.locator("#examKeyword").fill(EXAM_ID)
    page.locator("#btnExamSearch").click()
    page.locator("#examList .exam-item").first.wait_for(state="visible", timeout=30_000)
    capture_viewport(page, "03-exam-bank.png", secrets, page.locator("#view-exams"))

    page.locator("#examList .exam-item").first.click()
    page.locator("#examDetail h2").wait_for(state="visible", timeout=30_000)
    wait_for_image(page.locator("#examDetail img.exam-image"))
    capture_locator(page, page.locator("#examDetail"), "04-exam-detail.png", secrets)

    page.locator("#examDetail [data-exam-practice]").first.click()
    page.locator("#view-write").wait_for(state="visible")
    wait_for_image(page.locator("#preview img"))
    page.locator("#ocrBox .ok-box").wait_for(state="visible", timeout=30_000)
    page.locator("#question").evaluate("el => { el.scrollTop = 0; el.blur(); }")
    capture_locator(page, page.locator("#view-write > .card").first, "05-write-with-image.png", secrets)

    run_real_compose(page)
    page.locator("#result > .card").wait_for(state="visible", timeout=30_000)

    set_compose_details(page, ["题面事实", "内容规划"])
    capture_viewport(page, "06-facts-plan.png", secrets, page.locator("#steps"))

    set_compose_details(page, ["语言骨架"])
    capture_viewport(page, "07-skeletons.png", secrets, detail_with_title(page, "语言骨架"))

    result_card = page.locator("#result > .card")
    source_toggle = result_card.locator('.source-toggle input[type="checkbox"]')
    source_toggle.check()
    result_card.locator(".sourced-sentence").first.wait_for(state="visible")
    capture_viewport(page, "08-result-sources.png", secrets, result_card)

    click_tab(page, "kb")
    page.locator("#kbStats .stat").first.wait_for(state="visible", timeout=30_000)
    page.locator("#kbKeyword").fill("not only")
    page.locator("#btnKbSearch").click()
    try:
        page.locator("#kbList .kb-item").first.wait_for(state="visible", timeout=15_000)
    except PlaywrightTimeoutError:
        page.locator("#kbKeyword").fill("")
        page.locator("#btnKbSearch").click()
        page.locator("#kbList .kb-item").first.wait_for(state="visible", timeout=30_000)
    capture_viewport(page, "09-kb-dictionary.png", secrets, page.locator("#view-kb"))

    page.locator('[data-kb-view="modules"]').click()
    page.locator("#moduleTrack").select_option("picture")
    page.locator("#moduleList .module-card").first.wait_for(state="visible", timeout=30_000)
    module_cards = page.locator("#moduleList .module-card")
    added = 0
    for index in range(min(module_cards.count(), 5)):
        button = module_cards.nth(index).locator(".add-template").first
        if button.count():
            button.click()
            added += 1
        if added >= 4:
            break
    if added < 2:
        raise RuntimeError("模块组装可加入的真实模板不足")
    page.wait_for_function("() => Number(document.querySelector('#practiceCount').textContent) >= 2")
    capture_viewport(page, "10-kb-modules.png", secrets, page.locator("#kb-modules .assembly-layout"))

    page.locator("#btnOpenPractice").click()
    page.locator("#kb-practice").wait_for(state="visible")
    page.locator("#practiceSentences .practice-row").first.wait_for(state="visible", timeout=30_000)
    fill_practice_placeholders(page)
    capture_viewport(page, "11-kb-practice.png", secrets, page.locator("#kb-practice .practice-layout"))

    click_tab(page, "write")
    page.locator("#result button", has_text="生成答题卡排版").click()
    page.locator("#view-hand").wait_for(state="visible")
    page.wait_for_function("() => document.querySelectorAll('#hwFont option').length === 23")
    page.locator("#btnHwCopybookPreset").click()
    page.locator("#hwPreview svg").wait_for(state="visible", timeout=60_000)
    page.wait_for_function("() => document.querySelector('#hwColor').value === 'red' && document.querySelector('#hwSize').value === '18'")
    # 同时展示两种快捷模式、全字体试写、基线微调、行数状态与完整原版答题卡预览顶部。
    capture_viewport(page, "12-handwriting.png", secrets, page.locator("#view-hand"))


def validate_outputs() -> list[tuple[str, int, int, int]]:
    report: list[tuple[str, int, int, int]] = []
    for filename in EXPECTED_FILES:
        width, height, size = normalize_and_check(OUTPUT_DIR / filename)
        report.append((filename, width, height, size))
    return report


def stop_process(process: subprocess.Popen[Any] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for filename in EXPECTED_FILES:
        path = OUTPUT_DIR / filename
        if path.exists():
            path.unlink()

    if not CHROME.is_file():
        raise RuntimeError("未找到指定的本机 Chrome")

    secrets = load_secrets_for_verification()
    port = find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env["EEA_PORT"] = str(port)
    env["EEA_NO_BROWSER"] = "1"

    creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process: subprocess.Popen[Any] | None = None
    try:
        process = subprocess.Popen(
            [node_executable(), str(ROOT / "server.mjs")],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        wait_for_server(base_url, process)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(CHROME),
                headless=True,
                args=[
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-default-apps",
                    "--disable-dev-shm-usage",
                    "--disable-extensions",
                    "--disable-features=Translate,MediaRouter",
                    "--disable-popup-blocking",
                    "--no-first-run",
                ],
            )
            context = browser.new_context(
                viewport=VIEWPORT,
                device_scale_factor=1,
                locale="zh-CN",
                color_scheme="light",
            )
            page = context.new_page()
            page.set_default_timeout(30_000)
            capture_all(page, base_url, secrets)
            assert_secrets_absent(page, secrets)
            context.close()
            browser.close()
    finally:
        stop_process(process)

    report = validate_outputs()
    print(f"exam {EXAM_ID}")
    for filename, width, height, size in report:
        print(f"{filename}\t{width}x{height}\t{size / 1024:.1f} KiB")
    print("secret-check passed: full configured keys absent; settings inputs empty")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(f"capture failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
