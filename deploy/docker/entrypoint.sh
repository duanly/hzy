#!/bin/sh
# 容器以 root 进来，把 /data 的属主摆平之后降权跑 —— 然后才轮到真正的命令。
#
# 为什么非得在这儿做：/data 正常都是 bind mount（compose 里的 ./data:/data）。
# 宿主机那个目录是 Docker 建的，属主 root；挂上来就把镜像里的 /data 整个盖掉，
# 构建时那句 chown 一点用都没有。于是 node 以 phz 的身份打不开 /data/paohuzi.db，
# sqlite 报 SQLITE_CANTOPEN(14) unable to open database file，进程当场退出。
# 每次启动重做一遍，宿主机目录是什么属主都不怕，用户也不用去 chown。
set -e

mkdir -p /data /data/voice

if [ "$(id -u)" = "0" ]; then
  # -R 是必要的：老部署迁过来时 /data 里可能已经堆着 root 建的库和语音包
  chown -R phz:phz /data 2>/dev/null || true
  exec su-exec phz "$@"
fi

# 已经不是 root 了（比如 compose 里写了 user:）：那就照原样跑，属主的事由外面负责
exec "$@"
