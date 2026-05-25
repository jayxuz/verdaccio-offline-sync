import { Config, Logger } from '@verdaccio/types';

/**
 * Offline storage plugin configuration
 */
export interface OfflineStorageConfig extends Config {
  /** Force offline mode for all packages */
  offline?: boolean;
  /** 校验本地 tarball SHA-1 是否与 metadata 一致（默认 true） */
  verifyChecksum?: boolean;
  /** tarball 最小体积（字节），低于此值视为损坏（默认 128） */
  minTarballSize?: number;
}

/**
 * Plugin options passed by Verdaccio
 */
export interface PluginOptions {
  config: Config;
  logger: Logger;
}
