#!/bin/sh
# 一键启动服务端（含已打包的 H5）。Node >= 22.5
#   ./start.sh            前台跑，屏幕上能看到日志
#   PORT=9000 ./start.sh  换端口
# 日志同时写到 server/data/paohuzi.log（一直追加），出错了回头查：
#   tail -n 200 server/data/paohuzi.log
#   grep -nE '出错|兜底|Error' server/data/paohuzi.log | tail -40
cd "$(dirname "$0")"
export PORT="${PORT:-8787}"
mkdir -p server/data
LOG="${LOG:-server/data/paohuzi.log}"
echo "==== 启动 $(date '+%F %T') 端口 $PORT ====" >> "$LOG"
# 屏幕上照样看得见，同时落一份到文件（stderr 也一起收进来）
node --experimental-strip-types server/src/index.ts 2>&1 | tee -a "$LOG"
