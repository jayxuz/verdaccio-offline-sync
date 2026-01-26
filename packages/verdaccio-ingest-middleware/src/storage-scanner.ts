import { readdir, stat, readFile } from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { createHash } from 'crypto';
import { Logger, Manifest, Version } from '@verdaccio/types';
import { CachedPackage, IngestConfig } from './types';

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
  }

  /**
   * 扫描所有已缓存的包
   */
  async scanAllPackages(): Promise<CachedPackage[]> {
    const packages: CachedPackage[] = [];

    try {
      const entries = await readdir(this.storagePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // 跳过隐藏目录和特殊文件
        if (entry.name.startsWith('.')) continue;

        // 处理 scoped 包 (@scope/package)
        if (entry.name.startsWith('@')) {
          const scopedPackages = await this.scanScopedPackages(entry.name);
          packages.push(...scopedPackages);
        } else {
          const pkg = await this.scanPackage(entry.name);
          if (pkg) {
            packages.push(pkg);
          }
        }
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

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const packageName = `${scope}/${entry.name}`;
        const pkg = await this.scanPackage(packageName);
        if (pkg) {
          packages.push(pkg);
        }
      }
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

      // 扫描 .tgz 文件获取版本列表
      for (const file of files) {
        if (file.endsWith('.tgz')) {
          const version = this.extractVersionFromFilename(packageName, file);
          if (version) {
            versions.push(version);
          }
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
   * 获取包的存储路径
   */
  private getPackagePath(packageName: string): string {
    // 处理 scoped 包名中的 /
    const safeName = packageName.replace('/', '%2f');
    return path.join(this.storagePath, safeName);
  }

  /**
   * 从文件名中提取版本号
   */
  private extractVersionFromFilename(packageName: string, filename: string): string | null {
    const baseName = filename.replace('.tgz', '');

    // 处理不同格式的 tarball 文件名
    // 例如: lodash-4.17.21.tgz, @scope-package-1.0.0.tgz
    const versionMatch = baseName.match(/-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)$/);
    if (versionMatch) {
      return versionMatch[1];
    }

    return null;
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
    const packagePath = this.getPackagePath(packageName);
    const tarballName = this.getTarballName(packageName, version);
    const tarballPath = path.join(packagePath, tarballName);

    try {
      await stat(tarballPath);
      return true;
    } catch {
      return false;
    }
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
    const packagePath = this.getPackagePath(packageName);
    const tarballName = this.getTarballName(packageName, version);
    const tarballPath = path.join(packagePath, tarballName);

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
