# 双向镜像同步 v2：首版交付契约与迁移

## 范围和运行时

两端入口为 `/_/ingest/mirror/ui`、`/_/healer/mirror/ui`。旧管理页面提供链接。healer 沿用 `enableImportUI: true` 开关。包仍支持 Node ≥18；实际验证为 Node 24.19.0 / Verdaccio 6.2.4。设置 `mirrorRegistryURL` 为目标用户实际使用的 registry 基址（包括 HTTPS 或反向代理前缀）；已有 host 作为兼容默认值。

本版没有添加运行时依赖，也不安装数据库服务。Node 18 没有内置 SQLite，现有依赖无 SQLite 驱动；为保持离线安装兼容，首版使用带校验的 `.mirror-sync/index.json` 包/版本事件索引（包含当前快照头）、不可变 JSON 快照、逐传输日志及原子替换。索引是可丢弃派生数据，可从已保存的成功扫描重建；repository 身份、观察序号时钟、已保存快照、传输日志和回执不能作为缓存清除。SQLite 可在后续提供可选实现，不影响协议。目录 fsync/同盘硬链接要求本地 POSIX 文件系统；当前 Windows 仅作为 WSL 操作入口，尚未验证直接 Windows 存储。

## 文件契约

- 库存清单：schema=2，scope_id=`verdaccio-artifacts-v2`，独立 repo_id、snapshot_id、扫描起止时间、`complete`、errors、artifact_root、root，包含包/版本/实际相对路径别名/SHA256/SHA1/SHA512 SRI/大小与裁剪后的业务 metadata。
- `root` 绑定仓库、规范制品和业务 metadata，`artifact_root` 绑定包/版本/hash/大小。比较使用实际 tgz，metadata 中仅有版本会单列诊断。扫描对 tgz 解压核对内嵌 name/version；大小相等不证明内容相同。
- v2 包：根 `.mirror-manifest.json`，`blobs/<sha256>`。清单绑定 repo_id/scope_id/transfer_id/source_root/base_root/目标 repo_id/预期目标并集 artifact_root，含两端完整清单和精确补齐集合。不得把 v2 包交给旧版导入器；旧版会提示缺少 v1 清单。
- 回执：绑定上述链和目标实物校验后的 target_root/target_snapshot_id/receipt_hash。回执 hash 用于一致性检查，不是数字签名；离线传递仍需可信操作渠道。源端接受回执产生 ack，目标端接受 ack 完成链。两端只有这一流程记录共同基线；导出完成、mtime 或旧历史不会推进它。

## 完整操作流程

1. 升级两端插件并保留原配置与访问控制；设定各端 `mirrorRegistryURL`。不复制 `.verdaccio-db`、认证文件、秘密或 `.mirror-sync/repository.json` 到另一端。复制存储来创建新镜像时必须给新仓库重新建立身份；相同 repo_id 的两端会被拒绝。
2. 两端“完整扫描/重建索引”，下载各自清单。存在 EACCES、symlink、坏 tgz、扫描期间文件集合/属性变化或 metadata 错误时，清单标为不完整，保留前次索引指针，不能对账或导出。
3. 源端加载本端已保存快照，选择目标清单并对账。页面显示补齐、目标独有、同版本 hash 冲突、路径别名、metadata 无实物及 dry-run 隔离备份计划。存在冲突会整体阻断导出。先通过人工来源核实解决冲突，再重扫；无自动强制覆盖或删除。
4. 导出补齐包。文件从源一次读取到稳定暂存并同时 hash，复核源身份和快照，打包只读取暂存副本。导出失败没有成功回执和共同基线。
5. 目标页上传 v2 包。预检拒绝路径穿越、绝对路径、符号/硬链接、重复条目、未列明内容、畸形清单、目标错误、超限和 hash/内嵌身份错误；校验后才开始应用。默认总解压20GiB、单文件2GiB、50万条目、JSON64MiB，HTTP上传也限总字节。嵌套 gzip 被拒绝。新制品使用同盘硬链接无覆盖发布，metadata 合并保留目标版本/标签/本地身份，再刷新 Verdaccio 本地包列表。
6. 目标完整重扫验证并集、每个实际下载路径和 integrity 后产生回执。下载回执到源端接受，再将源端 ack 传回目标接受。丢回执可从状态下载原回执，未完成导入可重试同包。重复 transfer_id 必须与原内容完全一致；乱序包或目标变化需交换新完整清单重新导出。
7. 反向补齐时在另一端执行同一流程。外部没有内网独有制品时，必须从内网反向导出；不猜测包内容。

## 旧 v1 包和补齐包兼容

既有根 `.export-manifest.json`（version=1）包继续使用原来的 v1 上传/本地导入入口。必须逐文件 SHA256 和 size 正确、业务 metadata 可解析、清单仅列包目录的 `package.json`/tgz、无重复或额外内容。全部预检成功才会写入；旧 `validateChecksum:false` 不再绕过校验。目标同包同版本即使文件名不同，异 hash 也会整体阻断，即便 overwrite=true；目标 metadata 合并保留已有版本、标签、私有字段，来源内部字段不迁移。对实际 tgz 重算目标 dist URL/SHA1/SHA512，不能把丢失 dist 留给仅补缺失版本的 rebuilder。真实重建器成功或失败后，finally 均恢复目标已有标签。旧包不生成 v2 回执，不建立可信共同基线。旧格式可用于当前独立验证的补齐交付，之后两端完整扫描迁移到 v2。

旧导出仍产生 v1 包，但 `since`/`last` 不再裁剪文件：mtime 历史不可信，自动退回完整范围扫描并记录警告。`includeMetadata:false` 仅影响旧包内容，不会影响 v2 清单或共同基线。旧历史文件保留，不重写生产历史。

## 恢复边界与并发语义

快照是已保存的扫描区间观察，不是严格某时刻快照。时间点查询只通过保存的 snapshot_id/起止时间选择。系统会重新 hash、检查扫描前后集合/属性、对稳定暂存和导入后实物复核，不能证明外部程序在两次检查间没有短暂改动。

状态顺序：源 preparing → exported-awaiting-receipt / export-failed；目标 applying → verifying → verified-awaiting-ack / interrupted；源接受回执、目标接受 ack 后 acknowledged。每个日志落盘后才进入下一步。新 writer.lock 是原子创建的带 PID/随机所有权令牌的符号链接，不再先建空文件再写 JSON。旧残缺常规锁先检查同 uid 的活动文件描述符，仍被持有或无法验证时拒绝接管；确认无持有者后隔离重命名旧锁。WSL 的 systemd 用户管理器本身不执行 JS 写入者，其 Node 服务为独立 PID。文件系统与日志不是单个事务，重试会重新验证已发布制品，不能把应用一部分视为成功。导入过程中其他写入导致目标并集漂移时不发回执；已经发布的安全并集制品保留，需重扫对账。崩溃遗留暂存可检查后按隔离备份流程人工处理。

共同基线携带双方自己的单调观察序号和根。墙钟仅用于展示/筛选，不用于排序回执或判定因果；反向端时钟更早仍能推进，迟到旧观察不能回滚已接受根，重复确认返回 `baseline_advanced:false`。观察序号与仓库身份绑定，不可复制给另一仓库。

旧锁回收受独立的参与者票据互斥保护。每个操作使用唯一固定记录，从choosing到ticket通过原子替换状态，不删除/复用其他参与者的记录。回收者先取得该互斥，再检查旧PID和回收旧锁；不会以两次独立的“检查死PID→unlink”让后者删除前者的新锁。死进程的唯一参与者记录被忽略；活跃操作或无法判定所有权时拒绝进入。

## 包版本历史查询

网页第 5 步可查询包名、版本、起止观察序号和起止 UTC 时间。`GET <mirror-prefix>/changes?package=demo&version=1.0.0&from_sequence=1&to_sequence=20` 返回成功保存扫描中的 added、removed、hash-changed、aliases-changed、metadata-only/metadata-changed 事件。时间参数为 `from_time`、`to_time`；它们筛选保存的观察结束时间，不能据此声称任意时刻缓存状态。默认1000条，最多50000条，并返回截断标记。`POST <mirror-prefix>/rebuild-history-index` 从保存的成功快照重建事件索引，不读取生产在线状态补造过去。扫描失败不更新成功索引头，失败快照仍保留诊断。

索引保存已处理快照ID集合，读取时核对磁盘上的不可变快照。即使旧索引自身checksum正确，也会补入“快照已保存、索引尚未更新”的观察；若发现缺口早于索引头则全重建。下一次成功扫描会把补齐后的派生索引持久化；查询也会先补齐后返回，不能悄悄跳过中间出现/消失的版本。

插件内部串行化自己的扫描/传输，但不拥有 npm publish、其他进程和用户直接写文件的全局锁。首次生产验收应安排暂停其他写入的维护窗口，并对实际 registry HTTP metadata/tgz 下载再验收；本版不宣称跨外部写入者全局原子。停止其他写入、完整扫描成功、差异包全校验、目标并集和 metadata 下载路径验证、回执/ack 链完成后，才能将该轮同步认定为验收成功。

## 清理

本版仅给出同 hash 别名 dry-run 计划、源/目标仓库归属及隔离复制后验证的方案，无生产删除入口。不同 hash 不得以大小相等或路径相似归为重复。清理需另行审批，必须先保留可恢复隔离备份并验证 metadata 下载引用。

## Linux进程启动身份与平台边界

写入者记录同时绑定系统boot ID、/proc启动时间和PID命名空间，不只依赖PID或超时。旧boot、同PID不同启动身份及choosing/ticket阶段死亡不会阻塞；活持有者不被接管。同boot跨PID命名空间共享缓存、无法验证身份或非Linux写入均fail-closed，需要人工确认部署边界；不调整宿主安全设置。没有启动身份的旧开发记录不能凭超时抢占。当前首版只验证Linux/WSL同一PID命名空间、本地文件系统。

1174制品包衔接见 [修正版导入步骤](repair-bundle-handoff.md)。

## 2026-10-15 目标服务器验收补充

最新候选 `70489f9` 已验证 Node22 / Verdaccio6.2.4 的真实冷下载、双向同步、v1重建及metadata修复。已验证v2包重试会先核对制品并集，补齐缺失安装字段和dist后复验原target_root；制品或业务metadata漂移时拒绝旧回执，应交换新完整清单。零制品传输也补齐metadata，既有目标字段优先保留。标准存储的冷下载和healer自动保存复用锁内更新/安全创建适配器，不再仅依赖自定义upsert。详见 [目标服务器验收与操作说明](target-server-validation-2026-10-15.md)。
