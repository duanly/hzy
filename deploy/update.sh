#!/usr/bin/env bash
# 更新已经装好的服务端：把新包解上去、重启服务
#   sudo bash update.sh paohuzi.tar.gz
set -euo pipefail
PKG="${1:-paohuzi.tar.gz}"
DIR="${DIR:-/opt/paohuzi}"
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }
systemctl stop paohuzi
# server/data 是数据库，绝对不覆盖（包里本来也没有）
tar -xzf "$PKG" -C "$DIR" --strip-components=1
systemctl start paohuzi
sleep 1; systemctl --no-pager -l status paohuzi | head -8
