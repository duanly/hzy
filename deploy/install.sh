#!/usr/bin/env bash
# 跑胡子服务端一键部署（Linux / systemd）
#   sudo PORT=1991 bash install.sh paohuzi.tar.gz
# 特点：
#   - 不碰系统自带的 node，也不动 docker 里跑着的别的服务：需要的话把 Node 22 装到 /opt/node22
#   - 装完是一个 systemd 服务 paohuzi，开机自启、崩了自动重启
set -euo pipefail

PKG="${1:-paohuzi.tar.gz}"
PORT="${PORT:-1991}"
DIR="${DIR:-/opt/paohuzi}"
NODE_DIR="${NODE_DIR:-/opt/node22}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin8888}"
# 报牌声在线合成用的钥匙（阿里云百炼，sk- 开头）。不给也能装，装完在后台
# 「语音包」页那个输入框里补也一样 —— 给了就省一步。
DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}"
SERVICE=paohuzi

[ -f "$PKG" ] || { echo "找不到安装包 $PKG"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "请用 root 运行（sudo bash install.sh ...）"; exit 1; }

echo "==> 1/4 检查 Node（需要 22.5 以上：内置 SQLite + 直跑 TypeScript）"
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; }
NODE=""
if [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
elif command -v node >/dev/null && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "不认识的 CPU 架构 $(uname -m)，请手动装 Node 22"; exit 1 ;;
  esac
  echo "    系统 node 版本不够（$(command -v node >/dev/null && node -v || echo 没装)），装一个独立的 Node 22 到 $NODE_DIR"
  echo "    （只给这个服务用，系统那个 node 和 docker 里的服务都不受影响）"
  V=""
  for BASE in https://mirrors.tuna.tsinghua.edu.cn/nodejs-release https://nodejs.org/dist; do
    V="$(curl -fsSL --max-time 20 "$BASE/index.json" 2>/dev/null | grep -o '"version":"v22\.[0-9.]*"' | head -1 | cut -d'"' -f4 || true)"
    [ -n "$V" ] || continue
    echo "    从 $BASE 下载 $V ..."
    if curl -fsSL --max-time 300 "$BASE/$V/node-$V-linux-$ARCH.tar.xz" -o /tmp/node22.tar.xz; then break; fi
    V=""
  done
  [ -n "$V" ] || { echo "下载 Node 失败，请检查服务器网络（或手动装 Node 22 后重跑）"; exit 1; }
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xJf /tmp/node22.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f /tmp/node22.tar.xz
  NODE="$NODE_DIR/bin/node"
fi
echo "    用这个 node：$NODE（$($NODE -v)）"

echo "==> 2/4 解包到 $DIR"
systemctl stop "$SERVICE" 2>/dev/null || true
mkdir -p "$DIR"
tar -xzf "$PKG" -C "$DIR" --strip-components=1
mkdir -p "$DIR/server/data"

echo "==> 3/4 写 systemd 服务"
cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=PaoHuZi game server
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=DB_FILE=$DIR/server/data/paohuzi.db
Environment=WEB_DIST=$DIR/web/dist
Environment=ADMIN_PASSWORD=$ADMIN_PASSWORD
${DASHSCOPE_API_KEY:+Environment=DASHSCOPE_API_KEY=$DASHSCOPE_API_KEY}
ExecStart=$NODE --experimental-strip-types $DIR/server/src/index.ts
Restart=always
RestartSec=3
StandardOutput=append:/var/log/paohuzi.log
StandardError=append:/var/log/paohuzi.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE

echo "==> 4/4 放行端口 $PORT"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q active; then ufw allow "$PORT"/tcp || true; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp || true; firewall-cmd --reload || true
fi
echo "    云服务器还要在控制台的安全组里放行 $PORT（这一步脚本做不了）"

sleep 2
systemctl --no-pager -l status $SERVICE | head -12 || true
# 公网 IP：先问云厂商的**元数据服务**（在机器内网里，不需要能上外网，最稳），
# 问不到再走外网回声服务，最后才退回网卡地址（那是内网 IP，只能同一内网访问）。
pub_ip() {
  local u
  for u in \
    http://metadata.tencentyun.com/latest/meta-data/public-ipv4 \
    http://100.100.100.200/latest/meta-data/eipv4 \
    http://169.254.169.254/latest/meta-data/public-ipv4 \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip
  do
    ip="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' "$u" 2>/dev/null)" || true
    case "$ip" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) echo "$ip"; return;; esac
  done
  for u in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip; do
    ip="$(curl -fsS --max-time 4 "$u" 2>/dev/null)" || true
    case "$ip" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) echo "$ip"; return;; esac
  done
  hostname -I | awk '{print $1}'
}
IP="$(pub_ip)"
case "$IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
    echo
    echo "注意：没问到公网 IP，下面用的是这台机器的**内网地址**（$IP）——"
    echo "     内网地址只有同一个私有网络里的机器能访问，手机和外面的人打不开。"
    echo "     去云控制台看这台实例的「公网 IP / 弹性 IP」，把地址里的 IP 换成它。" ;;
esac
echo
echo "完成。"
echo "  游戏：   http://$IP:$PORT"
echo "  后台：   http://$IP:$PORT/admin   账号 admin  密码 $ADMIN_PASSWORD"
echo "  日志：   tail -f /var/log/paohuzi.log"
# 报牌声这两件事装完提一句，免得进了后台对着一堆发音人发懵
if [ -z "$DASHSCOPE_API_KEY" ]; then
  echo "  报牌声： 还没配百炼 Key —— 后台「语音包」页填一次即可（微软 / 谷歌那两条在国内出不去）"
fi
command -v ffmpeg >/dev/null 2>&1 || \
  echo "  提示：   这台机器没有 ffmpeg，合成出来会存成 WAV（能放，就是比 mp3 大七八倍）。装上更省流量：apt install -y ffmpeg"
echo "  重启：   systemctl restart $SERVICE"
