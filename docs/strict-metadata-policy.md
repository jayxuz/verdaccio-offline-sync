# 离线标签与发布时间严格保留模式

适用范围：Verdaccio 6.2.4，使用本仓库同一次构建的 offline-storage 与 metadata-healer。旧默认 `local-latest` 保持兼容；严格交付应显式选择 `metadataPolicy: preserve`。包版本号不代表包含本次修复，必须按源码提交与构建校验值交付。

## 必须配置

以下路径为容器内示例。挂载由操作者显式设置；包缓存与派生状态分别使用独立目录。环境变量占位符需在部署前由操作者替换，Verdaccio 不保证自动展开。

```yaml
storage: /verdaccio/storage
uplinks: {}
packages:
  '**':
    access: $all
    publish: $authenticated
store:
  '@jayxuz/verdaccio-offline-storage':
    offline: true
    metadataPolicy: preserve
    verifyChecksum: true
    readCache:
      stateDirectory: /verdaccio/read-cache-state
      metadataMaxBytes: 16777216
      metadataMaxEntries: 64
      hashMaxEntries: 2048
      persistentMaxBytes: 67108864
      persistentMaxEntries: 4096
      maxConcurrentRebuilds: 2
      maxQueuedRebuilds: 32
middlewares:
  metadata-healer:
    enabled: true
    enableImportUI: true
    metadataPolicy: preserve
    autoUpdateLatest: false
    autoSaveMetadata: false
    syncConcurrency: 1
```

两个 `metadataPolicy` 必须匹配。保留模式要求 `offline: true`，并由 healer 的 middleware 注册最终响应适配器；仅配置 `filters` 或仅用标准 storage 不能满足要求。此配置无需 filters，也不需要注册全库预热。不要增加 `readCache.warmup` 全库列表；需要时仅按明确的小范围包名或 lockfile 预热。

读取 `/_/healer/cache/performance` 确认 `metadataPolicy` 为 `preserve`，后端为 `sqlite`，并检查 `stateError`。Node 缺少 SQLite 或状态目录不可写时会退回内存，交付要求持久缓存时应视为验收未通过。Verdaccio 可能忽略加载失败的插件，因此不能只依据进程启动成功判定配置生效；还须检查实际 HTTP 标签及性能端点。

## 语义

- 磁盘已有的合法 `latest` 即使低于本地最高版本也保留；其他标签及预发布标签同样保留。
- 指向未通过本地制品检查、或未包含在本次响应 versions 中的标签会从响应中移除。不会给它换一个目标版本，也不会补 `latest`。
- 原标签为空、新包、仅由 tgz 重建的最小 metadata，保持空标签。未提供的来源发布时间、created、modified 均不推测。已有来源时间保留。
- sidecar 与目标合并保留目标独有版本。标签、时间同名冲突由目标已有值优先；来源提供的新标签和有效时间可补入。v1、v2 均执行这条合并规则。
- 导入重建会补安装字段、下载地址、SHA1 与 SHA512；不会执行包脚本。严格模式关闭 filter 的隐式异步保存，避免请求触发语义漂移。
- 最终响应适配器在 Verdaccio 自身 normalizeDistTags 之后，从同一个经过校验的 readCache 读取原标签和时间，覆盖其合成值；完整和 npm install-v1 响应都适用。

## 缓存与迁移

策略进入内存管理器身份、metadata mode 及 worker 配置；存储适配器、响应策略方法和合并实现进入运行时指纹。严格模式不会命中旧默认模式生成的 metadata。预热 worker 也遵循相同策略。策略切换不修改原始缓存文件，无须清空用户包缓存或全库预热。独立 SQLite 索引可自然失效重建。

切换严格模式可能使 `npm install package` 在缺少 latest 时无法确定默认版本。这是原始标签缺失的真实状态；指定已验证的版本或导入可信的来源标签。不要为通过安装而自动选择最高版本。

## 回归方式与边界

先编译三个插件，再在仓库根目录运行：

```sh
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 packages/*/test/*.test.ts
```

`strict-metadata-policy.test.ts` 用真实本地 tgz 和真实 Verdaccio 6.2.4 回环 HTTP 验证：非最高 latest、私有标签、预发布标签、空标签、缺失制品标签过滤、模式隔离、metadata 更新失效、worker 预热、内存命中、SQLite 跨进程命中、新包/五个最小 metadata 重建、全跳过重复 v1 导入及重启。下载校验 SHA1/SHA512，安装字段只解析不执行。`mirror-core.test.ts` 另覆盖 v2 sidecar 标签/时间与零制品导入。

真实 HTTP 测试需要本地安装 Verdaccio 6.2.4；没有该依赖会明确 skipped，应由交付验收补齐。这里的局部真实 HTTP 回归不代替交付镜像在目标 Node 版本上的完整 1174 版本验收。未执行生产部署、导入或基线推进。
