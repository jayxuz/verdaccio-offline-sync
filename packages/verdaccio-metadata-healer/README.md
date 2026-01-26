# verdaccio-metadata-healer

English | [中文](./README.zh-CN.md)

A Verdaccio plugin suite for automatic metadata healing and differential package import in offline environments. This package provides two plugins:

1. **MetadataHealerFilter** - A filter plugin that automatically repairs missing package metadata
2. **ImportMiddleware** - A middleware plugin for importing differential export packages

## Features

### Metadata Healer Filter
- **Automatic Metadata Repair**: Dynamically injects missing version information into package metadata
- **Tarball Scanning**: Scans storage directory for `.tgz` files and extracts metadata
- **SHA Sum Caching**: Caches computed checksums for performance
- **Auto-Update Latest Tag**: Automatically updates `dist-tags.latest` to the highest available version
- **Non-Destructive**: Repairs metadata on-the-fly without modifying original files

### Import Middleware
- **Differential Import**: Import packages from export archives created by `verdaccio-ingest-middleware`
- **Web UI**: Built-in interface for uploading and managing imports
- **Progress Tracking**: Real-time progress updates during import
- **Checksum Validation**: Validates file integrity during import
- **Import History**: Tracks all import operations

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/import/upload` | Upload and import a differential package |
| GET | `/import/status/:taskId` | Query import task status |
| GET | `/import/history` | Get import history |
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

## Web UI

Access the import interface at `http://localhost:4873/_/healer/ui` for:

- Drag-and-drop file upload
- Real-time import progress
- Import history viewing
- Task status monitoring

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
