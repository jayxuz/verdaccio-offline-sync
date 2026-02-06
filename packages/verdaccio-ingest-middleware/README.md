# verdaccio-ingest-middleware

English | [中文](./README.zh-CN.md)

A Verdaccio middleware plugin for recursive package ingestion with multi-platform support. Designed for environments where you need to download npm packages and their dependencies from an upstream registry for later offline use.

## Features

- **Recursive Dependency Resolution**: Automatically analyzes and downloads all dependencies of cached packages
- **Multi-Platform Binary Support**: Downloads platform-specific binaries (linux-x64, win32-x64, darwin-arm64, etc.)
- **Differential Export**: Export only new/modified packages since last export for efficient offline sync
- **Web UI**: Built-in management interface for easy operation
- **Metadata Sync UI** (New): Integrated metadata sync card in Web UI, supports syncing all packages metadata from upstream
- **Single Package Sync** (New): Sync metadata for individual packages, supports scoped packages like `@types/node`
- **Package List Browsing** (New): View all local packages and sync from the list with one click
- **Sync Progress Display** (New): Real-time sync progress with processed count, total, and failure statistics
- **Sibling Version Completion** (New): Automatically downloads the latest patch version within the same minor series and the latest minor version within the same major series for each cached version
- **Async Task Management**: Long-running operations run in background with progress tracking
- **Analysis-Confirm-Download Workflow**: Preview what will be downloaded before actually downloading

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
    # Download concurrency (default: 5)
    concurrency: 5
    # Target platforms for binary packages
    platforms:
      - os: linux
        arch: x64
      - os: win32
        arch: x64
      - os: darwin
        arch: arm64
    # Sync options
    sync:
      updateToLatest: true
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
| POST | `/sync` | Full sync: refresh + download missing deps |
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
# Preview what will be exported (since last export)
curl -X POST http://localhost:4873/_/ingest/export/preview \
  -H "Content-Type: application/json" \
  -d '{"since": "last"}'

# Create export package
curl -X POST http://localhost:4873/_/ingest/export/create \
  -H "Content-Type: application/json" \
  -d '{"since": "last"}'

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
- Sync all packages metadata (calls `verdaccio-metadata-healer` sync API)
- Sync single package metadata with scoped package support
- Browse local package list and sync from list
- View sync progress and results

## Requirements

- Node.js >= 18.0.0
- Verdaccio >= 5.0.0

## License

MIT
