# verdaccio-metadata-healer

English | [中文](./README.zh-CN.md)

A Verdaccio plugin suite for automatic metadata healing, metadata sync, and differential package import in offline environments. This package provides two plugins:

1. **MetadataHealerFilter** - A filter plugin that automatically repairs missing package metadata and syncs metadata from upstream
2. **ImportMiddleware** - A middleware plugin for importing differential export packages (supports upload and local path import)

## Features

### Metadata Healer Filter
- **Automatic Metadata Repair**: Dynamically injects missing version information into package metadata
- **Tarball Scanning**: Scans storage directory for `.tgz` files and extracts metadata
- **SHA Sum Caching**: Caches computed checksums for performance
- **Auto-Update Latest Tag**: Automatically updates `dist-tags.latest` to the highest available version
- **Non-Destructive**: Repairs metadata on-the-fly without modifying original files
- **Metadata Sync** (New): Sync package metadata from upstream registry to local storage, supports single package and batch sync
- **Scoped Package Support** (New): Optimized package name extraction logic, supports `@scope/package` nested directory structure

### Import Middleware
- **Differential Import**: Import packages from export archives created by `verdaccio-ingest-middleware`
- **Local Path Import** (New): Import `.tar.gz` packages directly from server local paths via `/local` endpoint
- **Web UI**: Built-in interface for uploading and managing imports
- **Progress Tracking**: Real-time progress updates during import
- **Checksum Validation**: Validates file integrity during import
- **Import History**: Tracks all import operations
- **10GB Upload Limit** (New): File upload size limit increased from 2GB to 10GB

## Installation

```bash
npm install verdaccio-metadata-healer
# or
yarn add verdaccio-metadata-healer
```

## Configuration

### Metadata Healer Filter

Add to your Verdaccio `config.yaml`:

```yaml
filters:
  metadata-healer:
    # Enable/disable the filter (default: true)
    enabled: true
    # Storage path (optional, defaults to Verdaccio storage)
    storagePath: /path/to/storage
    # Auto-update dist-tags.latest (default: true)
    autoUpdateLatest: true
    # Cache settings
    cache:
      # Maximum cached SHA sums (default: 10000)
      maxSize: 10000
      # Cache TTL in milliseconds (default: 3600000 = 1 hour)
      ttl: 3600000
```

### Import Middleware

Add to your Verdaccio `config.yaml`:

```yaml
middlewares:
  metadata-healer:
    enabled: true
    enableImportUI: true
    # Storage path (optional, defaults to Verdaccio storage)
    storagePath: /path/to/storage
```

## How It Works

### Metadata Healing

When Verdaccio serves package metadata, the filter plugin:

1. Scans the package's storage directory for `.tgz` files
2. Compares found versions against the metadata's `versions` object
3. For missing versions, extracts `package.json` from the tarball
4. Injects the missing version information into the response
5. Updates `dist-tags.latest` if needed

This is particularly useful when:
- Packages were copied directly to storage without proper metadata
- Metadata was corrupted or incomplete
- Migrating packages from another registry

### Differential Import

The import middleware allows you to:

1. Upload `.tar.gz` export packages (created by `verdaccio-ingest-middleware`)
2. Extract and validate the contents
3. Copy packages to the correct storage locations
4. Rebuild metadata for imported packages

## API Endpoints

All endpoints are prefixed with `/_/healer/`.

### Import Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/import/upload` | Upload and import a differential package |
| POST | `/import/local` | Import `.tar.gz` packages from server local path |
| GET | `/import/status/:taskId` | Query import task status |
| GET | `/import/history` | Get import history |

### Metadata Sync Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/sync/:name` | Sync metadata for a single package |
| POST | `/sync/:scope/:name` | Sync metadata for a scoped package (e.g. `@types/node`) |
| POST | `/sync-all` | Sync metadata for all local packages (async task) |
| GET | `/sync/status/:taskId` | Query sync task status |
| GET | `/packages` | List all local packages |

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ui` | Web management interface |

## Usage Examples

### Import via API

```bash
# Upload and import a differential package
curl -X POST http://localhost:4873/_/healer/import/upload \
  -F "file=@verdaccio-export-2024-01-15.tar.gz" \
  -F "overwrite=false" \
  -F "rebuildMetadata=true" \
  -F "validateChecksum=true"

# Response: {"success": true, "taskId": "task-xxx"}

# Check import status
curl http://localhost:4873/_/healer/import/status/task-xxx

# View import history
curl http://localhost:4873/_/healer/import/history
```

### Import Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `overwrite` | boolean | false | Overwrite existing files |
| `rebuildMetadata` | boolean | true | Rebuild package metadata after import |
| `validateChecksum` | boolean | true | Validate file checksums |

### Import from Local Path

```bash
# Import packages from a local directory on the server
curl -X POST http://localhost:4873/_/healer/import/local \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/data/packages/verdaccio-export.tar.gz", "overwrite": false, "rebuildMetadata": true, "validateChecksum": true}'
```

### Metadata Sync via API

```bash
# Sync metadata for a single package
curl -X POST http://localhost:4873/_/healer/sync/lodash

# Sync metadata for a scoped package
curl -X POST http://localhost:4873/_/healer/sync/@types/node

# Sync all packages metadata (async task)
curl -X POST http://localhost:4873/_/healer/sync-all
# Response: {"success": true, "taskId": "task-xxx", "totalPackages": 100}

# Check sync task status
curl http://localhost:4873/_/healer/sync/status/task-xxx

# List all local packages
curl http://localhost:4873/_/healer/packages
```

## Web UI

Access the management interface at `http://localhost:4873/_/healer/ui` for:

- Drag-and-drop file upload
- Import from server local path
- Real-time import progress
- Import history viewing
- Task status monitoring
- Metadata sync operations (single package / batch sync)
- Package list browsing with one-click sync

## Workflow: Online to Offline Sync

This plugin is designed to work with `verdaccio-ingest-middleware` for a complete online-to-offline workflow:

1. **Online Environment** (with `verdaccio-ingest-middleware`):
   - Cache packages from upstream registry
   - Create differential export packages

2. **Transfer**: Copy export files to offline environment

3. **Offline Environment** (with `verdaccio-metadata-healer`):
   - Import differential packages via Web UI or API
   - Metadata healer automatically repairs any missing metadata
   - Packages become available for installation

## Requirements

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0

## License

MIT
