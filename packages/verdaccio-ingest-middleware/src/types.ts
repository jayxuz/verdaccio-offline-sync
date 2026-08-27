import { Manifest, Version, Dist } from '@verdaccio/types';

/**
 * 平台配置
 */
export interface PlatformConfig {
  os: 'linux' | 'win32' | 'darwin';
  arch: 'x64' | 'arm64' | 'ia32';
  libc?: 'glibc' | 'musl';
}

/**
 * 插件配置
 */
export interface IngestConfig {
  enabled: boolean;
  upstreamRegistry?: string;
  concurrency?: number;
  timeout?: number;
  platforms?: PlatformConfig[];
  sync?: SyncOptions;
  /** 下载后校验 tarball SHA-1 是否与上游 registry 一致（默认 true） */
  verifyChecksum?: boolean;
  /** tarball 最小体积（字节），低于此值视为损坏（默认 128） */
  minTarballSize?: number;
  /** 缓存状态扫描快照有效期（秒），过期后下一次 /ingest/cache 请求触发后台重建（默认 600） */
  scanCacheTtlSeconds?: number;
}

/**
 * 同步选项
 */
export interface SyncOptions {
  refreshAllMetadataBeforeAnalyze?: boolean;
  updateToLatest?: boolean;
  completeSiblingVersions?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  includeOptional?: boolean;
  maxDepth?: number;
}

/**
 * 摄取请求
 */
export interface IngestRequest {
  packages?: string[];
  all?: boolean;
}

/**
 * 同步请求
 */
export interface SyncRequest {
  platforms?: PlatformConfig[];
  options?: SyncOptions;
}

/**
 * 平台下载请求
 */
export interface PlatformDownloadRequest {
  packages: string[];
  platforms: PlatformConfig[];
}

/**
 * 已解析的包
 */
export interface ResolvedPackage {
  name: string;
  version: string;
  dist: Dist;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * 下载结果
 */
export interface DownloadResult {
  package: ResolvedPackage;
  tarballPath: string;
  tarballName: string;
  shasum: string;
  integrity: string;
  size: number;
  manifest: any;
  /** tarball 是否通过了 SHA-1 校验 */
  verified: boolean;
}

/**
 * 缓存的包信息
 */
export interface CachedPackage {
  name: string;
  versions: string[];
  dependencies: Record<string, string>;
  latestVersion?: string;
}

/**
 * 刷新后的元数据
 */
export interface RefreshedMetadata {
  name: string;
  distTags: Record<string, string>;
  versions: string[];
  latestManifest: any;
}

/**
 * 待下载的包
 */
export interface PackageToDownload {
  name: string;
  version: string;
  reason:
    | 'newer-version'
    | 'missing-dependency'
    | 'platform-binary'
    | 'sibling-version'
    | 'integrity-repair';
  /** 被哪个包依赖（用于追踪依赖链） */
  requiredBy?: string;
}

/**
 * 分析结果
 */
export interface AnalysisResult {
  analysisId: string;
  scanned: number;
  refreshed: number;
  toDownload: PackageToDownload[];
  platforms: string[];
  timestamp: number;
}

/**
 * 下载请求
 */
export interface DownloadRequest {
  analysisId?: string;
  packages: PackageToDownload[];
  platforms?: PlatformConfig[];
}

/**
 * 单个包下载状态
 */
export interface PackageDownloadStatus {
  name: string;
  version: string;
  status: 'pending' | 'downloading' | 'success' | 'failed';
  error?: string;
  size?: number;
  /** 下载是否通过了 SHA-1 校验 */
  verified?: boolean;
  /** 失败原因是否为上游已下架/不存在（重试无效） */
  upstreamMissing?: boolean;
}

/**
 * 批量下载结果
 */
export interface DownloadBatchResult {
  success: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: PackageDownloadStatus[];
  failedPackages: PackageToDownload[];
}

/**
 * 同步结果
 */
export interface SyncResult {
  success: boolean;
  scanned: number;
  refreshed: number;
  downloaded: number;
  platforms: string[];
  errors?: string[];
}

/**
 * 缓存状态
 */
export interface CacheStatus {
  totalPackages: number;
  totalVersions: number;
  packages: Array<{
    name: string;
    versions: string[];
    latestCached: string;
  }>;
}

// ==================== 完整性检查与修复相关类型 ====================

/**
 * 修复版本的选取原因
 */
export type RepairReason = 'dist-tag-latest' | 'major-latest' | 'dependent-range';

/**
 * 单个被选中待修复的版本
 */
export interface SelectedRepairVersion {
  version: string;
  /** 命中了哪些选取规则（可多个） */
  reasons: RepairReason[];
}

/**
 * 单个残缺包的修复计划
 */
export interface RepairPlanEntry {
  name: string;
  /** 元数据中列出的版本总数（仅作展示） */
  metadataVersionCount: number;
  /** 智能模式选中待下载的版本 */
  selectedVersions: SelectedRepairVersion[];
}

/**
 * 无法自动修复的包
 */
export interface UnrepairablePackage {
  name: string;
  reason: string;
}

/**
 * 完整性扫描结果
 */
export interface RepairScanResult {
  scanId: string;
  /** 扫描到的包目录总数 */
  scanned: number;
  /** 有有效 tarball 的健康包数 */
  healthy: number;
  /** 有元数据但零 tarball 的残缺包数 */
  incompleteCount: number;
  /** 智能模式合计待下载版本数 */
  totalVersionsToDownload: number;
  plans: RepairPlanEntry[];
  unrepairable: UnrepairablePackage[];
  /** 本次扫描使用的选项（回显，供修复阶段参考） */
  options?: {
    includeDependents?: boolean;
    includePrerelease?: boolean;
    versionScope?: 'smart' | 'latest';
  };
  timestamp: number;
}

/**
 * 完整性扫描请求
 */
export interface RepairScanRequest {
  options?: {
    /** 是否收集本地正常包对残缺包的依赖范围（默认 true；versionScope 为 'latest' 时忽略） */
    includeDependents?: boolean;
    /** 是否允许选中 prerelease 版本（默认 false） */
    includePrerelease?: boolean;
    /**
     * 选取范围：
     * - 'smart'：latest + 每 major 最新 + 依赖命中版本
     * - 'latest'（默认）：仅 dist-tags.latest 指向的版本
     */
    versionScope?: 'smart' | 'latest';
  };
}

/**
 * 修复请求
 */
export interface RepairRequest {
  /** 扫描结果 ID（主路径） */
  scanId?: string;
  /** 显式指定包列表（旁路，仿 DownloadRequest） */
  packages?: PackageToDownload[];
}

/**
 * 修复结果
 */
export interface RepairResult extends DownloadBatchResult {
  /** 本轮成功修复（至少一个版本下载成功）的包数 */
  repairedPackages: number;
  /** 上游已下架/不存在的失败项子集（重试无效） */
  upstreamMissing: PackageToDownload[];
}

/**
 * 分析进度详情
 */
export interface AnalysisProgress {
  /** 当前阶段 */
  phase: 'scanning' | 'refreshing' | 'analyzing' | 'detecting-binaries' | 'completed';
  /** 当前阶段进度百分比 (0-100) */
  phaseProgress: number;
  /** 总体进度百分比 (0-100) */
  totalProgress: number;
  /** 当前处理的包名 */
  currentPackage?: string;
  /** 当前阶段已处理数量 */
  processed: number;
  /** 当前阶段总数量 */
  total: number;
  /** 开始时间戳 */
  startTime: number;
  /** 预估剩余时间（毫秒） */
  estimatedRemaining?: number;
  /** 当前阶段描述 */
  phaseDescription: string;
}

/**
 * 进度回调函数类型
 */
export type ProgressCallback = (progress: AnalysisProgress) => void;

/**
 * 任务状态
 */
export interface TaskStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  message?: string;
  result?: any;
  error?: string;
  /** 详细进度信息 */
  detailedProgress?: AnalysisProgress | ExportProgress;
}

/**
 * 预定义平台组合
 */
export const PLATFORM_PRESETS: Record<string, PlatformConfig> = {
  'linux-x64': { os: 'linux', arch: 'x64', libc: 'glibc' },
  'linux-arm64': { os: 'linux', arch: 'arm64', libc: 'glibc' },
  'linux-x64-musl': { os: 'linux', arch: 'x64', libc: 'musl' },
  'win32-x64': { os: 'win32', arch: 'x64' },
  'win32-arm64': { os: 'win32', arch: 'arm64' },
  'darwin-x64': { os: 'darwin', arch: 'x64' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64' }
};

// ==================== 差分导出相关类型 ====================

/**
 * 导出历史记录文件
 */
export interface ExportHistoryFile {
  /** 文件格式版本 */
  version: 1;
  /** 导出记录列表 */
  exports: ExportRecord[];
}

/**
 * 单次导出记录
 */
export interface ExportRecord {
  /** 唯一导出 ID */
  exportId: string;
  /** 导出时间戳 (ISO 8601) */
  timestamp: string;
  /** 导出时间戳（毫秒） */
  timestampMs: number;
  /** 包含的文件数量 */
  fileCount: number;
  /** 总大小（字节） */
  totalSize: number;
  /** 导出文件名 */
  filename: string;
  /** SHA256 校验和 */
  checksum?: string;
  /** 导出类型 */
  type: 'full' | 'incremental';
  /** 增量导出的基准时间 */
  baseTimestamp?: string;
  /** 导出摘要 */
  summary: {
    packages: number;
    versions: number;
  };
}

/**
 * 导出清单（包含在 tar.gz 中）
 */
export interface ExportManifest {
  /** 清单版本 */
  version: 1;
  /** 导出 ID */
  exportId: string;
  /** 导出时间戳 */
  timestamp: string;
  /** 增量导出的基准时间 */
  baseTimestamp?: string;
  /** 导出类型 */
  type: 'full' | 'incremental';
  /** 来源系统信息 */
  source?: {
    hostname?: string;
    verdaccioVersion?: string;
    pluginVersion?: string;
  };
  /** 文件列表 */
  files: ExportFileEntry[];
  /** 统计信息 */
  stats: {
    totalFiles: number;
    totalSize: number;
    packages: number;
    versions: number;
  };
}

/**
 * 导出文件条目
 */
export interface ExportFileEntry {
  /** 相对路径（从 storage 根目录） */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件修改时间 */
  mtime: string;
  /** SHA256 校验和 */
  checksum: string;
  /** 文件类型 */
  type: 'tarball' | 'metadata';
  /** 包名（已解码） */
  packageName?: string;
  /** 版本号（仅 tarball） */
  version?: string;
}

/**
 * 扫描到的文件
 */
export interface ScannedFile {
  /** 相对路径 */
  relativePath: string;
  /** 绝对路径 */
  absolutePath: string;
  /** 文件大小 */
  size: number;
  /** 修改时间 */
  mtime: Date;
  /** 文件类型 */
  type: 'tarball' | 'metadata';
  /** 包名 */
  packageName: string;
  /** 版本号 */
  version?: string;
}

/**
 * 导出预览请求
 */
export interface ExportPreviewRequest {
  /** 基准时间（ISO 8601 或 'last' 表示上次导出时间） */
  since?: string | 'last';
  /** 是否包含元数据文件 */
  includeMetadata?: boolean;
}

/**
 * 导出预览响应
 */
export interface ExportPreviewResponse {
  success: boolean;
  /** 基准时间 */
  baseTimestamp?: string;
  /** 文件列表 */
  files: ExportFileEntry[];
  /** 统计信息 */
  stats: {
    totalFiles: number;
    totalSize: number;
    packages: number;
    versions: number;
  };
}

/**
 * 创建导出请求
 */
export interface ExportCreateRequest {
  /** 基准时间（ISO 8601 或 'last' 表示上次导出时间） */
  since?: string | 'last';
  /** 是否包含元数据文件 */
  includeMetadata?: boolean;
  /** 自定义文件名前缀 */
  filenamePrefix?: string;
}

/**
 * 导出任务结果
 */
export interface ExportTaskResult {
  /** 导出 ID */
  exportId: string;
  /** 文件名 */
  filename: string;
  /** 下载 URL */
  downloadUrl: string;
  /** 文件大小 */
  fileSize: number;
  /** 统计信息 */
  stats: {
    totalFiles: number;
    totalSize: number;
    packages: number;
    versions: number;
  };
}

/**
 * 导出进度
 */
export interface ExportProgress {
  /** 当前阶段 */
  phase: 'scanning' | 'calculating-checksums' | 'packing' | 'finalizing' | 'completed';
  /** 当前阶段进度百分比 (0-100) */
  phaseProgress: number;
  /** 总体进度百分比 (0-100) */
  totalProgress: number;
  /** 当前处理的包名 */
  currentPackage?: string;
  /** 当前阶段已处理数量 */
  processed: number;
  /** 当前阶段总数量 */
  total: number;
  /** 开始时间戳 */
  startTime: number;
  /** 预估剩余时间（毫秒） */
  estimatedRemaining?: number;
  /** 当前阶段描述 */
  phaseDescription: string;
  /** 当前处理的文件 */
  currentFile?: string;
  /** 已处理字节数 */
  bytesProcessed?: number;
  /** 总字节数 */
  totalBytes?: number;
}
