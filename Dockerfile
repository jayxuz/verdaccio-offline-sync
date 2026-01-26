# Verdaccio Offline Sync 通用镜像
# 包含所有插件，通过配置文件区分外网/内网环境
FROM verdaccio/verdaccio:6.2.4
USER root
RUN npm install -g \
    @jayxuz/verdaccio-offline-storage \
    verdaccio-ingest-middleware \
    verdaccio-metadata-healer
USER verdaccio
