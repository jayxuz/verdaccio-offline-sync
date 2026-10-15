# 1174 制品补齐包与修正版的衔接

> 公开脱敏说明：本文中的自用服务器和环境变量占位符用于公开说明。原始服务器快照、SSH 日志、原始验收归档及旧 Git 历史仅保存在仓库外私有恢复资料中，不随现公开交付包提供；文中历史原始归档校验值不代表当前脱敏包。此轮只做本地脱敏与回归，没有重新连接或操作服务器。

> 2026-10-15 更新：目标服务器隔离验收发现并修复两处问题，最新源码候选为 `70489f9`。后续请以 [目标服务器验收与操作说明](target-server-validation-2026-10-15.md) 及其新候选哈希清单为准；本文原 `217a3c4` 是较早本机验收记录。

交付目录：`${LOCAL_HOME}\Documents\codex\2026-10-14\task-3\verdaccio-audit-2026-10-14\repair-bundle-2026-10-14`。

`repair-tarballs-2026-10-14.v1.tar.gz` 为 manifest v1、1174个tgz、823包，大小4,535,783,719字节。已交付的整包SHA256为 `a754c79f474c1145b96f495930afb228d365dd9dbbe6f515293eb77eb8715323`。本轮不重读整包，复用独立交付核验报告；只读校验381KB清单、5MB metadata补丁以及少量实际样本。清单最大单制品150,852,388字节、tgz合计4,553,044,984字节，均在修正版v1导入限制内。

## 无需整包转换，必须使用修正版入口

此包刻意不带package.json。它可以直接交给**本次源码构建的修正版 v1 导入器**，不能上传原1.1.8发布版，也不能误传到要求`.mirror-manifest.json`的v2页面。插件package.json的版本号暂未改变；必须按候选包文件名中的Git提交及`candidate-packages.json`中的SHA256识别本次构建，不能只看1.1.8/1.3.0版本号或重新从registry安装旧发布包。

修正版入口为原 `/_/healer/ui` 的旧格式导入区，实际上传API仍是 `/_/healer/import/upload`，实现已经替换为强制预检。选择 `rebuildMetadata=true`，保持overwrite=false；checksum不可绕过。修正版会按包/版本跨别名预检实际hash，冲突整体拒绝；重建/登记来自真实tgz，补全已有metadata条目缺失的标准安装字段，保留目标已有属性、合法版本及标签。全跳过的重复包仍会重建metadata，支持导入中断后的重试。

## 正式操作顺序（本轮未执行生产操作）

1. 先审查/安装本机候选到隔离的目标演练环境，确认源码/包SHA与报告一致，已有访问控制和认证配置保持原样；不要复制另一端`.verdaccio-db`、htpasswd或密钥。实际registry基址尚未取得，部署配置必须填写真实 `mirrorRegistryURL`，包括HTTPS及反向代理前缀。
2. 在正式目标取得当前库存、受影响包metadata及同版本别名实际hash。使用交付目录的`delivery_precheck.py`和`preview_metadata_merge.py`做独立业务/合并预览；目标未知、关键字段/SRI冲突或held非零时先解决。副本缺文件默认不是“目标不存在”；只在获准对实际缓存只读盘点时使用工具的`--actual-cache-root`语义。
3. 安排停写窗口及受影响数据的隔离备份/回滚方案。磁盘空间按至少 `2×归档大小 + 展开tgz总量 + 备份/metadata余量` 规划上传路径的峰值；归档本身4.22GiB不等于只需4.22GiB空间。
4. 在修正版v1入口导入原归档；不需要重打包4.22GiB，也不要把metadata补丁直接复制成目标package.json。导入器自身仍会读取并验证全部成员，这是正式导入时必要的运输/落盘验证。
5. 验收实际目标文件hash、所有新增版本的dist URL/SHA1/SHA512、HTTP下载、目标私有版本/标签及实际工程闭包。任何任务success都不能代替验收。新包默认latest来自本地实际可用版本策略，不伪称为源权威标签；5个仅嵌入恢复包不伪造权威发布时间/发布历史。
6. 该v1包不建立共同基线。完成补齐并验收后，两端在v2页重新完整扫描、互换库存、对账，必要时导出空制品/metadata修复轮，取得目标验证回执并交换ack，才建立本轮可信基线。532项内网独有必须由内网v2反向导出真实制品，不能从公网猜测或删掉；清理仍只有dry-run与隔离备份方案。

## metadata补丁的角色

`metadata-merge-patches.json` 是按版本带来源的安全安装字段证据及合并预览输入，不是可覆盖目标的完整packument。修正版从真实tgz重建exports/imports/type/typesVersions/sideEffects/os/cpu/libc/peer元信息等字段，保持条件exports/imports的顺序，检查实际binding.gyp及显式生命周期以生成hasInstallScript。已有目标显式值保留；若业务预览显示与制品关键字段矛盾，应hold并人工核实，不能强行覆盖私有同版本信息。

818包的源安全投影可用于核对，5包最小恢复的未知源信息继续保持未知。源权威dist-tags、弃用说明或其他registry专有信息如需补充，应经过目标预览和审阅；本次不自动把sidecar作为整份metadata覆盖。

## 本机样本证据

`scripts/mirror-repair-handoff.cjs <交付目录>` 只访问本任务`/tmp/verdaccio-mirror-e2e-*`和固定15972测试端口，拒绝任意生产registry参数；不打开完整大归档。它抽取少量已暂存制品构成小v1包，预置一个“已有metadata但无tgz”的条目，经真实导入/重建器验证标准字段、私有注释/标签、SRI与HTTP，并重复导入确认全跳过时仍完成重建、v1不推进基线。实际样本数与读取字节见`repair-handoff-validation.json`。

这证明交付契约与修正版的样本衔接；不替代1174制品在真实目标上的前置对账、冲突/容量预检和正式验收。本轮没有向自用服务器导入、部署或清理。
