# 离线存储重启认证保持修复

基线：`ea687d6a442d8d8344aa8621ad1380daeb79d260`。本次仅在本地修源码、构建与隔离回归，未访问服务器或生产凭据，未修改用户认证权限、认证算法或认证配置。

## 根因和修复

`LocalDatabase` 在父类构造器中读取并保存完整 `.verdaccio-db.json`。子类随后把 `this.data` 替换成仅含 list 的新对象，丢失父类 `getSecret()` 所需的已有 secret；Verdaccio 启动时因而生成并保存新 secret，旧 token 在重启后失效。

子类现在保留父类数据库对象，仅在 list 不是数组时补为数组。data 使用 TypeScript declare 声明，避免未来开启 class field 初始化时再次遮蔽父类状态。继承的 getSecret/setSecret 与数据库写入行为保持原样。无需更改认证配置；严格 metadata 模式仍沿用两个 `metadataPolicy: preserve` 与独立 SQLite 状态目录。

## 验证

修复前先运行新增回归：已有 secret 加载检查失败；真实 HTTP 原 token 首次重启后返回 401，复现交付阻塞。断言仅比较布尔结果，不输出 secret/token。

修复后：三个插件 TypeScript 编译成功，完整串行回归 154/154 通过，0 失败、0 skipped。运行环境 Node 24.19.0、真实 Verdaccio 6.2.4。首次完整运行有一项既有缓存过期计数断言失败，该项独立复验通过后再次执行完整回归；本次未修改该缓存测试或放宽断言，单次波动原因未定位。

- 数据库回归预置随机测试 secret、已有包列表和额外数据库字段；连续三次创建插件实例并新增包后，这些状态均保留。
- 真实 HTTP 使用临时 htpasswd 与随机测试密码，只在首次启动创建一次本地测试用户、取得一次 API token。整个测试没有重签 token、重新登录或替换 Authorization。
- 包访问要求 `$authenticated`；每轮匿名 GET 均为 401。同一初始 token 在预热、内存命中、SQLite 跨进程命中、两次进程重启之后，完整/install-v1 metadata 与 tarball 下载均成功。
- 两次重启后的数据库 secret 均在内存中与最初值比较相等；报告与日志不保存 secret、token、密码或它们的指纹。
- 同时继续覆盖八包十版本的标签、时间、SHA1/SHA512、安装字段、新包 v1 导入与全跳过重复导入。临时实例、数据库及 htpasswd 在测试结束后删除。

本次本地回归不代替目标 Node 版本镜像的 1174 版本验收。打包流程应基于本次提交重建候选，在隔离环境沿用一次签发的原 token 完成重启续验；最终 READY 仍由目标镜像完整验收决定。
