/**
 * verdaccio-offline-storage
 *
 * A Verdaccio storage plugin that treats local package cache as first class citizen.
 * Provides only locally available versions of packages for offline environments.
 *
 * @see https://github.com/g3ngar/verdaccio-offline-storage
 */

import OfflineStoragePlugin from './OfflineStoragePlugin';
import { OfflinePackageStorage } from './OfflinePackageStorage';
import { OfflineStorageConfig, PluginOptions } from './types';

export default OfflineStoragePlugin;
export { OfflineStoragePlugin, OfflinePackageStorage, OfflineStorageConfig, PluginOptions };
