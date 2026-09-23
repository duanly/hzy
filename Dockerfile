# 衡之娱 / 跑胡子 —— 生产镜像
#
# 两段：bun 打前端，node 跑服务端。
# 服务端**没有任何运行时 npm 依赖**（只 import node: 内置模块和仓库里的 .ts 源码，
# 引擎也是按相对路径引进去的），所以运行层不用装 node_modules，镜像就这么大点。
# TypeScript 不预编译，照开发时那样用 node --experimental-strip-types 直接跑 .ts —— 
# 跟 `npm start` 完全同一条路，线上线下不会出现"只有打包后才复现"的怪事。

# ---------- 1) 前端 ----------
FROM oven/bun:1-alpine AS web
WORKDIR /src
# **不跑 bun install** —— 这个仓库根本没有 node_modules：
# react / react-dom / scheduler 是直接 vendor 在 web/vendor 里的，
# 靠 web/tsconfig.json 的 paths 解析。装一遍反而可能让 bun 优先走 node_modules，
# 打出来的包跟本地 `npm run build` 的不是同一份。
# 引擎也不用装，web 是按相对路径 import 它的源码。
# server/src 也要：web 里 Login.tsx 引了 server/src/badwords.ts，
# net.ts 引了 server/src/protocol.ts —— 少拷这一份，bun 会报 Could not resolve。
COPY packages ./packages
COPY server ./server
COPY web ./web
RUN cd web \
 && bun build src/main.tsx --outdir dist --target browser --production \
 && cp -r public/* dist/

# ---------- 2) 运行时 ----------
FROM node:22-alpine
# node:sqlite（DatabaseSync）和 --experimental-strip-types 都是 22.x 自带的，
# 这个大版本**别随手往上跳** —— 跳之前先把两套测试跑一遍。
RUN apk add --no-cache tini tzdata
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/paohuzi.db \
    VOICE_DIR=/data/voice \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY package.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY server/package.json ./server/
COPY server/src ./server/src
COPY --from=web /src/web/dist ./web/dist
# 数据（牌局库 + 后台传的语音包）全在 /data，挂出去才不会跟着镜像一起没
RUN mkdir -p /data/voice \
 && addgroup -S phz && adduser -S -G phz phz \
 && chown -R phz:phz /app /data
USER phz
VOLUME ["/data"]
EXPOSE 8787
# 服务端自带 /api/health，顺便报一下开着几间房
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini 收养僵尸进程，也让 docker stop 的 SIGTERM 真的传到 node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
