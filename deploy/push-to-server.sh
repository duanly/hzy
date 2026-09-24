#!/usr/bin/env bash
#
# 把当前提交的代码打包送到服务器上构建并起起来 —— 全程不碰 GitHub。
#
# 什么时候用：本地或服务器连不上 GitHub（CI 出不了镜像、服务器也 pull 不动）的时候。
# 正常情况还是走 CI：push → Actions 构建并推 GHCR → 服务器 docker compose pull。
#
# 用法：
#   deploy/push-to-server.sh root@1.2.3.4           # 默认部署目录 /opt/hzy
#   deploy/push-to-server.sh root@1.2.3.4 /opt/hzy
#
# 为什么是"送源码"而不是"送镜像"：Mac 是 arm64、服务器是 x86，
# 本地 docker build 出来的镜像搬过去跑不了（或者要靠模拟，又慢又出怪事）。
# 所以传的是源码，在服务器上构建。

set -euo pipefail

HOST="${1:-}"
DIR="${2:-/opt/hzy}"
IMAGE="ghcr.io/duanly/hzy:latest"     # 跟 docker-compose.yml 里写的保持一致，否则 compose 不会用这个镜像

if [ -z "$HOST" ]; then
  echo "用法: $0 user@host [部署目录，默认 /opt/hzy]" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# git archive 打的是 **HEAD**，没提交的改动不会带过去 —— 先说清楚，免得改了半天传的还是旧的
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  工作区有没提交的改动，它们**不会**被打包（git archive 只取 HEAD）。"
  git status --short
  read -r -p "还是继续？[y/N] " a; [ "$a" = y ] || exit 1
fi

REV="$(git rev-parse --short HEAD)"
TGZ="/tmp/hzy-$REV.tgz"
echo "==> 打包 $REV"
git archive --format=tar.gz -o "$TGZ" HEAD
echo "    $TGZ  ($(du -h "$TGZ" | cut -f1))"

echo "==> 传到 $HOST"
scp -q "$TGZ" "$HOST:/tmp/"

echo "==> 在服务器上构建并起起来（第一次要几分钟）"
ssh "$HOST" bash -s -- "$REV" "$DIR" "$IMAGE" <<'REMOTE'
set -euo pipefail
REV="$1"; DIR="$2"; IMAGE="$3"
SRC="/opt/hzy-src"

rm -rf "$SRC"; mkdir -p "$SRC"
tar xzf "/tmp/hzy-$REV.tgz" -C "$SRC"
cd "$SRC"

echo "--- docker build ---"
docker build -t "$IMAGE" .

echo "--- 起之前先自己验一遍（跟 CI 冒烟那一步查的是同样几样） ---"
docker rm -f hzy-check >/dev/null 2>&1 || true
docker run -d --name hzy-check -p 18999:8787 "$IMAGE" >/dev/null
ok=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18999/api/health >/tmp/h.json 2>/dev/null; then ok=1; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' hzy-check)" != "true" ]; then
    echo "!! 容器起不来，日志："; docker logs hzy-check; docker rm -f hzy-check >/dev/null; exit 1
  fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "!! 健康检查一直不通"; docker logs hzy-check; docker rm -f hzy-check >/dev/null; exit 1; }
echo "    /api/health  $(cat /tmp/h.json)"
curl -fsS -o /dev/null http://127.0.0.1:18999/ && echo "    首页        取得到" \
  || { echo "!! 首页取不到，web/dist 八成没进镜像"; docker rm -f hzy-check >/dev/null; exit 1; }
docker exec hzy-check ls packages | tr '\n' ' ' | sed 's/^/    packages    /'; echo
docker exec hzy-check ffmpeg -version >/dev/null 2>&1 \
  && echo "    ffmpeg      在（报牌声会存 mp3）" \
  || echo "    ffmpeg      不在 —— 报牌声会按 WAV 存，体积大八倍"
docker rm -f hzy-check >/dev/null

echo "--- 换上去 ---"
cd "$DIR"
docker compose up -d
sleep 3
docker compose ps
REMOTE

echo
echo "✅ 好了。注意：以后再 docker compose pull 会把这个本地构建的镜像换成 registry 上的，"
echo "   CI 还没绿之前别拉 —— 要更新就再跑一次这个脚本。"
