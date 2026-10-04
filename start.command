#!/bin/bash
# 考研英语作文辅助助手 · macOS 启动脚本
# 双击本文件即可启动。若提示「无法打开，因为它来自身份不明的开发者」，
# 请右键点击本文件 → 打开，或在「系统设置 → 隐私与安全性」中点「仍要打开」。

cd "$(dirname "$0")" || exit 1

echo ""
echo "  考研英语作文辅助助手"
echo ""

# 1) 优先使用包内运行时（如果该发行包自带对应平台的运行时）
NODE_BIN=""
if [ -x "./runtime/node" ]; then
  NODE_BIN="./runtime/node"
fi

# 2) 回退到系统安装的 Node.js
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "  [错误] 未找到 Node.js 运行环境。"
  echo ""
  echo "  本软件需要 Node.js 18 或更高版本。安装方式任选一种："
  echo "    1) 前往 https://nodejs.org 下载 macOS 安装包（推荐，双击即可）"
  echo "    2) 若已装 Homebrew，执行：brew install node"
  echo ""
  echo "  安装完成后，重新双击本文件即可。"
  echo ""
  read -r -p "  按回车键关闭…" _
  exit 1
fi

# 3) 检查主版本号是否满足 18+
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "  [错误] 无法确定 Node.js 版本，请重新安装 Node.js 18 或更高版本。"
    read -r -p "  按回车键关闭…" _
    exit 1
    ;;
  *)
    if [ "$NODE_MAJOR" -lt 18 ]; then
      echo "  [错误] 当前 Node.js 版本为 $("$NODE_BIN" -v)，本软件需要 18 或更高版本。"
      echo "  请前往 https://nodejs.org 安装新版后重试。"
      read -r -p "  按回车键关闭…" _
      exit 1
    fi
    ;;
esac

# 4) 首次运行生成配置文件
if [ ! -f "config.json" ]; then
  cp "config.example.json" "config.json"
  echo "  已生成 config.json，请在软件「设置」页填写 DeepSeek API Key。"
fi

echo "  正在启动，浏览器会自动打开；若没有，请手动访问 http://127.0.0.1:7654"
echo "  按 Control+C 停止。"
echo ""

"$NODE_BIN" server.mjs
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "  [错误] 服务异常退出（代码 $STATUS），请查看上方信息。"
  read -r -p "  按回车键关闭…" _
fi
