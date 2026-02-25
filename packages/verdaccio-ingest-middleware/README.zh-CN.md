# verdaccio-ingest-middleware

[English](./README.md) | 中文

一个用于递归包摄取的 Verdaccio 中间件插件，支持多平台。专为需要从上游仓库下载 npm 包及其依赖以供离线使用的环境设计。

## 功能特性

- **递归依赖解析**：自动分析并下载已缓存包的所有依赖
- **多平台二进制支持**：下载特定平台的二进制文件（linux-x64、win32-x64、darwin-arm64 等）
- **差分导出**：仅导出自上次导出以来新增/修改的包，实现高效的离线同步
- **Web 管理界面**：内置管理界面，操作简便
- **元数据同步界面**（新增）：在 Web UI 中集成元数据同步卡片，支持从上游同步所有包元数据
- **单包同步**（新增）：支持同步单个包的元数据，支持 scoped 包如 `@types/node`
- **包列表浏览**（新增）：查看所有本地包并支持一键从列表同步
- **同步进度展示**（新增）：实时显示同步进度，包括已处理数量、总数量、失败数量等统计
- **同级版本补全**（新增）：对每个已缓存的版本，自动下载同 minor 系列的最新 patch 版本和同 major 系列的最新 minor 版本
- **异步任务管理**：长时间运行的操作在后台执行，支持进度跟踪
- **分析-确认-下载工作流**：在实际下载前预览将要下载的内容

## 安装

```bash
npm install verdaccio-ingest-middleware
# 或
yarn add verdaccio-ingest-middleware
```

## 配置

在 Verdaccio 的 `config.yaml` 中添加插件配置：

```yaml
middlewares:
  ingest-middleware:
    # 上游仓库 URL（可选，默认使用第一个 uplink）
    upstreamRegistry: https://registry.npmjs.org
    # 下载并发数（默认：5）
    concurrency: 5
    # 二进制包的目标平台
    platforms:
      - os: linux
        arch: x64
      - os: win32
        arch: x64
      - os: darwin
        arch: arm64
    # 同步选项
    sync:
      updateToLatest: false
      completeSiblingVersions: true
      includeDev: false
      includePeer: true
      includeOptional: true
      maxDepth: 10
```

## API 端点

所有端点以 `/_/ingest/` 为前缀。

### 包分析与下载

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/analyze` | 分析依赖（返回任务 ID） |
| GET | `/analysis/:analysisId` | 获取分析结果 |
| POST | `/download` | 根据分析结果下载包 |
| POST | `/retry` | 重试失败的下载 |

### 元数据管理

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/refresh` | 刷新已缓存包的元数据 |
| POST | `/sync` | 完整同步：刷新 + 下载缺失依赖 |
| POST | `/rebuild-index` | 重建本地元数据索引 |

### 平台二进制文件

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/platform` | 下载多平台二进制文件 |

### 差分导出

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/export/history` | 获取导出历史 |
| POST | `/export/preview` | 预览待导出文件 |
| POST | `/export/create` | 创建导出包 |
| GET | `/export/download/:exportId` | 下载导出包 |

### 状态与界面

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/status/:taskId` | 查询任务状态 |
| GET | `/cache` | 查看本地缓存状态 |
| GET | `/ui` | Web 管理界面 |

## 使用示例

### 分析并下载缺失的依赖

```bash
# 开始分析
curl -X POST http://localhost:4873/_/ingest/analyze \
  -H "Content-Type: application/json" \
  -d '{"platforms": [{"os": "linux", "arch": "x64"}]}'

# 响应: {"success": true, "taskId": "task-xxx"}

# 检查任务状态
curl http://localhost:4873/_/ingest/status/task-xxx

# 分析完成后，获取结果
curl http://localhost:4873/_/ingest/analysis/analysis-xxx

# 下载包
curl -X POST http://localhost:4873/_/ingest/download \
  -H "Content-Type: application/json" \
  -d '{"analysisId": "analysis-xxx"}'
```

### 导出用于离线传输

```bash
# 预览将要导出的内容（自上次导出以来）
curl -X POST http://localhost:4873/_/ingest/export/preview \
  -H "Content-Type: application/json" \
  -d '{"since": "last"}'

# 创建导出包
curl -X POST http://localhost:4873/_/ingest/export/create \
  -H "Content-Type: application/json" \
  -d '{"since": "last"}'

# 下载导出文件
curl -O http://localhost:4873/_/ingest/export/download/export-xxx
```

## Web 管理界面

访问 `http://localhost:4873/_/ingest/ui` 可以通过可视化界面：

- 查看已缓存的包
- 分析依赖
- 下载缺失的包
- 创建差分导出
- 监控任务进度
- 同步所有包元数据（调用 `verdaccio-metadata-healer` 同步 API）
- 同步单个包元数据，支持 scoped 包
- 浏览本地包列表并从列表一键同步
- 查看同步进度和结果

## 系统要求

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0

## 许可证

MIT
