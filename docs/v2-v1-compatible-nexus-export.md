# 在 V2 导出 V1 兼容包

归档仅包含 npm `.tgz` 和 V1 导出清单，每个目标通道对应一个固定的目标 npm 仓库。首次导出所扫描到的全部 tgz，有权限的用户确认整批导入后，后续归档只包含该目标尚未确认的包版本。判定依据是规范化的包名、版本、文件大小和 SHA256。相同内容的 scoped 路径别名只导出一次，同版本内容冲突会阻止创建归档。源端删除不会传播，已确认的版本仍会参与冲突检查。

## 配置和使用

从 2.0.2 起，启用摄取中间件即可在原管理页使用，无需设置 `standaloneSnapshotAdmins`。快照接口使用现有的 Verdaccio API 鉴权，匿名用户无法操作。

- 省略 `standaloneSnapshotAdmins`：所有通过 Verdaccio 鉴权的用户均可预览、创建、查看、下载和确认快照。
- 配置非空用户名列表：仅名单内的已认证用户可操作。配置 `[]` 或无效值会隐藏入口并禁止快照操作。

目标通道及其确认基线由获准用户共享，并不会按用户名隔离。有不应访问整批归档或推进基线的账号时，请配置名单。以下是限制给单一账号的示例：

```yaml
middlewares:
  ingest-middleware:
    enabled: true
    standaloneSnapshotAdmins:
      - release-admin
```

在 `/_/ingest/ui` 的「V1 兼容归档」卡片选择「导出 V1 兼容包」，填写目标通道（例如 `offline-npm`）和 Verdaccio 登录令牌，依次预览、创建、下载。创建会重新计算差量，并校验实际打包的 tgz 及其 npm 包名和版本。源端在扫描和打包之间发生变化时，请重新预览。导入完成后在源端刷新目标状态，选择对应归档并输入实际导入归档的 SHA256，再确认整批导入。

「普通全量导出」每次全量扫描，可选择附带 `package.json`。两端需要交换库存和回执时，请打开 `/_/ingest/mirror/ui` 进入 V2 双向镜像同步。

## 在目标仓库导入和复核

1. 在目标侧计算外层 `.tar.gz` 的 SHA256，与源端记录核对。解开外层归档，用 `.export-manifest.json` 中每个条目的包名、版本、大小和 SHA256 核对内层 tgz。
2. 通过目标仓库的既有导入流程交付每个 tgz。对于支持 npm 发布的仓库，版本缺失时可使用 `npm publish ./path/package-version.tgz --registry <registry-url>`。
3. 从同一个目标仓库查询每个确切包版本并取回其 tgz，逐个核对大小和 SHA256。已有且内容一致的版本可跳过。同版本异内容应记录为冲突并保留目标原有内容。只有每个条目都复核通过，获准用户才能回到 Verdaccio 确认该归档。

### Nexus 示例

若使用 Nexus npm hosted 仓库的批量导入任务，把解包后的 tgz 放入任务源目录。Sonatype 文档列出的 npm 批量导入起始版本是 3.25.0，并要求相应许可。[Sonatype npm 发布文档](https://help.sonatype.com/en/publishing-npm-packages.html) · [Sonatype 批量导入文档](https://help.sonatype.com/en/repository-import.html)

例如，一份归档含 `a@1.0.0` 和 `b@2.0.0` 两个 tgz。从目标下载时，`a` 的大小及 SHA256 匹配，`b` 缺失或哈希不同。即使 Nexus 任务显示运行结束，也应保留归档为待确认。复核同一个 hosted 仓库，在缺失时补交 `b`，在冲突时先处理冲突。两个版本均复核通过后，再确认这份归档。

## API

快照请求需要有效的 Verdaccio 登录令牌，并受可选用户名名单约束。普通导出仍接受不带 `mode` 的请求。下表把 `/_/ingest` 作为路径前缀。

| 方法与路径 | 请求与结果 |
| --- | --- |
| `POST /export/preview` | `{"mode":"standalone-snapshot","target":"offline-npm","since":"last"}`。返回基线 ID、全量或增量类型、文件及冲突。 |
| `POST /export/create` | 使用相同请求体。返回 `taskId` 和 `exportId`。没有新增时任务成功且无归档。 |
| `GET /status/:taskId` | 返回运行进度或结果。完成后可从结果获得归档下载地址和 SHA256。 |
| `GET /export/snapshot/:target` | 返回当前确认基线、已确认版本数量和目标的导出记录。服务重启后使用此接口找回归档。 |
| `GET /export/snapshot/:target/:exportId/download` | 下载归档。 |
| `POST /export/snapshot/:target/:exportId/confirm` | 发送 `{"outcome":"complete","archiveSha256":"实际导入的外层归档 SHA256"}`。重复提交相同归档确认是幂等操作。较旧的并行归档会返回冲突。 |

`since: last` 在快照模式下表示上次明确确认完整导入，省略时语义相同。此模式拒绝自定义时间。旧客户端仅传 `since`（包括 `since: last`）时继续获得全量导出和提示。旧导出历史仍可查看，首轮快照从当前文件开始。

归档使用 V1 的 `.export-manifest.json`、文件级 SHA256 和逐包 tgz。Verdaccio 的旧格式导入入口继续执行预检。`snapshot` 对象记录目标通道、前序快照 ID 和候选快照 ID。状态和归档位于 storage 下的 `.standalone-snapshots`，备份时一并保留。该目录所在文件系统须支持同目录的原子重命名和硬链接。服务重启后，已完成的归档和确认记录可继续使用。若中断在准备阶段，请新建导出。
