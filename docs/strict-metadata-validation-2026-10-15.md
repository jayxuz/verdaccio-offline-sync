# 严格 metadata 保留策略本地验收

基线：`453cc95a60a306b24bf7763f83cab304a669dd24`。本次仅修改本地源码并构建回归；未 push、未修改交付验证目录、未访问生产环境。

## 结论

三个插件 TypeScript 编译成功。串行插件测试 153/153 通过，0 失败、0 skipped，最终一轮耗时约 35 秒。执行环境 Node 24.19.0，真实 HTTP 框架 Verdaccio 6.2.4。目标交付镜像 Node 22 的完整 1174 版本验收仍需由打包流程重新构建后执行，不能据此宣布最终交付 READY。

## 修复

1. offline-storage 新增显式 `metadataPolicy: preserve`。合法目标标签保留，缺失或校验不通过的本地制品标签仅从响应中过滤；不推导 latest。
2. healer middleware 在 Verdaccio 最终 normalizeDistTags 之后恢复来自同一 verified readCache 的标签及原时间，覆盖完整与 install-v1 HTTP 响应。存储与 middleware 配置须匹配。
3. 严格重建不生成 modified，不自动更新 latest，也不在 filter 请求路径异步保存 metadata。v1/v2 sidecar 合并保留目标标签、时间、独有版本，允许补入来源字段。
4. 策略进入读缓存 mode、管理器身份、预热 worker 配置和实现指纹；严格模式不会复用旧策略生成的 metadata。

## 新回归证据

- 本地真实 tgz 包含 1.0.0、2.0.0、3.0.0-beta.1，latest 固定 1.0.0；私有标签与 next 原样保留。兼容默认仍选择最高稳定版本。
- 空标签、仅 next 的预发布包、指向不可下载制品的标签、metadata 标签更新和 tgz 删除失效均覆盖。
- 真实回环 HTTP：8 包、10 个版本，完整与 install-v1 双格式；显式小范围 worker 预热、重复内存命中、独立进程重启后 SQLite 命中。持久命中后 hashBytes 为 0，下载 SHA1/SHA512 仍逐次验证。
- v1 包导入覆盖五个最小 metadata，其中一个为新包；目标 demo 独有版本保留。首次 1 个制品新增，其余跳过；第二次全部跳过仍执行重建。每轮及重启后标签/时间一致，安装字段与 hasInstallScript 正确，仅解析脚本字段，不执行脚本。
- v2 新增 sidecar 标签/来源时间合并与零制品导入回归；目标同名字段优先。
- 其余既有镜像链、冲突拒绝、回执与基线、读缓存持久化及资源上限测试均保持通过。

配置全文见 [严格 metadata 保留模式](strict-metadata-policy.md)。本次未复制真实缓存、未补下载大包，未执行目标镜像完整 1174 验收；原交付 NOT-READY 需在该项重验通过后再推进。
