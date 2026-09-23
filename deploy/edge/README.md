# 边界 Caddy

整台服务器**一份**，只干两件事：签证书、按域名把流量分到各应用自己那层 Caddy。
它不属于任何一个应用 —— 放在这个仓库里只是暂时没别的地方搁。

```
玩家 ──443──► edge-caddy ──┬── conf.d/paohuzi.caddy ──► paohuzi-caddy ──► paohuzi-app (node)
                           └── conf.d/fanly.caddy   ──► fanly 那层     ──► fanly 的后端
                              都走 edge 这个 docker 网，按容器名找
```

## 起它

```bash
mkdir -p /opt/edge && cd /opt/edge
# 把本目录的 docker-compose.yml / Caddyfile / conf.d 拷过来
vi Caddyfile                      # 填邮箱
vi conf.d/paohuzi.caddy           # 填域名
ss -lntp | grep -E ':80|:443'     # 确认没被占
docker compose up -d
docker logs -f edge-caddy         # 看证书签发
```

**先起边界再起应用** —— `edge` 这个网是这边建的，应用那边是 `external`，网不在就起不来。

## 加一个应用

1. 那个应用的 compose 里，把对外那个容器挂到 `edge` 网上：

```yaml
services:
  <对外的那个容器>:
    container_name: <给它个固定名字>
    networks: [<它自己的网>, edge]
networks:
  edge:
    external: true
    name: edge
```

2. 这边 `conf.d/` 丢一个文件，照 `paohuzi.caddy` 抄，改域名和容器名。
3. `docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile`

## 常踩的坑

- **上游写容器名，不是 `127.0.0.1`。** 在 edge-caddy 容器里，`127.0.0.1` 是它自己。
- **WebSocket 要关流超时**（`read_timeout 0` / `write_timeout 0`）。跑胡子一局能打几十分钟，
  不关的话连接被反代掐断，表现是"打着打着卡住"，很难往反代上想。
- **`caddy_data` 别用匿名卷。** 证书在里面，掉了就得重签，Let's Encrypt 有频率限制。
- **域名要先解析到这台机器**，ACME 的 HTTP-01 验证得从公网访问到 80 口。
