#!/usr/bin/env bash
# 打部署包。在仓库根目录跑：bash deploy/pack.sh
#
# 踩过的坑，都固化在这儿了：
#   · **必须带 web/dist** —— systemd 里 WEB_DIST 指的就是它。漏了的话包解上去前端一点不变，
#     源码更新了、页面还是老样子，查起来极费劲（2026-09-19 栽过一次）。
#   · **绝不能带数据库** —— server/data/*.db* 是线上的账号和牌局，覆盖就没了。
#     同目录下的 voice/（合成好的音包）要带，所以不能整个排除 server/data。
#   · 先 build 再打包，别把上一次的产物当成这一次的。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="dist-deploy/paohuzi-deploy.tar.gz"

echo "==> 1/3 构建前端"
# SKIP_BUILD=1：web/dist 已经是刚构建好的（比如在别的机器上打的包），这一步跳过。
# 跳之前一定确认 dist 比 src 新 —— 拿旧产物打包正是 pack.sh 顶上那条警告说的坑。
if [ "${SKIP_BUILD:-0}" = "1" ]; then echo "    (SKIP_BUILD=1，用现成的 web/dist)"; else npm run build -w web; fi

echo "==> 2/3 打包"
mkdir -p dist-deploy; rm -f "$OUT" "$OUT.md5"
# **白名单**：只装该装的那几样。
# 以前是反过来排除垃圾，可仓库里的垃圾一直在长（旧包、Claude outputs、坏掉的库、
# 还冒出来过一个没名没姓的 5MB gzip 叫 `root`），漏掉一个包就胖一圈，
# 而且这些东西会跟着装到线上去。改成白名单之后，新冒出来的杂物一概进不来。
tar -czf "$OUT" \
  --exclude=node_modules --exclude='*/node_modules' --exclude=.DS_Store \
  --exclude='./server/data/*.db' --exclude='./server/data/*.db-shm' --exclude='./server/data/*.db-wal' \
  --exclude='./server/data/_to_delete' \
  `# 实体牌的参考照（HEIC，8M）：做界面时看的，服务器上用不着` \
  --exclude='./docs/ref' \
  ./package.json ./start.sh ./README.md \
  ./Dockerfile ./.dockerignore ./docker-compose.yml ./.env.example \
  ./deploy ./packages ./server ./web ./assets ./docs ./miniprogram ./shells

echo "==> 3/3 核对"
# 先把清单落到变量里再查 —— 直接 `tar | grep -q` 的话 grep 提前退出会给 tar 一个 SIGPIPE，
# pipefail 下整条管道算失败，好包也会被判成坏包
LIST="$(tar -tzf "$OUT")"
for must in ./web/dist/main.js ./web/dist/styles.css ./web/dist/index.html ./server/src/index.ts; do
  printf '%s\n' "$LIST" | grep -qxF -- "$must" || { echo "!! 包里少了 $must"; exit 1; }
done
if printf '%s\n' "$LIST" | grep -q '\.db$'; then echo "!! 包里混进了数据库，停下"; exit 1; fi
# 语音包（自录的 + 各套方言）跟数据库同住一个目录，容易被 exclude 连坐
V=$(printf '%s\n' "$LIST" | grep -c '^./server/data/voice/.*\.\(m4a\|mp3\|wav\|webm\|ogg\)$' || true)
echo "    语音 $V 条"
[ "$V" -ge 30 ] || { echo "!! 语音只有 $V 条，八成被 exclude 连坐了"; exit 1; }
# 体积兜底：正常就几 M。一旦哪天又混进大文件（旧包、坏库、参考照…），在这儿就该拦住
SZ=$(du -m "$OUT" | cut -f1)
[ "$SZ" -le 20 ] || { echo "!! 包有 ${SZ}M，太大了，八成混进了不该带的东西：\n$(tar -tzvf "$OUT" | sort -k3 -nr | head -10)"; exit 1; }
md5sum "$OUT" | awk '{print $1}' > "$OUT.md5"
echo "    $OUT  $(du -h "$OUT" | cut -f1)  md5 $(cat "$OUT.md5")"
