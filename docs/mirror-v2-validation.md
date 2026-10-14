# 镜像同步 v2 隔离验收（2026-10-14）

实现位于原开发仓库；基线 `79f7684`。未访问或修改 `自用服务器`、生产缓存、真实导出历史；未推送、发布或生产部署。原审计目录仅只读参考。

## 自动回归

Node 24.19.0，Verdaccio 6.2.4，使用项目已经安装的 TypeScript/tsx/tar/semver/Express。两个插件 TypeScript 编译成功；最终 **124/124 测试通过**（原基线82项，加42项）。没有新增项目运行时依赖；官方 Playwright CLI 仅安装到本任务 Windows 工具缓存。

| 场景 | 验证结果 |
|---|---|
| 旧/相等 mtime、保留 mtime 的内容改变 | 通过 hash 选择或隔离冲突，旧历史不建立可信基线 |
| 扫描后新增、导出前源变化 | 不完整扫描/快照漂移阻断，不更新成功索引/共同基线 |
| 真实流中变更并恢复 mtime | 同流暂存读检测 ctime/文件身份变化并拒绝 |
| metadata 过滤、EACCES、symlink | 旧格式完整扫描兼容；错误不被吞掉，v2完整标记不误推进 |
| 导出失败、损坏/漂移索引 | 无成功回执；索引可由保存成功快照重建 |
| 导入中断重试 | 注入异常和真实子进程退出77两条路径均恢复；死PID锁恢复，原 applying 日志继续 |
| 乱序、重复、回执丢失、换目标 | 错目标/断链拒绝，重复幂等，可重新取得原回执 |
| 内网独有、双向集合并集 | 保留独有并通过反向导出补齐，无自动删除 |
| 同版本异hash、同大小异内容、跨文件名别名 | v2阻断/隔离；v1也在应用前整体拒绝，目标文件保留 |
| 路径穿越、链接、重复、额外内容、压缩膨胀、嵌套gzip、校验坏包 | 应用前拒绝 |
| v1 checksum坏、checksum正确但metadata坏JSON | 应用前拒绝，不发布tgz；旧opt-out不能绕过 |
| v1 metadata/private/latest | 合并保留目标版本和标签；rebuilder失败也finally恢复标签 |
| 残缺旧锁、活锁 | 持有中不抢；关闭后可隔离恢复；新锁原子携带PID/令牌 |
| 两个真实子进程竞争回收旧死PID | 屏障后错开回收，只有一个进入临界区；参与者固定记录/原子票据替换串行回收 |
| 保存B快照后索引更新前退出 | 合法旧索引校验和不能掩盖遗漏；恢复A再扫描的新增/消失历史与全重建一致 |
| 反向端时钟更早、迟到回执 | 单调观察序号推进；旧回执不能回滚，返回实际baseline_advanced |
| 包/版本变化查询 | 新增、消失、hash、别名、metadata-only、纯metadata变化，序号/UTC命中区间、索引重建 |

复现编译/回归：在开发仓库使用当前 Node，依次执行 `node node_modules/typescript/bin/tsc -p packages/verdaccio-ingest-middleware/tsconfig.json`、healer同路径的tsconfig，再执行 `node node_modules/tsx/dist/cli.mjs --test packages/*/test/*.test.ts`。没有使用会自动重装依赖的本机 pnpm11 测试入口。

## 真实浏览器与 HTTP

`scripts/mirror-e2e-server.cjs` 只新建 `/tmp/verdaccio-mirror-e2e-*`，启动15971/15972两个真实 Verdaccio 6.2.4。官方 Playwright CLI + 已安装 Edge 在隔离浏览器中操作：两端完整扫描/下载清单、对账、下载/上传差异包、下载/上传回执/ack、反向导出、历史查询。两端两轮状态均 acknowledged；各独有1个制品最终形成2个制品并集，原目标独有制品保留。UI没有JavaScript错误。

`scripts/mirror-http-validation.cjs` 在上述浏览器步骤后验证：两端4次metadata/tgz请求均HTTP200，SHA1和SHA512 SRI均与实际响应一致；随后经原v1 multipart上传入口导入真实 `legacy-demo@1.0.0`，运行真实 ImportedPackageRefresher，目标原 `legacy-demo@2.0.0`、private标签与latest=2.0.0均保留，两版本tgz均HTTP200且完整性正确；来源内部字段未复制。再次扫描能查到两条legacy版本新增事件。

原始回归日志、浏览器截图/清单/差异包/回执/确认和 `http-validation.json` 保存于本任务输出目录。HTTP报告绑定运行时Git提交、两插件src源码SHA256及build JavaScript SHA256。测试目录和两个测试实例与真实缓存隔离；完成后停止本任务实例，保留证据，不清理用户数据。

## 限制与后续验收

索引采用带校验的JSON事件索引、不可变快照和传输日志，不是SQLite；尚未进行约4.4万版本真实规模的性能/容量验收。未验证Node18、Verdaccio5和原生Windows存储的运行结果；声明的Node≥18兼容没有通过新增原生依赖收窄。当前要求本地POSIX文件系统。

扫描是区间观察，插件锁只串行化插件自己的操作，不提供跨npm publish/外部写文件的全局原子事务。维护窗口完整扫描、制品全校验、目标并集/metadata路径复核、可信渠道回执/ack和实际HTTP验收完成后，才认可该轮同步。旧v1包兼容但不产生v2共同基线；旧mtime历史必须重新完整扫描迁移。

未实现：SQLite后端、Merkle树、后台实时监控、任意未保存时刻重建、超大差异包自动分卷、自动冲突择优/覆盖、生产清理与部署。清理只有dry-run和隔离备份方案。

## 最终源码与验收绑定

源码提交：217a3c435a1d033a2ec0a019e87a4d18ef45d0f3。源码SHA256：d1e84aba526d16a6faf883f3a04a0922d0aeff8d69d87d919e7ee123ea08aa48；构建JavaScript SHA256：9229acefb072217afa5c3ec56a27a2c9cca2313f00504d7489ce9303f94ec8b0。

真实补齐包样本数：5，实际读取制品字节：8839；大归档未打开，生产未导入。metadata-only条目、安装字段、私有注释/标签、全跳过重试及HTTP验证通过。
