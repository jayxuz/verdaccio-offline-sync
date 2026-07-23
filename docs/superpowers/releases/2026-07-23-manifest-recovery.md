# Verdaccio Manifest 恢复发布证据

日期：2026-07-23

本文件只保留发布校验摘要。生产 storage、Manifest 原文、迁移原始报告和备份均存放在仓库外，不进入 Git。

## 构建与静态验证

- Node.js：`v24.14.0`
- pnpm：`10.33.2`
- frozen install：通过
- 三个插件包测试：32/32 通过
- 迁移工具测试：19/19 通过
- 测试总数：51/51 通过
- 三个插件包 TypeScript 构建：通过
- `git diff --check`：通过
- 基础镜像：`verdaccio/verdaccio:6.2.4@sha256:8b18576ae085baad6d1f12f5bdcc74ec099a1a1bf063bba899d1405412982394`
- 发布镜像：`jayxuz/verdaccio-offline-sync@sha256:1d75f88fc4cd38007765b7d5998e62fa5e1a722a88c85f426326e056a5926448`

## 存储迁移

- dry-run 扫描：10,478
- dry-run 预计修改：5,842
- 缺 `_attachments`：1,436
- 缺 `_distfiles`：5,574
- 回填 `_distfiles` 条目：721,518
- JSON 解析错误：0
- apply 修改：5,842
- apply 备份：5,842
- apply 文件错误：0
- post-scan 预计修改：0
- post-scan 缺 `_attachments`：0
- post-scan 缺 `_distfiles`：0
- post-scan JSON 解析错误：0

生产备份位于仓库外的 `manifest-repair-20260723` 目录，文件数为 5,842。迁移前配置备份为 `config.yaml.pre-online-role-20260723-2230`。

## 原故障与并发验证

- 隔离 fixture 删除 `_attachments`、`_distfiles` 和目标 tarball 后，安装 `@opentelemetry/sdk-metrics@2.2.0` 成功。
- fixture Manifest 生成目标 attachment 与 distfile，测试容器保持运行，日志无 `uncaught exception` 或 `Cannot set properties`。
- 20 个独立 pnpm store 并发安装：20/20 成功。
- 并发期间 ingest refresh 请求成功返回；最终 Manifest 可解析，attachment、版本和 tarball 均未丢失。
- `sdk-metrics-2.2.0.tgz` SHA-1：`3824133f0d681d778aff0f52b02a87ec6750fc2d`。

## 生产烟雾与回滚

- 在线角色配置已启用 `offline: false`、uplink/proxy 与 ingest，未启用 healer。
- 生产容器：Up，`/-/ping` 成功。
- 使用空 pnpm store 的生产安装：成功。
- 生产日志检查：无崩溃、Manifest 字段异常、权限错误或 HTTP 500。
- 旧镜像 `1.2.7`、原配置和临时测试卷的回滚演练：启动与 ping 成功。
- 旧生产容器和前一版新容器均保留为停止状态，便于有界回退。

部署时必须使用 Windows 原生 bind source（`C:\\...`）。从 WSL 使用 `/mnt/c/...` 创建 bind 会改变 Docker Desktop 的权限映射，不可用于该生产卷。
