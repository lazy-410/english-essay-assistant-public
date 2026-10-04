#!/bin/bash
# 考研英语作文辅助助手 · Linux 启动脚本
# 用法：chmod +x start.sh && ./start.sh

cd "$(dirname "$0")" || exit 1

echo ""
echo "  考研英语作文辅助助手"
echo ""

NODE_BIN=""
if [ -x "./runtime/node" ]; then
  NODE_BIN="./runtime/node"
fi

if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "  [错误] 未找到 Node.js 运行环境。"
  echo ""
  echo "  本软件需要 Node.js 18 或更高版本，例如："
  echo "    Debian / Ubuntu : sudo apt install nodejs npm"
  echo "    Fedora          : sudo dnf install nodejs"
  echo "    Arch            : sudo pacman -S nodejs"
  echo "    或前往 https://nodejs.org 下载"
  echo ""
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "  [错误] 无法确定 Node.js 版本，请重新安装 Node.js 18 或更高版本。"
    exit 1
    ;;
  *)
    if [ "$NODE_MAJOR" -lt 18 ]; then
      echo "  [错误] 当前 Node.js 版本为 $("$NODE_BIN" -v)，本软件需要 18 或更高版本。"
      exit 1
    fi
    ;;
esac

if [ ! -f "config.json" ]; then
  cp "config.example.json" "config.json"
  echo "  已生成 config.json，请在软件「设置」页填写 DeepSeek API Key。"
fi

# 打印 PDF 需要系统中文字体；缺失时给出安装提示，不阻塞启动。
if ! fc-list 2>/dev/null | grep -qiE 'noto.*cjk|wqy|zenhei|microhei|source han'; then
  echo "  [提示] 未检测到中文字体，导出打印 PDF 可能失败。可安装："
  echo "         Debian / Ubuntu : sudo apt install fonts-noto-cjk"
  echo "         Fedora          : sudo dnf install google-noto-sans-cjk-fonts"
  echo "         Arch            : sudo pacman -S noto-fonts-cjk"
  echo ""
fi

echo "  正在启动，浏览器会自动打开；若没有，请手动访问 http://127.0.0.1:7654"
echo "  按 Ctrl+C 停止。"
echo ""

"$NODE_BIN" server.mjs
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "  [错误] 服务异常退出（代码 $STATUS），请查看上方信息。"
fi
