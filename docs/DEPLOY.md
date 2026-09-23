# 部署文档

本文档说明如何在一台 Linux 服务器上部署跑胡子（server + web），以及如何让
iOS / Android 壳应用和微信小程序指向该服务。

## 1. 运行环境要求

- **Node.js ≥ 22.5**：服务端使用了 `node:sqlite`（Node 内置 SQLite 模块）和
  `--experimental-strip-types` 直接运行 TypeScript，**零 npm 依赖**，不需要
  `npm install`，不需要联网拉包。
- 无需 npm 注册表访问；`server/` 目录下没有 `node_modules`，也不应该有。

## 2. 环境变量

| 变量名             | 说明                                             | 示例 / 默认值                     |
|--------------------|--------------------------------------------------|------------------------------------|
| `PORT`             | HTTP/WS 监听端口                                  | `3000`                             |
| `DB_PATH`          | SQLite 数据库文件路径                             | `/srv/paohuzi/data/paohuzi.db`     |
| `WEB_DIST`         | 已构建的 web 静态资源目录                          | `/srv/paohuzi/web/dist`            |
| `WX_APPID`         | App（iOS/Android）微信登录用的 AppID              | -                                   |
| `WX_SECRET`        | App 微信登录用的 AppSecret                        | -                                   |
| `WX_MP_APPID`      | 微信小程序 AppID                                  | -                                   |
| `WX_MP_SECRET`     | 微信小程序 AppSecret                              | -                                   |
| `DEV_MOCK_WECHAT`  | 开发模式下跳过真实微信接口，用假数据登录           | `1` 开启 / 不设置则关闭             |

生产环境务必**不要**设置 `DEV_MOCK_WECHAT`。

## 3. 直接运行

```bash
cd /srv/paohuzi
PORT=3000 \
DB_PATH=/srv/paohuzi/data/paohuzi.db \
WEB_DIST=/srv/paohuzi/web/dist \
WX_APPID=xxxx WX_SECRET=xxxx \
WX_MP_APPID=xxxx WX_MP_SECRET=xxxx \
node --experimental-strip-types server/src/index.ts
```

首次运行前确保 `DB_PATH` 所在目录存在（服务不会自动创建父目录）：

```bash
mkdir -p /srv/paohuzi/data
```

## 4. systemd 常驻服务示例

`/etc/systemd/system/paohuzi.service`：

```ini
[Unit]
Description=PaoHuZi Game Server
After=network.target

[Service]
Type=simple
User=paohuzi
WorkingDirectory=/srv/paohuzi
Environment=PORT=3000
Environment=DB_PATH=/srv/paohuzi/data/paohuzi.db
Environment=WEB_DIST=/srv/paohuzi/web/dist
Environment=WX_APPID=xxxx
Environment=WX_SECRET=xxxx
Environment=WX_MP_APPID=xxxx
Environment=WX_MP_SECRET=xxxx
ExecStart=/usr/bin/node --experimental-strip-types server/src/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paohuzi
sudo systemctl status paohuzi
sudo journalctl -u paohuzi -f
```

建议把密钥放到单独的 env 文件里而非直接写进 unit 文件：

```ini
EnvironmentFile=/srv/paohuzi/paohuzi.env
```

`paohuzi.env` 权限设为 `600`，只允许运行用户读取。

## 5. Nginx 反向代理 + HTTPS + WebSocket

示例域名：`paohuzi.yytbank.cn`（可与同服务器上的百家乐站点共存，用不同的
`server_name` / `server` 块即可，互不影响，也可以监听不同端口后由 Nginx
统一做 80/443 分发）。

```nginx
server {
    listen 80;
    server_name paohuzi.yytbank.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name paohuzi.yytbank.cn;

    ssl_certificate     /etc/letsencrypt/live/paohuzi.yytbank.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/paohuzi.yytbank.cn/privkey.pem;

    # 游戏内 WebSocket 连接，务必带上 Upgrade/Connection 头做协议升级
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# 同服务器上的百家乐站点：另开一个 server 块，用自己的域名/证书，
# 两者共用同一台 Nginx 即可，互不冲突。
# server {
#     listen 443 ssl http2;
#     server_name baccarat.yytbank.cn;
#     ...
#     location / { proxy_pass http://127.0.0.1:4000; }
# }
```

获取证书（Let's Encrypt，示例）：

```bash
sudo certbot certonly --nginx -d paohuzi.yytbank.cn
```

## 6. Web 前端构建

`web/dist` 是**预构建产物**，随仓库一起提供，部署时无需再次构建，只要把
`web/dist` 拷贝到服务器并设置 `WEB_DIST` 指向它即可。

如需重新构建（改了 `web/` 源码之后）：

```bash
cd web
bun install   # 或使用其他任意打包工具，只要产出等价的 dist/ 静态文件
bun run build
```

- 项目默认用 [Bun](https://bun.sh/) 构建，也可以换成 Vite/esbuild/webpack
  等任意工具，只要最终产物是一份可静态托管的 `dist/`（HTML + JS + CSS +
  资源文件）。
- 构建产物目录结构应与现有 `web/dist` 保持一致（服务端按固定路径提供静态
  资源）。

## 7. 让客户端指向你的域名

### iOS 壳（`shells/ios/`）

修改 `PaoHuZi/Config.swift`：

```swift
static let webURL: URL = URL(string: "https://paohuzi.yytbank.cn")!
```

改成你的实际域名后，用 Xcode 重新 Archive 打包（详见
`shells/ios/README.md`）。

### Android 壳（`shells/android/`）

修改 `app/build.gradle.kts` 中的默认值，或打包时传参：

```bash
./gradlew assembleRelease -PwebUrl=https://paohuzi.yytbank.cn
```

（详见 `shells/android/README.md`）

### 微信小程序（`miniprogram/`）

1. 修改 `miniprogram/config.js` 里的 `API` / `H5_URL` 为实际域名。
2. 确保该域名已经在小程序后台完成 **业务域名**（`web-view` 用）和
   **request 合法域名** 的配置与校验（详见 `miniprogram/README.md`）。
3. 服务端需要正确配置 `WX_MP_APPID` / `WX_MP_SECRET`，用于
   `/api/auth/wechat`（`source: 'mp'`）换取小程序登录 token。

## 8. 数据备份

`DB_PATH` 指向单一 SQLite 文件，停服后直接复制该文件即可完成备份：

```bash
sudo systemctl stop paohuzi
cp /srv/paohuzi/data/paohuzi.db /backup/paohuzi-$(date +%F).db
sudo systemctl start paohuzi
```

建议配合 crontab 定时任务做每日备份。
