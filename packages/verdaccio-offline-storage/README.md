# @jayxuz/verdaccio-offline-storage

English | [中文](./README.zh-CN.md)

A Verdaccio storage plugin that treats local package cache as first class citizen for offline environments.

> **Fork of [verdaccio-offline-storage](https://github.com/g3ngar/verdaccio-offline-storage)** with improvements for Verdaccio 6.x compatibility and enhanced functionality.

## What's Different from the Original?

This is an improved fork of the original `verdaccio-offline-storage` plugin. Key improvements include:

### Verdaccio 6.x Compatibility
- **TypeScript Rewrite**: Fully rewritten in TypeScript for better type safety and maintainability
- **Updated Dependencies**: Compatible with `@verdaccio/local-storage` 13.x and `@verdaccio/core` 8.x
- **Dual Package Support**: Automatically detects and uses either `@verdaccio/local-storage-legacy` (Verdaccio 6.x) or `@verdaccio/local-storage` (newer versions)

### Enhanced Version Handling
- **Semver Validation**: Uses proper semver validation when extracting versions from tarball filenames
- **Prerelease Handling**: Prefers stable versions over prereleases when setting `dist-tags.latest`
- **Robust Sorting**: Uses `semver.compare()` instead of simple string comparison for accurate version ordering

### Improved Error Handling
- **Async/Await**: Uses modern async/await patterns with Promises instead of callbacks
- **Graceful Degradation**: Better error handling that doesn't break the entire request on partial failures
- **Detailed Logging**: More informative debug and trace logs for troubleshooting

### Metadata Operation Tracking (New in v3.1.0)
- **savePackage Override**: Tracks metadata save operations with detailed logging (version count, dist-tags, latest version)
- **updatePackage Override**: Monitors metadata update flow with before/after version tracking
- **Improved Offline Detection**: Enhanced `readPackage` logic with better null safety for `getMatchedPackagesSpec`
- **Storage Path Logging**: `getPackageStorage` now logs package storage path creation for debugging

### Code Quality
- **Modern JavaScript**: ES2020+ features, async/await, optional chaining
- **Type Definitions**: Full TypeScript type definitions included
- **Null Safety**: Proper null checks for `data.versions`, `packageAccess.proxy`, etc.

## Features

- **Offline-First**: Makes Verdaccio's package cache work properly when going offline
- **No Lockfile Required**: All dependencies resolve correctly if they were cached when online
- **Transparent**: Works with existing `local-storage` cache without modifications
- **Selective Offline Mode**: Can be enabled globally or per-package based on proxy configuration
- **Web UI Integration**: Lists all locally available packages in Verdaccio's web interface

## Installation

```bash
npm install @jayxuz/verdaccio-offline-storage
# or
yarn add @jayxuz/verdaccio-offline-storage
```

## Configuration

Edit your Verdaccio `config.yaml`:

```yaml
# Storage path (same as default local-storage)
storage: /path/to/storage

# Use this plugin instead of default storage
store:
  '@jayxuz/verdaccio-offline-storage':
    # Optional: force offline mode for ALL packages
    offline: true
```

### Offline Mode Options

**Option 1: Selective Offline (Default)**

Without `offline: true`, packages are resolved in offline mode only when they have no `proxy` defined:

```yaml
packages:
  '@my-scope/*':
    access: $all
    publish: $authenticated
    # No proxy = offline mode

  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs  # Has proxy = online mode
```

**Option 2: Global Offline**

With `offline: true`, ALL packages are resolved in offline mode regardless of proxy settings:

```yaml
store:
  '@jayxuz/verdaccio-offline-storage':
    offline: true
```

## How It Works

1. When a package is requested, the plugin scans the storage directory for `.tgz` files
2. It filters the package metadata to only include versions that have local tarballs
3. It updates `dist-tags.latest` to the highest locally available stable version
4. The modified metadata is returned to the client

This means:
- `npm install package@latest` installs the latest **locally available** version
- Version ranges like `^1.0.0` resolve to locally available versions
- No network errors when upstream registry is unreachable

## Requirements

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0 (tested with 6.x)

## Migration from Original Plugin

If you're migrating from `verdaccio-offline-storage`:

1. Install this package: `npm install @jayxuz/verdaccio-offline-storage`
2. Update your `config.yaml`:
   ```yaml
   store:
     '@jayxuz/verdaccio-offline-storage':
       # your existing options
   ```
3. Restart Verdaccio

Your existing storage data is fully compatible - no migration needed.

## Related Plugins

This plugin works well with:

- **verdaccio-ingest-middleware**: Download packages from upstream for offline caching
- **verdaccio-metadata-healer**: Automatically repair missing package metadata

## License

MIT

## Credits

Original plugin by [g3ngar](https://github.com/g3ngar/verdaccio-offline-storage)
