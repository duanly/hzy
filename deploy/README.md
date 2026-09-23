# 部署（今天这种：一台 Linux + systemd + HTTP）

```bash
# 服务器上（root）
sudo PORT=1991 ADMIN_PASSWORD=你的密码 bash install.sh paohuzi.tar.gz
```

装完：

- 游戏 `http://paohuzi.yytbank.cn:1991`
- 后台 `http://paohuzi.yytbank.cn:1991/admin`（账号 admin）
- 日志 `tail -f /var/log/paohuzi.log`，重启 `systemctl restart paohuzi`

脚本做了什么：

1. 检查 node：系统的不够 22.5 就把 Node 22 装到 `/opt/node22`，**只给这个服务用** ——
   系统自带的 node 18 不动，docker 里跑着的百家乐更不受影响（它用的是镜像里的运行时）。
2. 解包到 `/opt/paohuzi`（`server/data/` 是数据库目录，更新时不覆盖）。
3. 写 systemd 服务 `paohuzi`：开机自启、崩了自动拉起。
4. 放行端口（ufw / firewalld）。**云服务器的安全组要自己去控制台放行。**

以后更新：`sudo bash update.sh paohuzi.tar.gz`。

## 之后上 docker

这个工程零运行时依赖（服务端只用 node 内置模块），Dockerfile 会很短：
`FROM node:22-alpine` → `COPY . /app` → `CMD ["node","--experimental-strip-types","server/src/index.ts"]`，
数据库目录 `server/data` 挂出来做 volume 就行。
