import { Manifest, Version, Dist } from '@verdaccio/types';

/**
 * 插件配置
 */
export interface HealerConfig {
  enabled: boolean;
  storagePath?: string;
  scanCacheTTL?: number;
  shasumCacheSize?: number;
  autoUpdateLatest?: boolean;
  /** 是否在 filter_metadata 时自动保存元数据到本地（默认 true） */
  autoSaveMetadata?: boolean;
  host?: string;
  /** 是否启用导入 Web UI（需要在 middlewares 中配置） */
  enableImportUI?: boolean;
  /** Web UI 标题 */
  title?: string;
}

/**
 * Tarball 信息
 */
export interface TarballInfo {
  filename: string;
  version: string;
  path: string;
  size: number;
  mtime: Date;
}

/**
 * Shasum 缓存条目
 */
export interface ShasumCacheEntry {
  shasum: string;
  integrity: string;
  mtime: number;
}

/**
 * 扫描缓存条目
 */
export interface ScanCacheEntry {
  tarballs: TarballInfo[];
  timestamp: number;
}

/**
 * 修复结果
 */
export interface HealResult {
  packageName: string;
  healedVersions: string[];
  updatedDistTags: boolean;
}

// ==================== 差分导入相关类型 ====================

/**
 * 导入历史记录文件
 */
export interface ImportHistoryFile {
  version: 1;
  imports: ImportRecord[];
}

/**
 * 单次导入记录
 */
export interface ImportRecord {
  /** 导入 ID */
  importId: string;
  /** 导入时间戳 (ISO 8601) */
  timestamp: string;
  /** 导入时间戳（毫秒） */
  timestampMs: number;
  /** 原始导出 ID */
  sourceExportId?: string;
  /** 导入的文件数量 */
  fileCount: number;
  /** 总大小（字节） */
  totalSize: number;
  /** 原始文件名 */
  filename: string;
  /** 导入状态 */
  status: 'success' | 'partial' | 'failed';
  /** 导入摘要 */
  summary: {
    packages: number;
    versions: number;
    skipped: number;
    errors: number;
  };
  /** 错误信息（如果有） */
  errors?: string[];
}

/**
 * 导入进度
 */
export interface ImportProgress {
  /** 当前阶段 */
  phase: 'uploading' | 'extracting' | 'validating' | 'importing' | 'rebuilding' | 'completed';
  /** 当前阶段进度百分比 (0-100) */
  phaseProgress: number;
  /** 总体进度百分比 (0-100) */
  totalProgress: number;
  /** 当前处理的文件 */
  currentFile?: string;
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
 * 导入任务状态
 */
export interface ImportTaskStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  message?: string;
  result?: ImportResult;
  error?: string;
  detailedProgress?: ImportProgress;
}

/**
 * 导入结果
 */
export interface ImportResult {
  success: boolean;
  importId: string;
  /** 导入的文件数 */
  imported: number;
  /** 跳过的文件数（已存在且未覆盖） */
  skipped: number;
  /** 失败的文件数 */
  failed: number;
  /** 影响的包数 */
  packages: number;
  /** 影响的版本数 */
  versions: number;
  /** 是否触发了元数据重建 */
  metadataRebuilt: boolean;
  /** 错误列表 */
  errors?: string[];
}

/**
 * 导入选项
 */
export interface ImportOptions {
  /** 是否覆盖已存在的文件 */
  overwrite?: boolean;
  /** 是否在导入后重建元数据 */
  rebuildMetadata?: boolean;
  /** 是否验证文件校验和 */
  validateChecksum?: boolean;
}

/**
 * 导出清单（从导出包中读取）
 */
export interface ExportManifest {
  version: 1;
  exportId: string;
  timestamp: string;
  baseTimestamp?: string;
  type: 'full' | 'incremental';
  files: ExportFileEntry[];
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
  path: string;
  size: number;
  mtime: string;
  checksum: string;
  type: 'tarball' | 'metadata';
  packageName?: string;
  version?: string;
}
