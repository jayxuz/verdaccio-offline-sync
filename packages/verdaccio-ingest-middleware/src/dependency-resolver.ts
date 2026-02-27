import pacote from 'pacote';
import semver from 'semver';
import pLimit from 'p-limit';
import { Logger } from '@verdaccio/types';
import {
  IngestConfig,
  ResolvedPackage,
  SyncOptions,
  CachedPackage,
  RefreshedMetadata,
  PackageToDownload,
  ProgressCallback,
  AnalysisProgress
} from './types';

/**
 * 依赖解析器 - 解析依赖树并找出缺失的包
 *
 * 核心功能：
 * 1. 递归分析依赖树，确保所有子依赖都被正确解析
 * 2. 根据版本范围要求下载正确的版本（不一定是最新版本）
 * 3. 支持多种依赖类型：dependencies, devDependencies, peerDependencies, optionalDependencies
 *
 * 优化策略：
 * 1. 使用 packument（包含所有版本）替代 manifest（单个版本），减少请求次数
 * 2. 并发获取元数据，提高效率
 * 3. 先完整分析依赖树，再统一下载，避免重复判断
 * 4. 缓存 packument，处理交叉依赖时避免重复请求
 */
export class DependencyResolver {
  private config: IngestConfig;
  private logger: Logger;
  private registry: string;
  // 缓存 packument（包含所有版本信息），避免重复请求
  private packumentCache: Map<string, any> = new Map();
  // 正在进行中的 packument 请求（避免并发场景下重复请求同一包）
  private packumentInflight: Map<string, Promise<any | null>> = new Map();
  // 并发控制
  private concurrencyLimit: ReturnType<typeof pLimit>;

  constructor(config: IngestConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.registry = config.upstreamRegistry || 'https://registry.npmjs.org';
    this.concurrencyLimit = pLimit(config.concurrency || 5);
  }

  /**
   * 刷新包的元数据（并发版本）
   * 使用 packument 获取完整的版本信息，并缓存以供后续依赖分析使用
   */
  async refreshMetadata(
    packages: CachedPackage[],
    onProgress?: ProgressCallback
  ): Promise<RefreshedMetadata[]> {
    this.logger.info(
      { count: packages.length },
      'Refreshing metadata for @{count} packages concurrently...'
    );

    const startTime = Date.now();
    let completed = 0;
    const total = packages.length;

    // 并发获取所有包的 packument
    const tasks = packages.map((pkg) =>
      this.concurrencyLimit(async () => {
        try {
          const packument = await this.getPackument(pkg.name);

          // 更新进度
          completed++;
          if (onProgress) {
            const elapsed = Date.now() - startTime;
            const avgTimePerPkg = elapsed / completed;
            const remaining = (total - completed) * avgTimePerPkg;

            onProgress({
              phase: 'refreshing',
              phaseProgress: Math.round((completed / total) * 100),
              totalProgress: Math.round((completed / total) * 30), // 刷新阶段占总进度的30%
              currentPackage: pkg.name,
              processed: completed,
              total,
              startTime,
              estimatedRemaining: Math.round(remaining),
              phaseDescription: `刷新元数据: ${pkg.name}`
            });
          }

          if (!packument) return null;

          return {
            name: pkg.name,
            distTags: packument['dist-tags'] || {},
            versions: Object.keys(packument.versions || {}),
            latestManifest: null
          } as RefreshedMetadata;
        } catch (error: any) {
          completed++;
          this.logger.warn(
            { name: pkg.name, error: error.message },
            'Failed to refresh metadata for @{name}: @{error}'
          );
          return null;
        }
      })
    );

    const results = await Promise.all(tasks);
    const validResults = results.filter((r): r is RefreshedMetadata => r !== null);

    this.logger.info(
      { success: validResults.length, total: packages.length },
      'Refreshed metadata: @{success}/@{total} packages'
    );

    return validResults;
  }

  /**
   * 分析缺失的依赖（优化版本 - 分层批量分析）
   *
   * 优化策略：
   * 1. 分层分析：先收集当前层所有需要分析的包，批量获取 packument
   * 2. 使用 packument 缓存：避免交叉依赖导致的重复请求
   * 3. 并发获取：同一层的包并发获取元数据
   * 4. 先完整分析，再统一下载：生成完整的下载列表后再执行下载
   */
  async analyzeMissingDependencies(
    cached: CachedPackage[],
    metadata: RefreshedMetadata[],
    options: SyncOptions,
    onProgress?: ProgressCallback,
    progressStartTime?: number
  ): Promise<PackageToDownload[]> {
    type AnalysisTarget = {
      name: string;
      versionRange: string;
      requiredBy?: string;
      reason?: PackageToDownload['reason'];
    };

    const missing: PackageToDownload[] = [];
    const cachedMap = new Map(cached.map((p) => [p.name, p]));
    const metadataMap = new Map(metadata.map((m) => [m.name, m]));

    // 已处理的 name@version 组合
    const processed = new Set<string>();
    // 已分析过依赖的 name@version（避免重复分析同一版本的依赖）
    const analyzedDeps = new Set<string>();

    const startTime = progressStartTime || Date.now();

    // 当前层待处理的包
    const firstLayerMap = new Map<string, AnalysisTarget>();
    const addFirstLayerTarget = (target: AnalysisTarget): void => {
      const key = `${target.name}@${target.versionRange}`;
      if (!firstLayerMap.has(key)) {
        firstLayerMap.set(key, target);
      }
    };

    // 第一步：将本地已缓存版本作为根节点，确保会递归分析其依赖
    // 这样即使包本身不升级，也能补齐其依赖树中缺失的依赖。
    for (const pkg of cached) {
      for (const localVersion of pkg.versions) {
        addFirstLayerTarget({
          name: pkg.name,
          versionRange: localVersion,
          requiredBy: 'local-cache',
          reason: 'missing-dependency'
        });
      }
    }

    // 第二步：收集需要更新/补齐的版本作为附加根节点
    for (const pkg of cached) {
      const meta = metadataMap.get(pkg.name);
      if (!meta) continue;

      if (options.updateToLatest) {
        const latestVersion = meta.distTags.latest;
        if (latestVersion && !pkg.versions.includes(latestVersion)) {
          addFirstLayerTarget({
            name: pkg.name,
            versionRange: latestVersion,
            requiredBy: 'update-to-latest',
            reason: 'newer-version'
          });
        }
      }

      // 补全同级版本：对每个已缓存版本，查找同 minor 最新 patch 和同 major 最新 minor
      if (options.completeSiblingVersions) {
        const siblingVersions = this.findSiblingVersions(pkg.versions, meta.versions);
        for (const sibVer of siblingVersions) {
          addFirstLayerTarget({
            name: pkg.name,
            versionRange: sibVer,
            requiredBy: 'complete-sibling-versions',
            reason: 'sibling-version'
          });
        }
      }
    }

    // 当前层待处理的包
    let currentLayer = Array.from(firstLayerMap.values());

    let depth = 0;
    const maxDepth = options.maxDepth || 50;
    let totalProcessed = 0;
    // 估算总数（初始层 + 预估的依赖层）
    let estimatedTotal = currentLayer.length * 3;

    // 第二步：分层 BFS 分析
    while (currentLayer.length > 0 && depth <= maxDepth) {
      this.logger.info(
        { depth, count: currentLayer.length },
        'Analyzing layer @{depth} with @{count} packages...'
      );

      // 收集当前层所有需要获取 packument 的包名（去重）
      const packageNames = [...new Set(currentLayer.map((p) => p.name))];

      // 批量并发获取 packument
      await this.prefetchPackuments(packageNames);

      // 下一层待处理的包
      const nextLayer: AnalysisTarget[] = [];
      const nextLayerSeen = new Set<string>();

      // 处理当前层的每个包
      for (const { name, versionRange, requiredBy, reason } of currentLayer) {
        totalProcessed++;

        // 更新进度
        if (onProgress) {
          const elapsed = Date.now() - startTime;
          const avgTimePerPkg = totalProcessed > 0 ? elapsed / totalProcessed : 0;
          const remaining = Math.max(0, (estimatedTotal - totalProcessed) * avgTimePerPkg);

          onProgress({
            phase: 'analyzing',
            phaseProgress: Math.min(99, Math.round((totalProcessed / estimatedTotal) * 100)),
            totalProgress: 30 + Math.min(59, Math.round((totalProcessed / estimatedTotal) * 60)), // 分析阶段占30%-90%
            currentPackage: `${name}@${versionRange}`,
            processed: totalProcessed,
            total: estimatedTotal,
            startTime,
            estimatedRemaining: Math.round(remaining),
            phaseDescription: `分析依赖 (层级 ${depth}): ${name}`
          });
        }

        try {
          // 从缓存的 packument 中解析具体版本
          const resolvedVersion = await this.resolveVersionFromCache(name, versionRange);
          if (!resolvedVersion) {
            this.logger.warn(
              { name, versionRange },
              'Could not resolve version for @{name}@@{versionRange}'
            );
            continue;
          }

          const key = `${name}@${resolvedVersion}`;

          // 跳过已处理的包
          if (processed.has(key)) {
            continue;
          }
          processed.add(key);

          // 检查本地是否已有该版本
          const cachedPkg = cachedMap.get(name);
          const hasLocalVersion = cachedPkg?.versions.includes(resolvedVersion);

          if (!hasLocalVersion) {
            // 需要下载
            missing.push({
              name,
              version: resolvedVersion,
              reason: reason || (depth === 0 ? 'newer-version' : 'missing-dependency'),
              requiredBy
            });
          }

          // 分析该版本的依赖（避免重复分析）
          if (!analyzedDeps.has(key)) {
            analyzedDeps.add(key);

            const packument = this.packumentCache.get(name);
            const versionManifest = packument?.versions?.[resolvedVersion];

            if (versionManifest) {
              const dependencies = this.collectDependencies(versionManifest, options);

              // 收集子依赖到下一层
              for (const [depName, depRange] of Object.entries(dependencies)) {
                // 检查本地是否有满足版本范围的版本
                const depCached = cachedMap.get(depName);
                const hasSatisfyingVersion = depCached &&
                  this.hasMatchingVersion(depCached.versions, depRange as string);

                if (!hasSatisfyingVersion) {
                  const nextKey = `${depName}@${depRange}`;
                  if (nextLayerSeen.has(nextKey)) {
                    continue;
                  }
                  nextLayerSeen.add(nextKey);

                  nextLayer.push({
                    name: depName,
                    versionRange: depRange as string,
                    requiredBy: key
                  });
                }
              }
            }
          }
        } catch (error: any) {
          this.logger.warn(
            { name, versionRange, error: error.message },
            'Failed to analyze @{name}@@{versionRange}: @{error}'
          );
        }
      }

      // 更新估算总数
      estimatedTotal = totalProcessed + nextLayer.length * 2;

      // 移动到下一层
      currentLayer = nextLayer;
      depth++;
    }

    // 去重（可能有多个包依赖同一个版本）
    const uniqueMissing = this.deduplicatePackages(missing);

    this.logger.info(
      { count: uniqueMissing.length, depth },
      'Analysis complete: found @{count} missing packages across @{depth} layers'
    );

    return uniqueMissing;
  }

  /**
   * 批量预取 packument
   */
  private async prefetchPackuments(packageNames: string[]): Promise<void> {
    // 过滤出未缓存的包
    const uncached = packageNames.filter((name) => !this.packumentCache.has(name));

    if (uncached.length === 0) return;

    this.logger.debug(
      { count: uncached.length },
      'Prefetching @{count} packuments...'
    );

    // 并发获取
    const tasks = uncached.map((name) =>
      this.concurrencyLimit(async () => {
        await this.getPackument(name);
      })
    );

    await Promise.all(tasks);
  }

  /**
   * 从缓存的 packument 中解析版本
   */
  private async resolveVersionFromCache(
    name: string,
    range: string
  ): Promise<string | null> {
    const packument = this.packumentCache.get(name);
    if (!packument) {
      // 尝试获取
      const fetched = await this.getPackument(name);
      if (!fetched) return null;
    }

    const cached = this.packumentCache.get(name);
    if (!cached?.versions) return null;

    // 如果 range 是具体版本
    if (cached.versions[range]) {
      return range;
    }

    // 如果 range 是 dist-tag
    if (cached['dist-tags']?.[range]) {
      return cached['dist-tags'][range];
    }

    // 解析版本范围
    const versions = Object.keys(cached.versions);
    const matched = semver.maxSatisfying(versions, range);
    return matched;
  }

  /**
   * 去重下载列表
   */
  private deduplicatePackages(packages: PackageToDownload[]): PackageToDownload[] {
    const seen = new Map<string, PackageToDownload>();

    for (const pkg of packages) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!seen.has(key)) {
        seen.set(key, pkg);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * 精简 packument 数据，只保留分析所需的字段
   * 完整 packument 可能包含 readme、scripts 等大量无用数据，
   * 对于 7000+ 包的场景会导致内存溢出
   */
  private trimPackument(packument: any): any {
    const trimmed: any = {
      name: packument.name,
      'dist-tags': packument['dist-tags'] || {}
    };

    // 只保留每个版本的依赖相关字段和 dist 信息
    if (packument.versions) {
      trimmed.versions = {};
      for (const [ver, manifest] of Object.entries<any>(packument.versions)) {
        trimmed.versions[ver] = {
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies,
          devDependencies: manifest.devDependencies,
          peerDependencies: manifest.peerDependencies,
          optionalDependencies: manifest.optionalDependencies,
          dist: manifest.dist,
          os: manifest.os,
          cpu: manifest.cpu,
          libc: manifest.libc
        };
      }
    }

    return trimmed;
  }

  /**
   * 获取 packument（带缓存，精简存储）
   */
  private async getPackument(name: string): Promise<any | null> {
    if (this.packumentCache.has(name)) {
      return this.packumentCache.get(name);
    }

    const inflight = this.packumentInflight.get(name);
    if (inflight) {
      return inflight;
    }

    const request = (async () => {
      try {
        const packument = await pacote.packument(name, {
          registry: this.registry,
          fullMetadata: true
        });
        // 精简后再缓存，大幅减少内存占用
        const trimmed = this.trimPackument(packument);
        this.packumentCache.set(name, trimmed);
        return trimmed;
      } catch (error: any) {
        this.logger.warn(
          { name, error: error.message },
          'Failed to get packument for @{name}: @{error}'
        );
        return null;
      } finally {
        this.packumentInflight.delete(name);
      }
    })();

    this.packumentInflight.set(name, request);
    return request;
  }

  /**
   * 递归解析依赖树（完整版本）
   * 用于从零开始下载一个包及其所有依赖
   */
  async resolveTree(
    packages: string[],
    options: SyncOptions
  ): Promise<ResolvedPackage[]> {
    const resolved = new Map<string, ResolvedPackage>();
    const queue: Array<{ name: string; versionRange: string; depth: number }> = [];

    // 初始化队列
    for (const pkg of packages) {
      const { name, version } = this.parsePackageSpec(pkg);
      queue.push({ name, versionRange: version || 'latest', depth: 0 });
    }

    // BFS 遍历依赖树
    while (queue.length > 0) {
      const { name, versionRange, depth } = queue.shift()!;

      // 检查深度限制
      if (options.maxDepth && depth > options.maxDepth) {
        continue;
      }

      try {
        const manifest = await pacote.manifest(`${name}@${versionRange}`, {
          registry: this.registry,
          fullMetadata: true
        });

        const key = `${manifest.name}@${manifest.version}`;
        if (resolved.has(key)) {
          continue;
        }

        const resolvedPkg: ResolvedPackage = {
          name: manifest.name,
          version: manifest.version,
          dist: manifest.dist || { tarball: '', shasum: '' },
          dependencies: manifest.dependencies || {},
          devDependencies: options.includeDev ? manifest.devDependencies || {} : {},
          peerDependencies: options.includePeer ? manifest.peerDependencies || {} : {},
          optionalDependencies: options.includeOptional
            ? manifest.optionalDependencies || {}
            : {}
        };

        resolved.set(key, resolvedPkg);

        // 将依赖加入队列
        const allDeps = this.collectDependencies(manifest, options);

        for (const [depName, depVersion] of Object.entries(allDeps)) {
          queue.push({
            name: depName,
            versionRange: depVersion as string,
            depth: depth + 1
          });
        }

        this.logger.debug(
          { name: manifest.name, version: manifest.version },
          'Resolved @{name}@@{version}'
        );
      } catch (error: any) {
        this.logger.warn(
          { name, versionRange, error: error.message },
          'Failed to resolve @{name}@@{versionRange}: @{error}'
        );
      }
    }

    return Array.from(resolved.values());
  }

  /**
   * 收集所有需要处理的依赖
   */
  private collectDependencies(
    manifest: any,
    options: SyncOptions
  ): Record<string, string> {
    if (!manifest) return {};

    return {
      ...(manifest.dependencies || {}),
      ...(options.includeDev ? manifest.devDependencies || {} : {}),
      ...(options.includePeer ? manifest.peerDependencies || {} : {}),
      ...(options.includeOptional ? manifest.optionalDependencies || {} : {})
    };
  }

  /**
   * 检查是否有匹配的版本
   */
  private hasMatchingVersion(versions: string[], range: string): boolean {
    return versions.some((v) => {
      try {
        return semver.satisfies(v, range);
      } catch {
        return v === range;
      }
    });
  }

  /**
   * 为已缓存的版本查找同级版本（同 minor 最新 patch + 同 major 最新 minor）
   *
   * 对于每个已缓存的版本 X.Y.Z，从上游可用版本中找出：
   * 1. X.Y.* 系列中的最新稳定版本（最新 patch）
   * 2. X.*.* 系列中的最新稳定版本（最新 minor）
   *
   * 排除预发布版本，避免引入不稳定版本。
   */
  private findSiblingVersions(
    cachedVersions: string[],
    availableVersions: string[]
  ): string[] {
    const result = new Set<string>();

    // 仅考虑稳定版本（排除预发布版本）
    const stableAvailable = availableVersions.filter((v) => {
      const parsed = semver.parse(v);
      return parsed && !parsed.prerelease.length;
    });

    const cachedSet = new Set(cachedVersions);

    for (const cachedVersion of cachedVersions) {
      const parsed = semver.parse(cachedVersion);
      if (!parsed) continue;

      const major = parsed.major;
      const minor = parsed.minor;

      // 1. 查找同 minor 系列的最新 patch: X.Y.*
      const patchRange = `>=${major}.${minor}.0 <${major}.${minor + 1}.0`;
      const latestPatch = semver.maxSatisfying(stableAvailable, patchRange);
      if (latestPatch && !cachedSet.has(latestPatch)) {
        result.add(latestPatch);
      }

      // 2. 查找同 major 系列的最新 minor: X.*.*
      const minorRange = `>=${major}.0.0 <${major + 1}.0.0`;
      const latestMinor = semver.maxSatisfying(stableAvailable, minorRange);
      if (latestMinor && !cachedSet.has(latestMinor)) {
        result.add(latestMinor);
      }
    }

    return Array.from(result);
  }

  /**
   * 解析版本范围到具体版本
   */
  async resolveVersion(name: string, range: string): Promise<string> {
    const manifest = await pacote.manifest(`${name}@${range}`, {
      registry: this.registry
    });
    return manifest.version;
  }

  /**
   * 解析包规格
   */
  private parsePackageSpec(spec: string): { name: string; version?: string } {
    // 处理 scoped 包
    if (spec.startsWith('@')) {
      const lastAtIndex = spec.lastIndexOf('@');
      if (lastAtIndex > 0) {
        return {
          name: spec.substring(0, lastAtIndex),
          version: spec.substring(lastAtIndex + 1)
        };
      }
      return { name: spec };
    }

    const atIndex = spec.lastIndexOf('@');
    if (atIndex > 0) {
      return {
        name: spec.substring(0, atIndex),
        version: spec.substring(atIndex + 1)
      };
    }
    return { name: spec };
  }

  /**
   * 清除 packument 缓存
   */
  clearCache(): void {
    this.packumentCache.clear();
    this.packumentInflight.clear();
  }
}
