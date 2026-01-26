import { Config, Logger } from '@verdaccio/types';

/**
 * Offline storage plugin configuration
 */
export interface OfflineStorageConfig extends Config {
  /** Force offline mode for all packages */
  offline?: boolean;
}

/**
 * Plugin options passed by Verdaccio
 */
export interface PluginOptions {
  config: Config;
  logger: Logger;
}
