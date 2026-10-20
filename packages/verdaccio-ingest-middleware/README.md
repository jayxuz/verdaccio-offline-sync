# verdaccio-ingest-middleware

English | [中文](./README.zh-CN.md)

A Verdaccio middleware plugin for recursive package ingestion with multi-platform support. Designed for environments where you need to download npm packages and their dependencies from an upstream registry for later offline use.

## Features

- **Recursive Dependency Resolution**: Automatically analyzes and downloads all dependencies of cached packages
- **Multi-Platform Binary Support**: Downloads platform-specific binaries (linux-x64, win32-x64, darwin-arm64, etc.)
- **Mirror Sync v2**: Selects missing artifacts using complete inventories and SHA256, then records verified receipts; legacy v1 export is full-scope
- **Web UI**: Built-in management interface for easy operation
- **Metadata Sync UI** (New): Integrated metadata sync card in Web UI, supports syncing all packages metadata from upstream
- **Single Package Sync** (New): Sync metadata for individual packages, supports scoped packages like `@types/node`
- **Package List Browsing** (New): View all local packages and sync from the list with one click
- **Metadata Refresh Results**: Shows a busy state during refresh, the refreshed package count on completion, and errors on failure
- **Sibling Version Completion** (New): Automatically downloads the latest patch version within the same minor series and the latest minor version within the same major series for each cached version
- **Async Task Management**: Long-running operations run in background with progress tracking
- **Analysis-Confirm-Download Workflow**: Preview what will be downloaded before actually downloading
- **Dependency Chain Completion** (v1.2.5): Analyze/sync starts from locally cached versions and recursively resolves transitive dependencies (for example `A -> B -> C`)
- **Scoped Tarball Filename Compatibility** (v1.2.5): `/rebuild-index` now supports both scoped tarball formats: `package-x.y.z.tgz` and `scope-package-x.y.z.tgz`
- **Metadata Rebuild & Sync Hardening** (v1.2.5): `/sync` now persists metadata for newly downloaded packages, and `/rebuild-index` can create missing `package.json` and refresh local `dist-tags.latest`
- **Serialized Manifest Persistence** (v1.2.8): Sync, download, and rebuild metadata is persisted through Verdaccio package storage instead of direct `package.json` writes, preventing concurrent operations from overwriting each other
- **Platform Package Resolution Fix** (v1.2.9): Correctly resolves Codex platform versions expressed as npm aliases (for example `npm:@openai/codex@0.146.1-win32-x64`), Claude Code standalone platform packages, and tarball versions with multi-part platform suffixes

## Upgrading to 2.0.0

Fixes platform packages repeatedly appearing after download. `/_/ingest/mirror/ui` provides inventory reconciliation, artifact transfers, receipts and saved history. Pair it with healer 2.0.0 and set `mirrorRegistryURL` to the actual registry base URL.

Legacy `/export/*` remains available but `since` no longer filters files: exports are full-scope. Version 2.0.0 requires Node.js ≥22.9.0; mirror writes require Linux and a local POSIX filesystem. See the [migration guide](https://github.com/jayxuz/verdaccio-offline-sync/blob/main/docs/mirror-v2-migration.md).

## Installation

```bash
npm install verdaccio-ingest-middleware
# or
yarn add verdaccio-ingest-middleware
```

## Configuration

Add the plugin to your Verdaccio `config.yaml`:

```yaml
middlewares:
  ingest-middleware:
    # Upstream registry URL (optional, defaults to first uplink)
    upstreamRegistry: https://registry.npmjs.org
    # Processing concurrency for download/scan/analyze/export (default: 5)
    concurrency: 5
    # Target platforms for binary packages
    platforms:
      - os: linux
        arch: x64
      - os: win32
        arch: x64
      - os: darwin
        arch: arm64
    # Tarball integrity verification (default: true)
    verifyChecksum: true
    # Minimum tarball size in bytes (default: 128)
    minTarballSize: 128
    # Sync options
    sync:
      refreshAllMetadataBeforeAnalyze: false
      updateToLatest: false
      completeSiblingVersions: false
      includeDev: false
      includePeer: true
      includeOptional: true
      maxDepth: 10
```

## API Endpoints

All endpoints are prefixed with `/_/ingest/`.

### Package Analysis & Download

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/analyze` | Analyze dependencies (returns task ID) |
| GET | `/analysis/:analysisId` | Get analysis results |
| POST | `/download` | Download packages based on analysis |
| POST | `/retry` | Retry failed downloads |

### Metadata Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/refresh` | Refresh metadata for cached packages |
| POST | `/sync` | One-click sync: analyze + download missing deps (optional full refresh before analyze) |
| POST | `/rebuild-index` | Rebuild local metadata index |

### Platform Binaries

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/platform` | Download multi-platform binaries |

### Differential Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/export/history` | Get export history |
| POST | `/export/preview` | Preview files to export |
| POST | `/export/create` | Create export package |
| GET | `/export/download/:exportId` | Download export package |

### Status & UI

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status/:taskId` | Query task status |
| GET | `/cache` | View local cache status |
| GET | `/ui` | Web management interface |

## Usage Examples

### Analyze and Download Missing Dependencies

```bash
# Start analysis
curl -X POST http://localhost:4873/_/ingest/analyze \
  -H "Content-Type: application/json" \
  -d '{"platforms": [{"os": "linux", "arch": "x64"}]}'

# Response: {"success": true, "taskId": "task-xxx"}

# Check task status
curl http://localhost:4873/_/ingest/status/task-xxx

# When analysis completes, get results
curl http://localhost:4873/_/ingest/analysis/analysis-xxx

# Download packages
curl -X POST http://localhost:4873/_/ingest/download \
  -H "Content-Type: application/json" \
  -d '{"analysisId": "analysis-xxx"}'
```

### Export for Offline Transfer

```bash
# Legacy v1: preview the full scope; use /_/ingest/mirror/ui for incremental transfers
curl -X POST http://localhost:4873/_/ingest/export/preview \
  -H "Content-Type: application/json" \
  -d '{"includeMetadata": true}'

# Create export package
curl -X POST http://localhost:4873/_/ingest/export/create \
  -H "Content-Type: application/json" \
  -d '{"includeMetadata": true}'

# Download the export file
curl -O http://localhost:4873/_/ingest/export/download/export-xxx
```

## Web UI

Access the management interface at `http://localhost:4873/_/ingest/ui` for a visual way to:

- View cached packages
- Analyze dependencies
- Download missing packages
- Create differential exports
- Monitor task progress
- Refresh upstream metadata through ingest without enabling healer on the online instance
- Sync single package metadata with scoped package support
- Browse local package list and sync from list
- View metadata refresh status and results

## Requirements

- Node.js >= 22.9.0
- Verdaccio >= 5.0.0

## License

MIT
