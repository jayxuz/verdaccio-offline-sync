# Verdaccio Offline Sync 通用镜像
# 包含所有插件，通过配置文件区分外网/内网环境
FROM verdaccio/verdaccio:6.2.4@sha256:8b18576ae085baad6d1f12f5bdcc74ec099a1a1bf063bba899d1405412982394

USER root
WORKDIR /tmp/verdaccio-offline-sync

# 使用本地源码构建并安装插件，避免拉取 npm 上的旧版本
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages

RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 10000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 600000 \
  && npm install -g pnpm@10.33.2 \
  && pnpm install --frozen-lockfile \
  && pnpm -r build \
  && PKG_OFFLINE_STORAGE="$(npm pack ./packages/verdaccio-offline-storage)" \
  && PKG_INGEST="$(npm pack ./packages/verdaccio-ingest-middleware)" \
  && PKG_HEALER="$(npm pack ./packages/verdaccio-metadata-healer)" \
  && npm install -g \
    "./${PKG_OFFLINE_STORAGE}" \
    "./${PKG_INGEST}" \
    "./${PKG_HEALER}" \
  && rm -rf /tmp/verdaccio-offline-sync

WORKDIR /verdaccio
USER verdaccio
