# Docker 部署

代码放 GitHub，**镜像由 GitHub Actions 构建**推到 GHCR，服务器只负责拉下来跑。
服务器上不用装 bun、不用装 node，也不占 CPU 做构建；回滚就是把 `.env` 里的
`TAG` 改回上一个再 `up -d`。

## 这一套长什么样

```
玩家 ──https──► 前置 Caddy ──http──► 本机 :8080 ──► caddy（本应用）──► app:8787 (node)
                 只管 TLS + 域名分发        │           只管内部路径路由
                                            │
玩家 ──http───────────────────────────────┘   http://<服务器IP>:8080 直连，同一个口
```

- **域名走 HTTPS**：证书由前置 Caddy 自动签、自动续。加这个应用＝往它的 `conf.d/`
  丢一个文件，就是 `deploy/docker/edge.paohuzi.caddy`。
- **IP:端口走 HTTP**：`HTTP_PORT`（默认 8080）是直接开在外面的，局域网、临时调试、
  域名还没解析好的时候都用它。两条路互不跳转。

## 第一次部署

```bash
# 1. 拉仓库（只用到 compose 和两个 Caddyfile，代码本身在镜像里）
git clone https://github.com/duanly/hzy.git /opt/hzy
cd /opt/hzy

# 2. 配置
cp .env.example .env
vi .env            # 默认值就能用；镜像是私有的话先 docker login ghcr.io -u duanly

# 3. 起
docker compose pull
docker compose up -d
docker compose logs -f app      # 会打印后台地址和账号
```

到这儿 `http://<服务器IP>:8080` 就能进了。后台在 `/admin`，账号 `admin`，密码是 `.env` 里的
`ADMIN_PASSWORD`；**没填就是 `admin8888`，先去改掉再说别的。**

```bash
# 4. 挂域名：把 edge.paohuzi.caddy 里的域名和端口改好，丢给前置 Caddy
sudo cp deploy/docker/edge.paohuzi.caddy /etc/caddy/conf.d/paohuzi.caddy
sudo vi /etc/caddy/conf.d/paohuzi.caddy
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

> 前置 Caddy 也跑在 Docker 里的话：`docker exec <前置容器> caddy reload --config /etc/caddy/Caddyfile`。
> 想走容器网不绕本机端口，见 `docker-compose.yml` 末尾那段注释。

## 日常发版

```bash
git push                                   # Actions 自动构建、推 GHCR
# 服务器上：
cd /opt/hzy && docker compose pull && docker compose up -d
```

镜像 tag 有四种：`latest`（main 分支）、`main`、`sha-xxxxxxx`（每次提交）、`v1.2.3`（打了
tag 的话）。生产上**建议在 `.env` 里钉 `sha-` 或 `v`**，别用 `latest` —— 出事的时候
"退回上一个"才有得退。

```bash
# 回滚
sed -i 's/^TAG=.*/TAG=sha-1a2b3c4/' .env && docker compose up -d
```

## 数据在哪

全在 `./data`（容器里是 `/data`）：

- `data/paohuzi.db` —— 账号、积分、战绩、回放。**要备份的就是它。**
- `data/voice/` —— 后台传上来的自录音包。

```bash
# 备份（sqlite 在线备份，不用停服）
docker compose exec app node -e "
const {DatabaseSync}=require('node:sqlite');
new DatabaseSync('/data/paohuzi.db').exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\")"
```

镜像里**不含** `data/`，所以重新拉镜像不会动到数据。

## 环境变量

`.env.example` 里都有注释。几个要紧的：

| 变量 | 说明 |
|---|---|
| `IMAGE` | 镜像名，默认 `ghcr.io/duanly/hzy`（跟仓库同名） |
| `TAG` | 镜像版本。生产别留 `latest` |
| `HTTP_PORT` | 对外的明文端口，默认 8080 |
| `ADMIN_PASSWORD` | 后台 admin 的初始密码。**留空就是 `admin8888`**，上线前务必改。只在第一次建账号时生效，之后改这里没用，要去后台改 |
| `WX_*` | 微信登录，不用就整段留空 |
| `DASHSCOPE_*` / `EDGE_TTS_*` | 在线合成报牌声，不用就留空（退回手机自己念） |

## 排查

```bash
docker compose ps                     # 健康检查过了没
docker compose logs -f app            # 服务端日志；卡住会打 [卡住] 开头的诊断行
docker compose exec app node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(console.log)"
```

**牌桌连上就掉 / 一直转圈**：多半是哪一层把 WebSocket 掐了。两个 Caddyfile 里都给
`/ws` 设了 `read_timeout 0 / write_timeout 0`，前置那层要是你自己写的，记得补上 ——
一局牌能打半小时，默认的流超时扛不住。

**房间详情里 IP 全是内网地址**：前置 Caddy 没把 `X-Forwarded-For` 带过来，或者应用这层
没认。应用这层已经写了 `trusted_proxies static private_ranges`；前置那层用 Caddy 的
`reverse_proxy` 默认就会带。

## 本地跑一把（不进 GHCR）

```bash
docker compose build          # 需要把 compose 里的 image 换成 build: .
docker build -t paohuzi:dev . && docker run --rm -p 8787:8787 -v "$PWD/data:/data" paohuzi:dev
```
