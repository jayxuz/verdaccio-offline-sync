# 自用服务器 隔离验收与操作说明（2026-10-15）

> 后续真实缓存性能验收：最新三插件候选为b8fedc8，已修复重复metadata读取/校验开销。见[真实缓存只读离线性能验收](offline-performance-validation-2026-10-15.md)；本文保留较早同步场景验收记录。

## 结论与范围

最终运行时代码提交为 `70489f97148b433b04bb15c265e0871f58f53d3d`。在目标服务器真实 Docker / Node 22 环境中，完成小规模顺序双实例验收：**111 项断言通过**，保存 **135 条 HTTP 请求记录**（另有两次 v1 multipart 上传）。本机 TypeScript 构建成功，**126/126 单元回归通过**。发现的两处实际问题已经修复、中文本地提交、重新打包并从空缓存重跑。

本次仅验收临时实例；没有 push、npm 发布、生产部署、生产导入、生产清理或生产共同基线变更。未复制真实约 40 GiB 缓存，未打开或导入 4.22 GiB 补齐包。真实公开样本只有 `is-number@7.0.0`，其余为本任务生成的受控小样本。18 个禁用版本未作为样本、未下载。未执行任何下载包的生命周期脚本。

## 两处修复

1. `325234a8a35f08561eb7144bf54144f647f76690`：**修复标准存储下冷下载与元数据自动保存**。原下载器只接受自定义存储的 `upsertPackage`；目标服务器使用标准存储适配器时，tarball 已下载但任务在保存 packument 时失败。下载器与 healer 自动保存入口现复用已存在的 Verdaccio 标准锁内更新/安全创建适配器，同时保留自定义 upsert 支持和未知适配器拒绝保护。
2. `70489f97148b433b04bb15c265e0871f58f53d3d`：**修复重复及全跳过导入的元数据补齐与回执复验**。已验证 v2 包重试原来只校验、不修复丢失的 dist；现在先核对实际制品并集，再补齐缺失安装字段、重建 dist、刷新真实存储并复验。保留目标已有字段和私有属性。制品集合变化或业务 metadata 无法恢复为原验证根时拒绝沿用旧回执，需交换新清单。零制品传输也补齐 metadata。

首次失败和第二次重试失败的原始结果分别在证据目录 `initial-failure/`、`retry-failure/`；最终成功结果为 `acceptance-results.json`。这些是独立运行，不能把最终结果理解为原候选 `217a3c4` 已经通过。

## 隔离与资源控制

服务器：Linux x86_64、Docker 28.2.2；只读预检显示 12 核、约 131 GiB 可用内存，`/tmp` 所在磁盘约 89 GiB 可用，`${SERVER_DATA_ROOT}` 约 314 GiB 可用。交换空间使用较高，因此测试容器禁止额外 swap，采用小样本顺序测试。

复用已有镜像 `${TEST_IMAGE}` 内的依赖，候选 `build` 以只读目录挂载覆盖插件代码；没有修改或重新标记原镜像，也没有替换生产容器。候选不捆绑依赖，不能仅凭 package.json 的 `1.3.0` / `1.1.8` 版本号识别本轮修复。

| 项目 | 配置 |
|---|---|
| 唯一临时根 | `/tmp/verdaccio-accept-20261015-7c9e2a` |
| 容器 | `vsync-7c9e2a-a`、`vsync-7c9e2a-b`，标签 `codex.acceptance=7c9e2a` |
| 最终轮专属网络 | `vsync-7c9e2a-net`；前两轮为 Docker 默认 bridge 上的独立测试端点，结束后均随测试容器移除 |
| 端口 | `127.0.0.1:18471 -> A:4873`、`127.0.0.1:18472 -> B:4873` |
| 每实例限额 | CPU 0.5 核、内存 384 MiB、memory-swap 384 MiB、PID 96 |
| 缓存/状态 | 每个实例独立 tmpfs `/verdaccio/storage`，上限 128 MiB；`.mirror-sync`、库存、历史、归档、回执均在该实例 tmpfs 内 |
| 配置/临时文件 | 每实例 `/tmp` tmpfs，上限 48 MiB；配置独立生成，未复制生产配置/数据库/认证文件 |
| 容器日志 | 2 MiB × 2 轮换；本轮宿主证据与候选合计仅数 MiB |
| 只读挂载 | 本任务 `server.cjs`、候选 ingest/build、候选 healer/build；根文件系统只读、cap-drop ALL、no-new-privileges |
| 上游 | A 直连 `https://registry.npmjs.org`，并发 1；B 无 uplink；未指向生产代理 |

测试使用现有 Windows SSH 认证和严格主机验证；WSL 未知该主机记录时没有修改 known_hosts、没有读取或输出密钥。没有对 LAN 开放新端口或手工修改防火墙。完整挂载、端口、资源参数见 `test-containers.jsonl` / `test-inspect-final.json`。

## 实际验收项目

| 场景 | 结果与证据 |
|---|---|
| 冷缓存精确下载 | 先请求 `/is-number`，完整扫描 0 个实际 tgz，metadata-only 单列；再调用 `/_/ingest/download` 精确下载 7.0.0，仅出现该版本真实 tgz，任务 completed |
| 完整清单与 JSON 库存/历史索引 | 完整扫描成功；删除测试派生 `index.json` 后从已保存快照重建，事件集合一致，未删除身份/时钟/回执 |
| 完整导出→B 导入 | A 的真实小包与受控版本传入 B；B 原有同包 2.0.0 和独有包保留；真实 HTTP metadata/tgz 可用 |
| 安装 metadata 与 dist | 验证 exports、types、sideEffects、版本集合及下载 URL；每次 HTTP tarball 重新计算 SHA1 和 SHA512 SRI |
| 重复导入修复 | 删除测试 B 已导入版本的 dist 和 exports，再上传原 v2 包，字段补回、原回执可恢复、私有字段保留 |
| 增量 | A 新增 1.1.0，差异包仅 1 个制品；B 原有版本保留 |
| 反向差分 | B 向 A 导出 2 个 A 缺失制品，完成反向回执和 ack，HTTP 下载校验通过 |
| 全跳过传输 | 删除测试 B 的 dist/exports，但制品集合相同；导出 0 个制品的 v2 包仍修复 metadata 并完成回执链 |
| 基线推进 | 导出完成、目标导入验证完成均不推进；源接受有效回执、目标接受 ack 后各自推进；重复确认返回不推进 |
| 篡改与错误链 | 改 blob 字节、改 base_root、错目标仓库、目标在导出后变化均 HTTP 409；基线保持不变 |
| 错误回执 | 对错误 target_repo_id/base_root 重新计算 receipt_hash 后仍因链不匹配被拒绝；不是仅测试校验和损坏 |
| 同版本异 hash | 真实有效受控 tgz 的同版本不同内容被列为冲突，导出拒绝，目标与基线保持原样 |
| 旧 v1 兼容 | 真实 multipart 入口 `/_/healer/import/upload`，`rebuildMetadata=true`；首次及全跳过重试均调用实际重建器、恢复 dist/exports、保留 B 私有版本/标签；来源内部字段不迁移，v2 基线不推进 |
| 管理 UI | 目标两端 UI HTTP 200 且内容正常；本轮未重新跑浏览器点击自动化 |

实际操作脚本 `acceptance.py`、`server.cjs`、`launch-remote.sh` 和候选清单一并归档。`acceptance-run.log` 记录断言；`acceptance-results.json` 记录请求状态、字节和耗时；各轮完整清单、差异包、回执和 ack 均有保存。负向测试的 409 及其调试堆栈属于预期拒绝，不是最终运行故障。

## 冻结候选

源码 SHA256：`5df2d5ef1e36f6924fc077b6852d63b94699172a6004b01eb27c1b9409ec3178`。

构建 JavaScript SHA256：`3247b677d10dd89f2577a9ef3bab14e9f5fc6dcaee5af83a22a99e6de01144a8`。

| 文件 | SHA256 |
|---|---|
| `verdaccio-ingest-middleware-1.3.0-dev-70489f9.tgz` | `9da12847cb9def5f4dd7172aeac427e6eed9e6472792cf113844635bef62ba45` |
| `verdaccio-metadata-healer-1.1.8-dev-70489f9.tgz` | `9ad33488eebec639f4137d74c17366d6f5d8538962c0e0a13e9ff70aff99f71b` |

`candidate-packages.json` 是交付依据；`verified-fingerprint.json` 验证目标宿主解包后的源码/构建与该清单一致。测试容器的只读候选挂载详见 inspect 证据。候选可供后续新镜像/新实例评审与部署准备，本任务没有构建发布镜像或改变生产安装。

## 生产未变更的证据边界

预检生产容器 ID：`${PRODUCTION_CONTAINER_ID}`；启动时间 `${PRODUCTION_STARTED_AT}`；重启次数 0。生产原有挂载为 `${PRODUCTION_ROOT}/conf:ro` 和 `${PRODUCTION_ROOT}/storage:rw`。这些路径没有进入任何测试挂载，测试写操作均限定在自身 tmpfs、任务临时目录和本地源码。

测试前后及清理后比较容器 ID、启动时间、重启次数、状态、镜像和原挂载；另外只读比较生产配置及 `.verdaccio-db.json` 的 SHA256。结果见 `production-comparison.json`、`production-before.txt`、`production-after.txt`、`production-after-cleanup.txt` 与前后哈希文件。

这不是对全部真实缓存的停写逐文件取证；生产仍有正常业务，因此不把目录 mtime 或少数文件哈希等同于“全部缓存内容绝无变化”。本任务隔离证据是明确的测试挂载和命令范围，以及生产容器未替换/重启、配置与数据库前后只读核对。没有调用生产 registry、生产同步接口或生产基线。

## 后续使用操作

1. 先按候选清单核对完整文件名、提交和 SHA256，不要从 registry 按原版本号重新下载代替本候选。后续新镜像中安装两个候选及其已有兼容依赖，在新隔离实例先复验；保留现有认证和访问控制。
2. 两端配置自己的实际 `mirrorRegistryURL`。在 `/_/ingest/mirror/ui` 与 `/_/healer/mirror/ui` 分别完整扫描并下载清单；不复制仓库身份、认证文件或 `.verdaccio-db.json`。
3. 源端选择对方清单对账；处理所有同版本 hash 冲突后导出。导出成功不等于目标验证成功，也不会推进共同基线。
4. 目标上传 v2 包并验证实际版本、dist URL、SHA1/SHA512 和双方独有版本。把目标回执带回源端接受，再把源端 ack 带回目标接受；两端共同基线至此完成。
5. 丢回执或 metadata 丢字段时可重试原包；若实际制品/业务 metadata 已漂移而被拒绝，重新交换完整清单，不强行套用旧回执。
6. 旧补齐包继续使用 v1 上传入口并开启 `rebuildMetadata=true`，保持 `overwrite=false`；先做目标实际同版本 hash/metadata 预检和隔离备份。v1 不建立 v2 基线，之后需完整清单与回执链。

上述生产部署/导入/清理仍需单独授权。复用本次验收脚本时必须换新随机任务标识、目录、容器、网络与空闲回环端口，并先只读预检资源。脚本中的受控样本只适用于临时实例，不能把地址改成生产后直接运行。

## 未覆盖与限制

- 未进行真实约 4.4 万版本规模、40 GiB 缓存或大归档性能验收；未做压测。
- 目标验证为本地 POSIX 文件系统上的标准 Verdaccio 存储与既有镜像依赖；未复制生产配置或完整依赖闭包重建新 Docker 镜像。原生 Windows、Node18、Verdaccio5仍未覆盖。
- 未在目标重跑真实浏览器点击自动化；本轮以实际插件 HTTP API、UI 页面可达性和下载字节为验收依据。
- 进程崩溃、并发写入、跨命名空间等更广场景依赖已有单元回归；本轮服务器测试顺序运行。仍不宣称与外部 npm publish 组成全局原子快照。
- 测试结束停止并删除本任务容器及专属网络。证据校验下载后再删除精确匹配本任务的远端临时目录；不执行 Docker prune、系统缓存清理或生产删除。

## 归档复核结果

最终实际运行版本为 **Node v22.21.1 / Verdaccio 6.2.4**。本地核对 111 项断言全部成功，135 条记录中 7 条为预期的 HTTP409拒绝。两实例退出码均为0、未OOM；CPU、内存、回环绑定、专属网络和所有只读挂载均通过归档 inspect 复核。测试末尾内存读数约56.5 MiB/实例，仅为采样值，不代表完整运行峰值。

生产身份、启动时间、重启次数、状态、镜像和挂载前后完全一致；生产配置与数据库哈希一致。清理后再次确认生产身份一致；本任务容器和专属网络均已删除，没有清理其他资源。

证据归档 `server-evidence.tar.gz` 的 SHA256 为 `335dae4bea547a23a1f83c78691c0c54a6111fbcf176879248aa3bd780089750`。下载后已在本机复算一致，并安全展开核对结果与清理证据。简要机器可读结论见 `delivery-verification.json`；原始脚本及修复回放记录另存 `reproduction/`。完整证据中保留各轮失败与最终成功，不应只依据旧的单一失败日志判断最终候选。
