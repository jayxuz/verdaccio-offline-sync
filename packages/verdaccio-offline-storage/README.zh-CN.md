# @jayxuz/verdaccio-offline-storage

[English](./README.md) | 中文

一个将本地包缓存作为一等公民的 Verdaccio 存储插件，专为离线环境设计。

> **[verdaccio-offline-storage](https://github.com/g3ngar/verdaccio-offline-storage) 的改进分支**，增强了 Verdaccio 6.x 兼容性和功能。

## 与原版的区别

这是原版 `verdaccio-offline-storage` 插件的改进分支。主要改进包括：

### Verdaccio 6.x 兼容性
- **TypeScript 重写**：完全使用 TypeScript 重写，提供更好的类型安全性和可维护性
- **更新依赖**：兼容 `@verdaccio/local-storage` 13.x 和 `@verdaccio/core` 8.x
- **双包支持**：自动检测并使用 `@verdaccio/local-storage-legacy`（Verdaccio 6.x）或 `@verdaccio/local-storage`（更新版本）

### 增强的版本处理
- **Semver 验证**：从 tarball 文件名提取版本时使用正确的 semver 验证
- **预发布版本处理**：设置 `dist-tags.latest` 时优先选择稳定版本而非预发布版本
- **健壮的排序**：使用 `semver.compare()` 而非简单字符串比较，确保版本排序准确

### 改进的错误处理
- **Async/Await**：使用现代 async/await 模式替代回调
- **优雅降级**：更好的错误处理，部分失败不会导致整个请求失败
- **详细日志**：更丰富的 debug 和 trace 日志，便于故障排查

### 代码质量
- **现代 JavaScript**：ES2020+ 特性、async/await、可选链
- **类型定义**：包含完整的 TypeScript 类型定义
- **空值安全**：对 `data.versions`、`packageAccess.proxy` 等进行正确的空值检查

## 功能特性

- **离线优先**：使 Verdaccio 的包缓存在离线时正常工作
- **无需锁文件**：如果在线时已缓存，所有依赖都能正确解析
- **透明**：与现有的 `local-storage` 缓存兼容，无需修改
- **选择性离线模式**：可以全局启用或根据 proxy 配置按包启用
- **Web 界面集成**：在 Verdaccio 的 Web 界面中列出所有本地可用的包

## 安装

```bash
npm install @jayxuz/verdaccio-offline-storage
# 或
yarn add @jayxuz/verdaccio-offline-storage
```

## 配置

编辑 Verdaccio 的 `config.yaml`：

```yaml
# 存储路径（与默认 local-storage 相同）
storage: /path/to/storage

# 使用此插件替代默认存储
store:
  '@jayxuz/verdaccio-offline-storage':
    # 可选：强制所有包使用离线模式
    offline: true
```

### 离线模式选项

**选项 1：选择性离线（默认）**

不设置 `offline: true` 时，只有未定义 `proxy` 的包才会以离线模式解析：

```yaml
packages:
  '@my-scope/*':
    access: $all
    publish: $authenticated
    # 无 proxy = 离线模式

  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs  # 有 proxy = 在线模式
```

**选项 2：全局离线**

设置 `offline: true` 时，所有包都以离线模式解析，忽略 proxy 设置：

```yaml
store:
  '@jayxuz/verdaccio-offline-storage':
    offline: true
```

## 工作原理

1. 当请求包时，插件扫描存储目录中的 `.tgz` 文件
2. 过滤包元数据，只包含有本地 tarball 的版本
3. 将 `dist-tags.latest` 更新为本地可用的最高稳定版本
4. 将修改后的元数据返回给客户端

这意味着：
- `npm install package@latest` 安装最新的**本地可用**版本
- 版本范围如 `^1.0.0` 解析为本地可用的版本
- 上游仓库不可达时不会出现网络错误

## 系统要求

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0（已在 6.x 测试）

## 从原版插件迁移

如果你正在从 `verdaccio-offline-storage` 迁移：

1. 安装此包：`npm install @jayxuz/verdaccio-offline-storage`
2. 更新 `config.yaml`：
   ```yaml
   store:
     '@jayxuz/verdaccio-offline-storage':
       # 你现有的选项
   ```
3. 重启 Verdaccio

你现有的存储数据完全兼容 - 无需迁移。

## 相关插件

本插件可与以下插件配合使用：

- **verdaccio-ingest-middleware**：从上游下载包用于离线缓存
- **verdaccio-metadata-healer**：自动修复缺失的包元数据

## 许可证

MIT

## 致谢

原版插件作者 [g3ngar](https://github.com/g3ngar/verdaccio-offline-storage)
