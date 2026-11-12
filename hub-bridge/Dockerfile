# 构建上下文是仓库根目录：bridge 直接复用 App 的纯函数（动作库、中文名、别名、单位换算、训练模型），
# 只拷它们用到的目录，不装任何依赖。
#   docker build -f hub-bridge/Dockerfile -t opengym-hub-bridge .
FROM node:22-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY frontend/package.json frontend/package.json
COPY frontend/src/lib frontend/src/lib
COPY frontend/src/exercise-names/zh.js frontend/src/exercise-names/zh.js
COPY watch-app/src/lib watch-app/src/lib
COPY hub-bridge/package.json hub-bridge/package.json
COPY hub-bridge/src hub-bridge/src
# 测试文件不进镜像
RUN find frontend/src/lib watch-app/src/lib -name '*.test.*' -delete \
 && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8787 TOKEN_FILE=/data/token.json
EXPOSE 8787
HEALTHCHECK --interval=5m --timeout=5s --retries=3 CMD wget --spider -q "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "hub-bridge/src/server.js"]
