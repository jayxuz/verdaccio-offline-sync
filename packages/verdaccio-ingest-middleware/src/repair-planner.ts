import semver from 'semver';
import { RepairReason, SelectedRepairVersion } from './types';

/**
 * 修复计划器 - 纯函数模块（零 I/O）
 *
 * 为"有元数据但零 tarball"的残缺包智能选取需要补下载的版本：
 * 1. dist-tags.latest 指向的版本
 * 2. 每个 major 的最新稳定版
 * 3. 被本地其他包依赖范围命中的版本（maxSatisfying）
 */

/**
 * 依赖范围收集的字段（不含 devDependencies，与 sync 默认 includeDev: false 一致）
 */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

export interface SelectRepairVersionsOptions {
  /** 是否允许选中 prerelease 版本（默认 false；dist-tag 显式指向的不受此限） */
  includePrerelease?: boolean;
  /**
   * 选取范围：
   * - 'smart'（默认）：latest + 每 major 最新 + 依赖命中版本
   * - 'latest'：仅 dist-tags.latest 指向的版本
   */
  versionScope?: 'smart' | 'latest';
}

/**
 * 从单个正常包的 packument 中收集对目标包（残缺包）的依赖范围
 *
 * @param packument 正常包的 package.json 内容（调用方用后可弃）
 * @param targetNames 残缺包名集合（含 scope，如 @babel/core）
 * @param into 累积结果：残缺包名 -> 依赖范围集合
 */
export function collectRangesFromPackument(
  packument: any,
  targetNames: Set<string>,
  into: Map<string, Set<string>>
): void {
  if (!packument || typeof packument !== 'object') {
    return;
  }
  const versions = packument.versions;
  if (!versions || typeof versions !== 'object') {
    return;
  }

  for (const versionMeta of Object.values(versions)) {
    if (!versionMeta || typeof versionMeta !== 'object') {
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const deps = (versionMeta as Record<string, any>)[field];
      if (!deps || typeof deps !== 'object') {
        continue;
      }
      for (const [depName, range] of Object.entries(deps)) {
        if (!targetNames.has(depName)) {
          continue;
        }
        if (typeof range !== 'string' || range.trim().length === 0) {
          continue;
        }
        let bucket = into.get(depName);
        if (!bucket) {
          bucket = new Set<string>();
          into.set(depName, bucket);
        }
        bucket.add(range.trim());
      }
    }
  }
}

/**
 * 为单个残缺包选取待补下载的版本
 *
 * @param packument 残缺包本地的 package.json（需要 versions 与 dist-tags 字段）
 * @param dependentRanges 本地其他包对它的依赖范围集合
 */
export function selectRepairVersions(
  packument: any,
  dependentRanges: Iterable<string>,
  options: SelectRepairVersionsOptions = {}
): SelectedRepairVersion[] {
  const includePrerelease = options.includePrerelease === true;

  const versionsObj = packument && typeof packument === 'object' ? packument.versions : null;
  if (!versionsObj || typeof versionsObj !== 'object') {
    return [];
  }

  const allVersions = Object.keys(versionsObj).filter((v) => semver.valid(v));
  if (allVersions.length === 0) {
    return [];
  }
  const versionSet = new Set(allVersions);

  const distTags =
    packument['dist-tags'] && typeof packument['dist-tags'] === 'object'
      ? (packument['dist-tags'] as Record<string, string>)
      : {};

  const selected = new Map<string, Set<RepairReason>>();
  const add = (version: string | undefined | null, reason: RepairReason): void => {
    if (!version || !versionSet.has(version)) {
      return;
    }
    let reasons = selected.get(version);
    if (!reasons) {
      reasons = new Set<RepairReason>();
      selected.set(version, reasons);
    }
    reasons.add(reason);
  };

  // 规则 1：dist-tags.latest（显式意图，指向 prerelease 也照选）
  if (typeof distTags.latest === 'string') {
    add(distTags.latest, 'dist-tag-latest');
  }

  // 'latest' 模式只补最新版，跳过 major 与依赖命中规则
  if (options.versionScope === 'latest') {
    return [...selected.entries()]
      .map(([version, reasons]) => ({ version, reasons: [...reasons] }))
      .sort((a, b) => semver.rcompare(a.version, b.version));
  }

  // 规则 2：每个 major 的最新稳定版；纯 prerelease 的 major 默认跳过
  const byMajor = new Map<number, string[]>();
  for (const version of allVersions) {
    const major = semver.major(version);
    const list = byMajor.get(major);
    if (list) {
      list.push(version);
    } else {
      byMajor.set(major, [version]);
    }
  }
  for (const list of byMajor.values()) {
    const stable = list.filter((v) => !semver.prerelease(v));
    const candidates = stable.length > 0 ? stable : includePrerelease ? list : [];
    if (candidates.length > 0) {
      add(candidates.sort(semver.rcompare)[0], 'major-latest');
    }
  }

  // 规则 3：被本地其他包依赖范围命中的版本
  for (const rawRange of dependentRanges) {
    add(
      resolveRangeToVersion(rawRange, allVersions, versionSet, distTags, includePrerelease),
      'dependent-range'
    );
  }

  return [...selected.entries()]
    .map(([version, reasons]) => ({ version, reasons: [...reasons] }))
    .sort((a, b) => semver.rcompare(a.version, b.version));
}

/**
 * 把一个依赖范围解析为 versions 列表中的具体版本
 */
function resolveRangeToVersion(
  rawRange: string,
  allVersions: string[],
  versionSet: Set<string>,
  distTags: Record<string, string>,
  includePrerelease: boolean
): string | undefined {
  let range = rawRange.trim();
  if (range.length === 0) {
    return undefined;
  }

  // npm alias：npm:real-pkg@^1.2.3 -> 取最后一个 @ 之后的部分
  if (range.startsWith('npm:')) {
    const lastAt = range.lastIndexOf('@');
    if (lastAt < 0) {
      return undefined;
    }
    range = range.slice(lastAt + 1).trim();
    if (range.length === 0) {
      return undefined;
    }
  }

  // 精确版本
  if (versionSet.has(range)) {
    return range;
  }

  // dist-tag（如 latest / beta / next）
  if (typeof distTags[range] === 'string') {
    return distTags[range];
  }

  // 非 registry 来源的 range 无法解析，静默跳过
  if (/^(git|file|link|workspace|https?|portal):/i.test(range)) {
    return undefined;
  }

  // 常规 semver range
  try {
    return semver.maxSatisfying(allVersions, range, { includePrerelease }) ?? undefined;
  } catch {
    return undefined;
  }
}
