# 离线读取缓存的配置与操作（候选版本）

本功能只缓存可重新计算的读取结果。包目录中的 `package.json` 与 `.tgz` 仍是数据来源，导入验证、库存扫描、制品包验证及最终 HTTP SRI 验收仍执行各自的完整校验。文件身份复用是加速假设，不能替代内容的密码学证明。

## 启用与边界

在 offline storage 插件配置中设置独立的绝对状态目录；该目录必须在包缓存目录之外。未配置 `stateDirectory` 时只启用有界内存缓存。需要运行时内置 `node:sqlite`，不安装第三方数据库或服务；运行时不支持或状态损坏时回退到内存并通过指标报告。

```yaml
store:
  '@jayxuz/verdaccio-offline-storage':
    offline: true
    verifyChecksum: true
    readCache:
      stateDirectory: /var/lib/verdaccio-read-cache
      metadataMaxBytes: 16777216
      metadataMaxEntries: 64
      hashMaxEntries: 2048
      persistentMaxBytes: 67108864
      persistentMaxEntries: 4096
      persistentMaxAgeMs: 86400000
      maxConcurrentRebuilds: 2
      maxQueuedRebuilds: 32
      warmup:
        packages: [typescript, lodash]
        # 或指定已经存在的 npm/pnpm/Yarn lockfile；只提取包名，不执行解析或下载。
        # lockfile: /opt/project/pnpm-lock.yaml
        maxPackages: 32
        bytesPerSecond: 8388608
```

内存 metadata 上限按序列化 UTF-8 字节计，哈希按条数计；它们不是 Node 总 RSS 限额。持久预算为 SQLite 主文件和回滚日志预留空间，逻辑记录只占预算的四分之一，主文件最多占二分之一；状态目录仍建议单独设置文件系统配额。不得把真实缓存挂载为测试可写卷。

状态文件为 `stateDirectory/verdaccio-read-cache-v1/index.sqlite`，新目录权限 0700、新数据库 0600。拒绝不安全的符号链接、缓存内部路径、外来 schema、超预算文件和不一致的共享预算。多个进程共享状态目录时必须使用相同磁盘/条数预算；内存预算是每个存储实例独立计算的。

## 有效性、重启与迁移

每次 metadata 请求仍检查目录、metadata 及所有本地 tgz 的身份（设备、inode、大小、mtime/ctime 纳秒、mode）。写入、替换、增加、删除会失效。读取发生变化时重试一次；持续变化不缓存，也不把旧 JSON 重新贴上新签名。

命名空间绑定存储根身份、Linux boot/PID/mount namespace、运行时与构建代码指纹。相同 namespace 内新 Node 进程可复用持久状态；主机重启、容器重建/更换 namespace、根目录迁移或实现升级会安全地冷启动。不要宣称 Docker 重建后一定有持久缓存收益；可按明确热点重新预热。

记录有独立校验和与最大验证年龄。LRU 触碰不会刷新完整验证时间。过期、损坏或不兼容的记录重新读取和哈希；缓存写失败不删除 `.tgz`，不影响数据源。相同版本不同哈希仍由原有导入协议拒绝。

## 指标与预热

已启用对应中间件时，读取 `/_/ingest/cache/performance` 或 `/_/healer/cache/performance`。指标包括 metadata/hash 命中、失效、淘汰、stat 次数、实际哈希字节、持久命中/写入/事务、排队和预热状态，以及内存/持久占用和限额。接口只返回计数及 namespace 摘要，不返回包目录或包内容；未使用该存储插件时返回未启用状态。

预热默认关闭，只能显式选取热点或现有 lockfile（文件最多 2 MiB、包名数量有界），不会扫描全库、访问上游或运行生命周期脚本。后台线程单并发、独立堆上限 256 MiB，Linux 降低自身线程优先级，按 metadata 与 tgz 的实际读取字节限速。前台请求优先，会抢占后台当前包；指标中的 `preempted` 表示需要在空闲时重试，不能误认为已完成预热。

插件实例提供 `getReadCacheMetrics()`、`warmReadCache(packages, forceRehash?)`、`warmReadCacheFromLockfile(file, forceRehash?)`、`cancelReadCacheWarmup()` 和 `rebuildReadCache()`。这些是进程内运维 API，本次没有新增远程可写管理接口。强制预热跳过已有哈希，取消有 500ms 终止兜底。后台结果携带最初完整验证时的签名和时间，前台再次检查后才接纳。

## 重建和故障处理

健康索引可调用 `rebuildReadCache()` 清空该实例内存及整个共享索引中的派生记录，再正常读取或预热热点；共享目录的其他进程内存不会随之清空，统一强制重验时应先停止其他使用者；这不会修改包缓存或同步基线。数据库损坏并回退时，先停止所有使用该状态目录的进程，然后仅移走该独立派生索引目录，再启动重建。不要在其他进程仍使用数据库时删除它，也不要清理真实缓存。

重建并发及排队有上限；默认 2 个正在重建、32 个等待，等待最多 5 秒，过载返回 503/CACHE_BUSY。已经有同一包在重建时共享结果。日志或指标出现持久状态错误时先确认运行时、权限、配额、目录和共享配置，而不是扩大缓存或关闭完整校验。
