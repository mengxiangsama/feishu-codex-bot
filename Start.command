#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  echo '需要 Node.js 22 或更新版本。安装后请重新打开。'
  exit 1
fi
if ! node --input-type=module -e 'import.meta.resolve("@larksuiteoapi/node-sdk")' 2>/dev/null; then
  npm ci --ignore-scripts --no-fund --no-audit
fi
echo '飞书 Codex 机器人'
echo '1. 启动桥接'
echo '2. 新建或更新机器人'
echo '3. 检查凭证'
echo '4. 查看已配置的机器人'
echo '回车默认启动。'
read "feishu_bot_choice?请选择 [1–4] "
case "$feishu_bot_choice" in
  ""|1) exec node src/main.mjs start ;;
  2) exec node src/main.mjs setup ;;
  3) exec node src/main.mjs check ;;
  4) exec node src/main.mjs list ;;
  *) echo '请选择 1 到 4。' ;;
esac
