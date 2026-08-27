import { readdir, stat, readFile } from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { Logger, Manifest, Version } from '@verdaccio/types';
import { CachedPackage, IngestConfig } from './types';
import { extractTarballVersion } from './tarball-version';

/**
 * 包完整性信息（目录级轻量探测结果）
 */
export interface PackageIntegrityInfo {
  name: string;
  /** 通过 min-size 校验且能解析出版本号的有效 tarball 版本列表 */
  tarballVersions: string[];
  /** package.json 存在且可解析 */
  hasMetadata: boolean;
}

/**
 * 存储扫描器 - 扫描本地已缓存的包
 */
export class StorageScanner {
  private config: IngestConfig;
  private logger: Logger;
  private storagePath: string;

  constructor(config: IngestConfig, storagePath: string, logger: Logger) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;

    this.logger.info(
      { storagePath },
      '[StorageScanner] Initialized with storage path: @{storagePath}'
    );
  }

  private getScanConcurrency(): number {
    const configured = Number(this.config.concurrency);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 5;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }

  /**
   * 扫描所有已缓存的包
   */
  async scanAllPackages(): Promise<CachedPackage[]> {
    const packages: CachedPackage[] = [];

    try {
      this.logger.info(
        { storagePath: this.storagePath },
        '[StorageScanner] Scanning storage directory: @{storagePath}'
      );

      const entries = await readdir(this.storagePath, { withFileTypes: true });

      this.logger.info(
        { count: entries.length, entries: entries.map(e => e.name).slice(0, 20).join(', ') },
        '[StorageScanner] Found @{count} entries in storage: @{entries}...'
      );

      const limit = pLimit(this.getScanConcurrency());
      const scanTasks = entries.map((entry) =>
        limit(async () => {
          if (!entry.isDirectory()) return [];
          if (entry.name.startsWith('.')) return [];

          // 处理 scoped 包 (@scope/package)
          if (entry.name.startsWith('@')) {
            this.logger.debug(
              { scope: entry.name },
              '[StorageScanner] Scanning scoped packages in @{scope}'
            );
            return this.scanScopedPackages(entry.name);
          }

          const pkg = await this.scanPackage(entry.name);
          return pkg ? [pkg] : [];
        })
      );

      const scanned = await Promise.all(scanTasks);
      for (const group of scanned) {
        packages.push(...group);
      }

      this.logger.info(
        { count: packages.length },
        'Scanned @{count} cached packages'
      );

      return packages;
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to scan storage: @{error}');
      return [];
    }
  }

  /**
   * 扫描 scoped 包目录
   */
  private async scanScopedPackages(scope: string): Promise<CachedPackage[]> {
    const packages: CachedPackage[] = [];
    const scopePath = path.join(this.storagePath, scope);

    try {
      const entries = await readdir(scopePath, { withFileTypes: true });

      this.logger.info(
        { scope, scopePath, count: entries.length, entries: entries.map(e => e.name).slice(0, 10).join(', ') },
        '[StorageScanner] Scanning scope @{scope} at @{scopePath}: found @{count} entries: @{entries}'
      );

      const limit = pLimit(this.getScanConcurrency());
      const scopedTasks = entries.map((entry) =>
        limit(async () => {
          if (!entry.isDirectory()) return null;

          const packageName = `${scope}/${entry.name}`;
          const pkg = await this.scanPackage(packageName);
          if (pkg) {
            this.logger.debug(
              { packageName, versions: pkg.versions.length },
              '[StorageScanner] Found package @{packageName} with @{versions} versions'
            );
            return pkg;
          }

          this.logger.debug(
            { packageName },
            '[StorageScanner] Package @{packageName} has no .tgz files, skipping'
          );
          return null;
        })
      );

      const scopedPackages = await Promise.all(scopedTasks);
      for (const pkg of scopedPackages) {
        if (pkg) {
          packages.push(pkg);
        }
      }

      this.logger.info(
        { scope, found: packages.length },
        '[StorageScanner] Scope @{scope}: found @{found} packages with .tgz files'
      );
    } catch (error: any) {
      this.logger.warn(
        { scope, error: error.message },
        'Failed to scan scoped packages in @{scope}: @{error}'
      );
    }

    return packages;
  }

  /**
   * 扫描单个包
   */
  private async scanPackage(packageName: string): Promise<CachedPackage | null> {
    const packagePath = this.getPackagePath(packageName);

    try {
      const files = await readdir(packagePath);
      const versions: string[] = [];
      let dependencies: Record<string, string> = {};
      let latestVersion: string | undefined;

      // 找出所有 .tgz 文件
      const tgzFiles = files.filter(f => f.endsWith('.tgz'));

      this.logger.debug(
        { packageName, packagePath, totalFiles: files.length, tgzCount: tgzFiles.length, tgzFiles: tgzFiles.slice(0, 5).join(', ') },
        '[StorageScanner] Scanning package @{packageName} at @{packagePath}: @{totalFiles} files, @{tgzCount} .tgz files: @{tgzFiles}'
      );

      // 扫描 .tgz 文件获取版本列表
      const minSize = this.getMinTarballSize();
      for (const file of tgzFiles) {
        const filePath = path.join(packagePath, file);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.size < minSize) {
            this.logger.warn(
              { packageName, file, size: fileStat.size },
              '[StorageScanner] Skipping undersized tarball @{file} for @{packageName} (@{size} bytes)'
            );
            continue;
          }
        } catch {
          continue;
        }

        const version = extractTarballVersion(file);
        if (version) {
          versions.push(version);
        } else {
          this.logger.debug(
            { packageName, file },
            '[StorageScanner] Could not extract version from @{file} for @{packageName}'
          );
        }
      }

      // 读取 package.json 获取依赖信息
      const metadataPath = path.join(packagePath, 'package.json');
      try {
        const metadataContent = await readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataContent);

        // 获取 latest 版本的依赖
        latestVersion = metadata['dist-tags']?.latest;
        if (latestVersion && metadata.versions?.[latestVersion]) {
          dependencies = metadata.versions[latestVersion].dependencies || {};
        }
      } catch {
        // 元数据文件可能不存在，忽略
      }

      if (versions.length === 0) {
        return null;
      }

      return {
        name: packageName,
        versions,
        dependencies,
        latestVersion
      };
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(
          { packageName, error: error.message },
          'Failed to scan package @{packageName}: @{error}'
        );
      }
      return null;
    }
  }

  /**
   * 扫描所有包的完整性（目录级轻量探测，不解析依赖）
   *
   * 与 scanAllPackages 的区别：scanAllPackages 以 tarball 为准，零 tarball 的包
   * 返回 null（对依赖分析不可见）；本方法额外保留"有 package.json 但零有效
   * tarball"的残缺包，用于完整性检查与修复。
   */
  async scanAllPackageIntegrity(
    onProgress?: (processed: number, total: number, current: string) => void
  ): Promise<PackageIntegrityInfo[]> {
    let packageNames: string[];
    try {
      packageNames = await this.listPackageDirs();
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        'Failed to list storage directories: @{error}'
      );
      return [];
    }

    const limit = pLimit(this.getScanConcurrency());
    const total = packageNames.length;
    let processed = 0;

    const results = await Promise.all(
      packageNames.map((packageName) =>
        limit(async () => {
          const info = await this.probePackageIntegrity(packageName);
          processed++;
          if (onProgress) {
            onProgress(processed, total, packageName);
          }
          return info;
        })
      )
    );

    return results.filter((info): info is PackageIntegrityInfo => info !== null);
  }

  /**
   * 枚举存储中的所有包目录（scoped 展开为 @scope/name）
   */
  private async listPackageDirs(): Promise<string[]> {
    const names: string[] = [];
    const entries = await readdir(this.storagePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      if (entry.name.startsWith('@')) {
        const scopePath = path.join(this.storagePath, entry.name);
        let scopedEntries;
        try {
          scopedEntries = await readdir(scopePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of scopedEntries) {
          if (sub.isDirectory() && !sub.name.startsWith('.')) {
            names.push(`${entry.name}/${sub.name}`);
          }
        }
      } else {
        names.push(entry.name);
      }
    }

    return names;
  }

  /**
   * 探测单个包的完整性：统计有效 tarball 版本、探测 package.json 是否可用
   */
  private async probePackageIntegrity(packageName: string): Promise<PackageIntegrityInfo | null> {
    const packagePath = this.getPackagePath(packageName);

    let files: string[];
    try {
      files = await readdir(packagePath);
    } catch {
      return null;
    }

    const tgzFiles = files.filter((f) => f.endsWith('.tgz'));
    const hasMetadataFile = files.includes('package.json');
    // 空目录/非包目录不纳入结果
    if (tgzFiles.length === 0 && !hasMetadataFile) {
      return null;
    }

    // 与 scanPackage 相同的有效性校验：min-size + 可提取版本
    const minSize = this.getMinTarballSize();
    const tarballVersions: string[] = [];
    for (const file of tgzFiles) {
      const filePath = path.join(packagePath, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size < minSize) {
          continue;
        }
      } catch {
        continue;
      }

      const version = extractTarballVersion(file);
      if (version) {
        tarballVersions.push(version);
      }
    }

    // 只探测"存在且可解析"，不保留内容（省内存）
    let hasMetadata = false;
    if (hasMetadataFile) {
      try {
        JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf-8'));
        hasMetadata = true;
      } catch {
        hasMetadata = false;
      }
    }

    return { name: packageName, tarballVersions, hasMetadata };
  }

  /**
   * 获取包的存储路径
   * 支持两种目录结构：
   * 1. 嵌套结构: @babel/core (Verdaccio 默认)
   * 2. 编码结构: @babel%2fcore
   */
  private getPackagePath(packageName: string): string {
    // 对于 scoped 包，优先使用嵌套结构
    if (packageName.includes('/')) {
      // 嵌套结构: @babel/core -> @babel/core
      const nestedPath = path.join(this.storagePath, packageName);
      return nestedPath;
    }
    // 非 scoped 包直接返回
    return path.join(this.storagePath, packageName);
  }

  /**
   * 检查包是否存在
   */
  async hasPackage(packageName: string): Promise<boolean> {
    const packagePath = this.getPackagePath(packageName);
    try {
      await stat(packagePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查特定版本是否存在
   */
  async hasVersion(packageName: string, version: string): Promise<boolean> {
    const resolved = await this.resolveTarballPath(packageName, version);
    return !!resolved;
  }

  /**
   * 获取 tarball 文件名
   */
  private getTarballName(packageName: string, version: string): string {
    // 处理 scoped 包名
    const baseName = packageName.replace('@', '').replace('/', '-');
    return `${baseName}-${version}.tgz`;
  }

  /**
   * 读取包的 packument (package.json 元数据)
   */
  async readPackument(packageName: string): Promise<Manifest | null> {
    const packagePath = this.getPackagePath(packageName);
    const metadataPath = path.join(packagePath, 'package.json');

    try {
      const content = await readFile(metadataPath, 'utf-8');
      return JSON.parse(content) as Manifest;
    } catch {
      return null;
    }
  }

  /**
   * 从 tarball 中提取版本元数据
   */
  async extractVersionFromTarball(
    packageName: string,
    version: string
  ): Promise<Version | null> {
    const resolved = await this.resolveTarballPath(packageName, version);
    if (!resolved) {
      this.logger.warn(
        { packageName, version },
        'Tarball file not found for @{packageName}@@{version}'
      );
      return null;
    }

    const { tarballName, tarballPath } = resolved;

    try {
      // 计算 shasum 和 integrity
      const { shasum, integrity } = await this.computeHashes(tarballPath);

      // 从 tarball 中提取 package.json
      const packageJson = await this.extractPackageJsonFromTarball(tarballPath);

      if (!packageJson) {
        this.logger.warn(
          { packageName, version },
          'Could not extract package.json from tarball for @{packageName}@@{version}'
        );
        return null;
      }

      // 构建 Version 对象
      const versionMeta = {
        name: packageJson.name || packageName,
        version: packageJson.version || version,
        description: packageJson.description,
        main: packageJson.main,
        scripts: packageJson.scripts,
        dependencies: packageJson.dependencies || {},
        devDependencies: packageJson.devDependencies,
        peerDependencies: packageJson.peerDependencies,
        optionalDependencies: packageJson.optionalDependencies,
        engines: packageJson.engines,
        repository: packageJson.repository,
        keywords: packageJson.keywords,
        author: packageJson.author,
        license: packageJson.license,
        readme: packageJson.readme || '',
        _id: `${packageJson.name || packageName}@${packageJson.version || version}`,
        _npmUser: packageJson._npmUser || {},
        dist: {
          shasum,
          integrity,
          tarball: `${packageName}/-/${tarballName}`
        }
      } as Version;

      return versionMeta;
    } catch (error: any) {
      this.logger.error(
        { packageName, version, error: error.message },
        'Failed to extract version from tarball for @{packageName}@@{version}: @{error}'
      );
      return null;
    }
  }

  /**
   * 解析 tarball 实际路径，兼容两种 scoped 包命名：
   * 1) package-1.0.0.tgz
   * 2) scope-package-1.0.0.tgz
   */
  private async resolveTarballPath(
    packageName: string,
    version: string
  ): Promise<{ tarballName: string; tarballPath: string } | null> {
    const packagePath = this.getPackagePath(packageName);
    const candidates = this.getTarballNameCandidates(packageName, version);

    for (const tarballName of candidates) {
      const tarballPath = path.join(packagePath, tarballName);
      try {
        await stat(tarballPath);
        return { tarballName, tarballPath };
      } catch {
        // 尝试下一候选
      }
    }

    // 回退：遍历目录按版本匹配，兼容历史导入文件名
    try {
      const files = await readdir(packagePath);
      const suffix = `-${version}.tgz`;
      const matched = files.find((file) => file.endsWith(suffix));
      if (matched) {
        return {
          tarballName: matched,
          tarballPath: path.join(packagePath, matched)
        };
      }
    } catch {
      // 目录不存在或不可访问
    }

    return null;
  }

  private getTarballNameCandidates(packageName: string, version: string): string[] {
    const scopedStyle = this.getTarballName(packageName, version);
    const unscopedName = packageName.includes('/')
      ? packageName.split('/').pop() || packageName.replace('@', '')
      : packageName;
    const unscopedStyle = `${unscopedName}-${version}.tgz`;
    return Array.from(new Set([scopedStyle, unscopedStyle]));
  }

  private getMinTarballSize(): number {
    const configured = Number(this.config.minTarballSize);
    return Number.isFinite(configured) && configured > 0 ? configured : 128;
  }

  /**
   * 计算文件的 shasum 和 integrity
   */
  private async computeHashes(
    filePath: string
  ): Promise<{ shasum: string; integrity: string }> {
    return new Promise((resolve, reject) => {
      const sha1 = createHash('sha1');
      const sha512 = createHash('sha512');
      const stream = createReadStream(filePath);

      stream.on('data', (chunk: Buffer | string) => {
        sha1.update(chunk);
        sha512.update(chunk);
      });

      stream.on('end', () => {
        const shasum = sha1.digest('hex');
        const integrity = 'sha512-' + sha512.digest('base64');
        resolve({ shasum, integrity });
      });

      stream.on('error', reject);
    });
  }

  /**
   * 从 tarball 中提取 package.json
   */
  private async extractPackageJsonFromTarball(
    tarballPath: string
  ): Promise<any | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let foundPackageJson = false;
      let currentFile = '';
      let currentSize = 0;
      let bytesRead = 0;

      const stream = createReadStream(tarballPath)
        .pipe(createGunzip());

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          // 简单的 tar 解析 - 查找 package.json
          let offset = 0;

          while (offset < buffer.length - 512) {
            // 读取文件名 (前 100 字节)
            const nameEnd = buffer.indexOf(0, offset);
            const name = buffer.slice(offset, Math.min(nameEnd, offset + 100)).toString('utf-8');

            if (!name || name.trim() === '') {
              break;
            }

            // 读取文件大小 (字节 124-135, 八进制)
            const sizeStr = buffer.slice(offset + 124, offset + 136).toString('utf-8').trim();
            const size = parseInt(sizeStr, 8) || 0;

            // 检查是否是 package.json
            if (name.endsWith('package.json') && name.split('/').length === 2) {
              // 数据从 512 字节头之后开始
              const dataStart = offset + 512;
              const content = buffer.slice(dataStart, dataStart + size).toString('utf-8');
              try {
                resolve(JSON.parse(content));
                return;
              } catch {
                // 继续查找
              }
            }

            // 移动到下一个文件 (512 字节头 + 数据，对齐到 512 字节)
            const dataBlocks = Math.ceil(size / 512);
            offset += 512 + dataBlocks * 512;
          }

          resolve(null);
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', reject);
    });
  }
}
