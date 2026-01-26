# verdaccio-metadata-healer

[English](./README.md) | 中文

一个用于离线环境中自动元数据修复和差分包导入的 Verdaccio 插件套件。本包提供两个插件：

1. **MetadataHealerFilter** - 自动修复缺失包元数据的过滤器插件
2. **ImportMiddleware** - 用于导入差分导出包的中间件插件

## 功能特性

### 元数据修复过滤器
- **自动元数据修复**：动态注入缺失的版本信息到包元数据中
- **Tarball 扫描**：扫描存储目录中的 `.tgz` 文件并提取元数据
- **SHA 校验和缓存**：缓存计算的校验和以提高性能
- **自动更新 Latest 标签**：自动将 `dist-tags.latest` 更新为最高可用版本
- **非破坏性**：即时修复元数据，不修改原始文件

### 导入中间件
- **差分导入**：导入由 `verdaccio-ingest-middleware` 创建的导出包
- **Web 界面**：内置上传和管理导入的界面
- **进度跟踪**：导入过程中实时更新进度
- **校验和验证**：导入时验证文件完整性
- **导入历史**：跟踪所有导入操作

## 安装

```bash
npm install verdaccio-metadata-healer
# 或
yarn add verdaccio-metadata-healer
```

## 配置

### 元数据修复过滤器

在 Verdaccio 的 `config.yaml` 中添加：

```yaml
filters:
  metadata-healer:
    # 启用/禁用过滤器（默认：true）
    enabled: true
    # 存储路径（可选，默认使用 Verdaccio 存储路径）
    storagePath: /path/to/storage
    # 自动更新 dist-tags.latest（默认：true）
    autoUpdateLatest: true
    # 缓存设置
    cache:
      # 最大缓存 SHA 数量（默认：10000）
      maxSize: 10000
      # 缓存 TTL 毫秒数（默认：3600000 = 1 小时）
      ttl: 3600000
```

### 导入中间件

在 Verdaccio 的 `config.yaml` 中添加：

```yaml
middlewares:
  metadata-healer:
    enabled: true
    enableImportUI: true
    # 存储路径（可选，默认使用 Verdaccio 存储路径）
    storagePath: /path/to/storage
```

## 工作原理

### 元数据修复

当 Verdaccio 提供包元数据时，过滤器插件会：

1. 扫描包的存储目录中的 `.tgz` 文件
2. 将找到的版本与元数据的 `versions` 对象进行比较
3. 对于缺失的版本，从 tarball 中提取 `package.json`
4. 将缺失的版本信息注入到响应中
5. 如需要，更新 `dist-tags.latest`

这在以下情况特别有用：
- 包被直接复制到存储目录而没有正确的元数据
- 元数据损坏或不完整
- 从其他仓库迁移包

### 差分导入

导入中间件允许你：

1. 上传 `.tar.gz` 导出包（由 `verdaccio-ingest-middleware` 创建）
2. 提取并验证内容
3. 将包复制到正确的存储位置
4. 重建导入包的元数据

## API 端点

所有端点以 `/_/healer/` 为前缀。

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/import/upload` | 上传并导入差分包 |
| GET | `/import/status/:taskId` | 查询导入任务状态 |
| GET | `/import/history` | 获取导入历史 |
| GET | `/ui` | Web 管理界面 |

## 使用示例

### 通过 API 导入

```bash
# 上传并导入差分包
curl -X POST http://localhost:4873/_/healer/import/upload \
  -F "file=@verdaccio-export-2024-01-15.tar.gz" \
  -F "overwrite=false" \
  -F "rebuildMetadata=true" \
  -F "validateChecksum=true"

# 响应: {"success": true, "taskId": "task-xxx"}

# 检查导入状态
curl http://localhost:4873/_/healer/import/status/task-xxx

# 查看导入历史
curl http://localhost:4873/_/healer/import/history
```

### 导入选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `overwrite` | boolean | false | 覆盖已存在的文件 |
| `rebuildMetadata` | boolean | true | 导入后重建包元数据 |
| `validateChecksum` | boolean | true | 验证文件校验和 |

## Web 管理界面

访问 `http://localhost:4873/_/healer/ui` 可以：

- 拖放文件上传
- 实时查看导入进度
- 查看导入历史
- 监控任务状态

## 工作流：在线到离线同步

本插件设计用于与 `verdaccio-ingest-middleware` 配合，实现完整的在线到离线工作流：

1. **在线环境**（使用 `verdaccio-ingest-middleware`）：
   - 从上游仓库缓存包
   - 创建差分导出包

2. **传输**：将导出文件复制到离线环境

3. **离线环境**（使用 `verdaccio-metadata-healer`）：
   - 通过 Web 界面或 API 导入差分包
   - 元数据修复器自动修复任何缺失的元数据
   - 包可供安装使用

## 系统要求

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0

## 许可证

MIT
