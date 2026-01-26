import { pluginUtils } from '@verdaccio/core';
import { Config, Logger, Manifest } from '@verdaccio/types';
import { StorageScanner } from './storage-scanner';
import { MetadataPatcher } from './metadata-patcher';
import { ShasumCache } from './shasum-cache';
import { HealerConfig, TarballInfo } from './types';

/**
 * Verdaccio 元数据自愈过滤器插件
 * 用于内网环境下动态修复缺失的包元数据
 */
export default class MetadataHealerFilter extends pluginUtils.Plugin<HealerConfig> {
  private logger: Logger;
  private scanner!: StorageScanner;
  private patcher: MetadataPatcher;
  private shasumCache: ShasumCache;
  private storagePath: string;
  private initialized: boolean = false;

  constructor(config: HealerConfig, options: pluginUtils.PluginOptions) {
    super(config, options);
    this.logger = options.logger;
    this.storagePath = config.storagePath || (options.config as Config).storage || './storage';
    this.patcher = new MetadataPatcher(config, this.logger);
    this.shasumCache = new ShasumCache(config, this.logger);

    this.logger.info('MetadataHealerFilter initialized');
  }

  /**
   * 延迟初始化扫描器
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      this.scanner = new StorageScanner(
        this.config as HealerConfig,
        this.storagePath,
        this.logger
      );
      this.initialized = true;
    }
  }

  /**
   * 过滤并修复元数据
   * 这是 Verdaccio Filter Plugin 的核心方法
   */
  async filter_metadata(manifest: Manifest): Promise<Manifest> {
    const config = this.config as HealerConfig;

    // 检查是否启用
    if (!config.enabled) {
      return manifest;
    }

    // 确保初始化
    this.ensureInitialized();

    const packageName = manifest.name;

    try {
      // 1. 扫描存储目录中的 .tgz 文件
      const tarballs = await this.scanner.scanPackageTarballs(packageName);

      if (tarballs.length === 0) {
        return manifest;
      }

      // 2. 对比元数据中的 versions，找出缺失的版本
      const missingVersions = this.findMissingVersions(manifest, tarballs);

      if (missingVersions.length === 0) {
        this.logger.debug(
          { packageName },
          'No missing versions for @{packageName}'
        );

        // 即使没有缺失版本，也检查 dist-tags
        if (config.autoUpdateLatest !== false) {
          this.patcher.updateDistTags(manifest);
        }

        return manifest;
      }

      this.logger.info(
        { packageName, count: missingVersions.length },
        'Found @{count} missing versions for @{packageName}'
      );

      // 3. 动态注入缺失的版本信息
      const patchedManifest = await this.patcher.patchManifest(
        manifest,
        missingVersions,
        this.shasumCache
      );

      // 4. 更新 dist-tags
      if (config.autoUpdateLatest !== false) {
        this.patcher.updateDistTags(patchedManifest);
      }

      this.logger.info(
        { packageName },
        'Successfully healed metadata for @{packageName}'
      );

      return patchedManifest;
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message },
        'Failed to heal metadata for @{packageName}: @{error}'
      );

      // 出错时返回原始 manifest，保证服务可用
      return manifest;
    }
  }

  /**
   * 找出元数据中缺失的版本
   */
  private findMissingVersions(
    manifest: Manifest,
    tarballs: TarballInfo[]
  ): TarballInfo[] {
    const existingVersions = new Set(Object.keys(manifest.versions || {}));
    return tarballs.filter((t) => !existingVersions.has(t.version));
  }

  /**
   * 清除缓存
   */
  clearCache(packageName?: string): void {
    if (this.initialized) {
      this.scanner.clearCache(packageName);
    }
    this.shasumCache.clear(packageName);
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { shasum: { size: number; max: number } } {
    return {
      shasum: this.shasumCache.getStats()
    };
  }
}
