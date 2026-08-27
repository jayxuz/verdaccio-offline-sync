# Verdaccio Offline Sync

English | [中文](./README.md)

[![npm version - ingest-middleware](https://img.shields.io/npm/v/verdaccio-ingest-middleware.svg?label=ingest-middleware)](https://www.npmjs.com/package/verdaccio-ingest-middleware)
[![npm version - metadata-healer](https://img.shields.io/npm/v/verdaccio-metadata-healer.svg?label=metadata-healer)](https://www.npmjs.com/package/verdaccio-metadata-healer)
[![npm version - offline-storage](https://img.shields.io/npm/v/@jayxuz/verdaccio-offline-storage.svg?label=offline-storage)](https://www.npmjs.com/package/@jayxuz/verdaccio-offline-storage)
[![Docker Image Version](https://img.shields.io/docker/v/jayxuz/verdaccio-offline-sync?label=docker)](https://hub.docker.com/r/jayxuz/verdaccio-offline-sync)
[![Docker Pulls](https://img.shields.io/docker/pulls/jayxuz/verdaccio-offline-sync)](https://hub.docker.com/r/jayxuz/verdaccio-offline-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Say Goodbye to Air-Gapped Dependency Nightmares**
>
> Still manually zipping `node_modules` and praying it works after extraction?
> Still re-importing the project's full dependency bundle just to update one package?
> Still pulling your hair out over platform compatibility issues with esbuild, sharp, and other native modules?
> Still staring at `npm install` errors wondering which dependency is missing?
>
> **Verdaccio Offline Sync** makes npm dependency synchronization between networks simple:
> - Smart dependency tree analysis, one-click download of all missing packages
> - Incremental export, only transfer new and changed files
> - Automatic handling of multi-platform binaries
> - Self-healing metadata, import and use immediately

**Verdaccio Offline NPM Dependency Management Plugin Suite** - An npm package synchronization solution designed for air-gapped environments.

## Key Features

- **Recursive Dependency Download** - Automatically analyzes and downloads complete dependency trees
- **Multi-Platform Binary Support** - Supports Linux/Windows/macOS with x64/arm64 architectures
- **Incremental Sync** - Smart incremental updates based on cached packages
- **Differential Export/Import** - Supports time-based differential package export and import
- **Visual Management Interface** - Built-in Web UI with analyze-confirm-download workflow
- **Real-time Progress Tracking** - Displays detailed progress and estimated remaining time
- **Metadata Self-Healing** - Automatically repairs missing package metadata in offline environments
- **Metadata Sync** - Sync package metadata from upstream registry to local storage, supports single package and batch sync
- **Sibling Version Completion** - Automatically downloads the latest patch within the same minor and the latest minor within the same major
- **Local Path Import** - Import differential packages directly from server local paths
- **Dependency Chain & Rebuild Hardening** - Fixes missing transitive dependency downloads and improves metadata persistence in `/ingest/sync` and `/ingest/rebuild-index`
- **Concurrent Manifest Write Protection** - Serializes metadata from sync and rebuild operations through Verdaccio package storage, preventing concurrent direct `package.json` writes from overwriting each other
- **Local Manifest Normalization** - Repairs missing or invalid `versions`, `dist-tags`, attachments, distfiles, and related map fields before reads and writes for compatibility with historical caches
- **Scoped Tarball Filename Compatibility** - Supports both `package-x.y.z.tgz` and `scope-package-x.y.z.tgz` naming styles
- **Special Platform Package Compatibility** - Supports Codex npm-alias platform versions, Claude Code standalone platform packages, and multi-part version suffixes such as `0.146.1-win32-x64`
- **Historical Cache Rebuild** - Healer can rebuild metadata and the local package list entirely offline for previously imported or downloaded caches and can be run repeatedly
- **Integrity Verification** - Auto-validates tarball SHA-1 checksums after download to prevent corrupt packages from polluting local cache; verifies file integrity during local version resolution and auto-removes corrupt files
- **Integrity Check & Repair** - One-click scan for incomplete packages that have metadata but zero tarballs (produced by unconfirmed analysis pre-writes, proxy metadata caching, etc.), smartly selects latest, per-major newest, and dependency-hit versions to re-download, with 404 classification and retry support

## Plugin Components

| Plugin | Deployment | Function |
|--------|------------|----------|
| `@jayxuz/verdaccio-offline-storage` | Online/Offline | Base storage layer with offline version resolution |
| `verdaccio-ingest-middleware` | Online | Recursive ingestion middleware with Web UI, differential export, and sibling version completion |
| `verdaccio-metadata-healer` | Offline | Metadata self-healing filter with differential import, local path import, and metadata sync |

### Web UI Management Interface

<p align="center">
  <img src="./pic/web-ui.png" alt="Web UI" width="80%">
</p>

### Differential Export

<p align="center">
  <img src="./pic/diff-export.png" alt="Differential Export" width="80%">
</p>

### Differential Import

<p align="center">
  <img src="./pic/diff-import.png" alt="Differential Import" width="80%">
</p>

## Quick Start

### Using Docker Image (Recommended)

We provide a pre-built Docker image with all plugins included, ready to use:

```bash
# Set data directory
export V_PATH=/path/to/verdaccio

# Start container
docker run -it --name verdaccio \
  -p 4873:4873 \
  -v $V_PATH/conf:/verdaccio/conf \
  -v $V_PATH/storage:/verdaccio/storage \
  jayxuz/verdaccio-offline-sync
```

Directory structure:
```
$V_PATH/
├── conf/
│   └── config.yaml    # Configuration file (online or offline config)
└── storage/
    └── data/          # Package storage directory
```

> Tip: Use different configuration files to distinguish between online/offline environments. See configuration examples below.

#### Build and Publish the Docker Image

Docker tags are read automatically from the root `package.json` version. For example, version `1.2.9` builds and pushes both:

- `jayxuz/verdaccio-offline-sync:1.2.9`
- `jayxuz/verdaccio-offline-sync:latest`

```bash
# Sign in to Docker Hub before the first publish
docker login

# Build both tags only
npm run docker:build

# Push both previously built tags
npm run docker:push

# Build and push
npm run docker:publish
```

---

### Manual Installation

If not using Docker, you can install plugins manually:

#### 1. Install Prerequisites

```bash
# Install offline storage plugin (required)
npm install -g @jayxuz/verdaccio-offline-storage
```

#### 2. Install Plugins

```bash
# Online environment
npm install -g verdaccio-ingest-middleware

# Offline environment
npm install -g verdaccio-metadata-healer
```

### Online and Offline Configuration Roles

Online proxy caching and offline consumption/import are mutually exclusive deployment roles:

- The **online side** configures an uplink and `packages.proxy`. `ingest-middleware` analyzes and downloads packages from upstream and exports the cache, while `offline-storage` must use `offline: false`.
- The **offline side** does not configure an uplink, proxy, or `ingest-middleware`. With `offline: true`, `offline-storage` resolves only local packages, while the `metadata-healer` filter repairs metadata. The offline example declares no `middlewares`, so no import route is registered.

Do not enable ingest and healer in the same Verdaccio instance. Ingest depends on upstream and owns writes to the online cache; healer targets isolated storage and may repair or import metadata. Letting both operate on one storage blurs network and data ownership boundaries and can cause concurrent writes, unintended upstream fallback, or re-export of unverified data. Use separate instances, or at minimum separate configurations and storage directories.

- Complete online example: [examples/config-online.yaml](./examples/config-online.yaml)
- Complete offline example: [examples/config-offline.yaml](./examples/config-offline.yaml)

The `access` and `publish` rules in these examples only illustrate the structure. Preserve and review the production access controls already in use; do not overwrite them with the example permissions. The examples use relative storage paths, which should be adjusted for the Verdaccio working directory or container mount used in production.

The implementation registers import routes only when `middlewares.metadata-healer.enableImportUI` is `true`; a generic `enabled: false` flag is not a safeguard here. Add the following block to the offline configuration only when Web UI import is required:

```yaml
middlewares:
  metadata-healer:
    enableImportUI: true
```

After changing the configuration, use this command for a quick manual review:

```bash
rg -n "ingest-middleware|metadata-healer|offline:|proxy:" examples/config-*.yaml
```

The output still requires interpretation. For repeatable assertions whose exit code indicates success or failure, run:

```bash
set -eu
! rg -n 'metadata-healer' examples/config-online.yaml
! rg -n 'ingest-middleware|proxy:|^uplinks:|^middlewares:' examples/config-offline.yaml
test "$(rg -c '^    offline: false$' examples/config-online.yaml)" -eq 1
test "$(rg -c '^    offline: true$' examples/config-offline.yaml)" -eq 1
test "$(rg -c '^    proxy: npmjs$' examples/config-online.yaml)" -eq 2
test "$(rg -c '^  metadata-healer:$' examples/config-offline.yaml)" -eq 1
```

Acceptance rules: the online configuration contains only `ingest-middleware`, uses `offline: false`, and assigns `proxy` to both package rules. The offline configuration contains only the `metadata-healer` filter, uses `offline: true`, and contains no uplink, middleware, or `proxy`.

### Storage Manifest Migration and Rollback

The repository provides `scripts/repair-storage-manifests.mjs` to normalize `_attachments` and related map fields in historical `package.json` manifests and backfill `_distfiles` entries from version metadata. Every path below is a placeholder and must be replaced with an absolute local path. Storage and backup must differ, and the backup directory must not be inside storage.

Start with a read-only dry run and inspect the report with `jq`:

```bash
# Replace these values with actual local paths.
REPO_ROOT=/absolute/path/to/verdaccio-offline-sync
STORAGE_DIR=/absolute/path/to/verdaccio/storage/data
DRY_RUN_REPORT=/tmp/verdaccio-manifest-dry-run.json

node "$REPO_ROOT/scripts/repair-storage-manifests.mjs" \
  --storage "$STORAGE_DIR" | tee "$DRY_RUN_REPORT"
jq -e '.fileErrors == 0 and .parseErrors == 0' "$DRY_RUN_REPORT"
```

Review the dry-run scope and error counts before applying changes. **Stop every Verdaccio instance or container that reads or writes this storage before apply**, then provide a dedicated absolute backup directory outside storage:

```bash
# Replace these values with actual local paths.
APPLY_REPORT=/tmp/verdaccio-manifest-apply.json
BACKUP_DIR=/absolute/path/outside-storage/manifest-backup-YYYYMMDD

node "$REPO_ROOT/scripts/repair-storage-manifests.mjs" \
  --storage "$STORAGE_DIR" \
  --apply \
  --backup-dir "$BACKUP_DIR" | tee "$APPLY_REPORT"
jq -e '.fileErrors == 0 and .parseErrors == 0 and .modified == .backups' \
  "$APPLY_REPORT"
```

The validation summary for the completed migration is retained below for traceability. It records evidence from that run and is not a hard-coded expectation for future migrations; always use the current dry-run and apply reports.

| Metric | Recorded result |
|--------|----------------:|
| dry-run/apply `scan` | 10478 |
| dry-run `wouldModify` | 5842 |
| dry-run `missingAttachments` | 1436 |
| dry-run `missingDistfiles` | 5574 |
| dry-run `parseErrors` | 0 |
| dry-run `backfilledDistfiles` | 721518 |
| apply `modified` | 5842 |
| apply `backups` | 5842 |
| apply `fileErrors` | 0 |
| post-scan `wouldModify` | 0 |
| post-scan `missingAttachments` | 0 |
| post-scan `missingDistfiles` | 0 |
| post-scan `parseErrors` | 0 |

After apply and before restarting Verdaccio, run another dry scan and validate it with `jq`. You can also ask `jq` to parse every manifest:

```bash
POST_REPORT=/tmp/verdaccio-manifest-post-scan.json
node "$REPO_ROOT/scripts/repair-storage-manifests.mjs" \
  --storage "$STORAGE_DIR" | tee "$POST_REPORT"
jq -e '.wouldModify == 0 and .parseErrors == 0 and .fileErrors == 0' "$POST_REPORT"
find "$STORAGE_DIR" -type f -name package.json -exec jq -e empty {} +
```

To roll back, stop Verdaccio again. The backup preserves the same relative directory structure as storage, so restore only the backed-up `package.json` files by relative path. Do not restore the whole storage volume and do not overwrite or delete `.tgz` files.

First run this read-only check to resolve both paths to existing absolute directories, reject nested paths, and review the files that would be restored:

```bash
(
  set -eu
  backup_real=$(realpath -e -- "$BACKUP_DIR")
  storage_real=$(realpath -e -- "$STORAGE_DIR")
  [ -d "$backup_real" ] && [ -d "$storage_real" ]
  [ "$backup_real" != / ] && [ "$storage_real" != / ]
  case "$backup_real" in
    "$storage_real"|"$storage_real"/*)
      echo 'Rollback refused: backup equals storage or is inside storage' >&2
      exit 1
      ;;
  esac
  case "$storage_real" in
    "$backup_real"|"$backup_real"/*)
      echo 'Rollback refused: storage is inside backup' >&2
      exit 1
      ;;
  esac
  find "$backup_real" -type f -name package.json -print
)
```

After confirming that the list contains only manifests from this backup, restore them:

```bash
(
  set -eu
  backup_real=$(realpath -e -- "$BACKUP_DIR")
  storage_real=$(realpath -e -- "$STORAGE_DIR")
  [ -d "$backup_real" ] && [ -d "$storage_real" ]
  [ "$backup_real" != / ] && [ "$storage_real" != / ]
  case "$backup_real" in
    "$storage_real"|"$storage_real"/*)
      echo 'Rollback refused: backup equals storage or is inside storage' >&2
      exit 1
      ;;
  esac
  case "$storage_real" in
    "$backup_real"|"$backup_real"/*)
      echo 'Rollback refused: storage is inside backup' >&2
      exit 1
      ;;
  esac
  cd -- "$backup_real" &&
    find . -type f -name package.json -print0 \
      | xargs -0 -r cp --archive --parents --target-directory="$storage_real" --
)
```

Repeat the dry run and `jq` checks after rollback before deciding whether to restart the service. Keep original production reports with production storage and backups outside the repository. The README contains only the validation summary above. Manage all production data according to the organization's protection and retention policies.

## Web UI Guide

Access `http://external:4873/_/ingest/ui` to open the management interface.

### Features

#### 1. Cache Status

Displays current local cache statistics:
- Total packages
- Total versions
- Last sync time

#### 2. Quick Actions

| Button | Function |
|--------|----------|
| Refresh All Metadata | Update metadata for all cached packages from upstream |
| Sync Missing Dependencies | Navigate to sync configuration |
| Rebuild Local Index | Scan storage directory and repair metadata |

#### 3. Sync Configuration

**Target Platform Selection:**
- Linux x64 / ARM64
- Windows x64 / ARM64
- macOS x64 / ARM64

**Sync Options:**
| Option | Description |
|--------|-------------|
| Refresh All Metadata Before Analyze | Refresh metadata of all cached packages from upstream (disabled by default) |
| Update to Latest | Check for newer versions of cached packages |
| Complete Sibling Versions | For each cached version, download the latest patch in the same minor and the latest minor in the same major |
| Include Optional Dependencies | Download optionalDependencies (platform binaries) |
| Include Peer Dependencies | Download peerDependencies |

#### 4. Analyze-Confirm-Download Workflow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Analyze   │ ──▶│   Confirm   │ ──▶│   Download  │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
 Detailed progress   Package list       Download results
 - Current phase     - name@version     - Success/fail count
 - Percentage        - Download reason  - Failed list
 - ETA               - Cancel support   - Retry support
 - Current package
```

**Analysis Progress Phases:**
| Phase | Progress Range | Description |
|-------|----------------|-------------|
| Scan Local Cache | 0-5% | Scan storage directory |
| Prepare Metadata | 5-25% | Load local metadata first; refresh upstream only when update/sibling completion is enabled |
| Analyze Dependencies | 25-75% | BFS traverse dependency tree |
| Targeted Metadata Sync | 75-85% | Sync metadata only for dependency gaps |
| Detect Platform Binaries | 85-95% | Identify platform packages to download |
| Complete | 100% | Generate download list |

#### 5. Execution Log

- Real-time operation logs
- Export logs (TXT format)
- Clear logs

#### 6. Cached Packages List

Displays locally cached packages:
- Package name
- Version count
- Latest cached version

#### 7. Differential Export (Online)

In the "📤 Differential Export" card at the bottom of Web UI:

**Export History:** Shows recent export records

**Base Time Selection:**
| Option | Description |
|--------|-------------|
| Last Export Time | Export only new/modified files since last export |
| Custom Time | Manually specify base timestamp |
| Full Export | Export all files regardless of time |

**Export Options:**
- Include metadata files: Whether to include package.json files

**Workflow:**
```
Preview changes → View file list → Create export package → Download tar.gz
```

**Export Package Structure:**
```
diff-export-2024-01-15T10-30-00.tar.gz
├── .export-manifest.json      # Export manifest (file list and checksums)
├── react/
│   ├── package.json
│   └── react-18.2.0.tgz
├── @esbuild%2flinux-x64/
│   └── linux-x64-0.19.0.tgz
└── lodash/
    └── lodash-4.17.21.tgz
```

#### 8. Differential Import (Offline)

Access `http://internal:4873/_/healer/ui` to open the import management interface.

**Upload Differential Package:**
- Drag-and-drop or click to select file
- Only accepts .tar.gz or .tgz format

**Import Options:**
| Option | Description |
|--------|-------------|
| Overwrite Existing Files | Overwrite if target file exists (default: skip) |
| Validate Checksums | Verify SHA256 checksums before import |
| Auto Rebuild Metadata | Trigger metadata rebuild after import |

**Import Progress Phases:**
| Phase | Description |
|-------|-------------|
| Extract Files | Extract tar.gz to temp directory |
| Validate Checksums | Verify SHA256 for each file |
| Import Files | Copy files to storage directory |
| Rebuild Metadata | Trigger automatic metadata rebuild |

For packages that were imported or downloaded previously but never appeared in the local package list, use **Rebuild Local Cache Index** on the same page. It scans local storage only, never accesses an uplink, and is safe to run repeatedly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Online Environment                              │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Verdaccio + offline-storage + ingest-middleware            │   │
│  │                                                             │   │
│  │  Web UI: http://external:4873/_/ingest/ui                   │   │
│  │  ├── View cache status                                      │   │
│  │  ├── Analyze deps → Confirm download list → Execute         │   │
│  │  ├── Real-time progress (percentage, ETA, current package)  │   │
│  │  └── 📤 Differential export (time-based incremental)        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                    storage/ directory                               │
│                    ├── react/                                       │
│                    │   ├── package.json                             │
│                    │   └── react-18.2.0.tgz                         │
│                    ├── @esbuild%2flinux-x64/                        │
│                    │   └── linux-x64-0.19.0.tgz                     │
│                    ├── .export-history.json  ← Export history       │
│                    └── .exports/             ← Export packages      │
│                        └── diff-export-2024-01-15T10-30-00.tar.gz   │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │ Method 1: rsync -avz --ignore-existing
                               │ Method 2: Download diff package → Import
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Offline Environment                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Verdaccio + offline-storage + metadata-healer              │   │
│  │                                                             │   │
│  │  Import UI: http://internal:4873/_/healer/ui                │   │
│  │  ├── 📥 Upload differential package                         │   │
│  │  ├── 📂 Import from server local path                       │   │
│  │  ├── Import options (overwrite/validate/rebuild metadata)   │   │
│  │  ├── 🔄 Metadata sync (single package / batch sync)        │   │
│  │  └── Import history                                         │   │
│  │                                                             │   │
│  │  npm install react --registry http://internal:4873          │   │
│  │  ├── offline-storage resolves versions locally              │   │
│  │  ├── metadata-healer dynamically repairs missing metadata   │   │
│  │  └── Auto-selects platform-specific binaries                │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### Online Plugin (ingest-middleware)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_/ingest/ui` | GET | Web management interface |
| `/_/ingest/cache` | GET | View local cache status |
| `/_/ingest/refresh` | POST | Refresh cached package metadata |
| `/_/ingest/analyze` | POST | Analyze dependencies (async task) |
| `/_/ingest/analysis/:id` | GET | Get analysis results |
| `/_/ingest/download` | POST | Execute download (based on analysis) |
| `/_/ingest/retry` | POST | Retry failed downloads |
| `/_/ingest/sync` | POST | One-click sync (analyze + download) |
| `/_/ingest/platform` | POST | Download multi-platform versions |
| `/_/ingest/status/:taskId` | GET | Query task status |
| `/_/ingest/rebuild-index` | POST | Rebuild local index |
| `/_/ingest/export/history` | GET | Get export history |
| `/_/ingest/export/preview` | POST | Preview files to export |
| `/_/ingest/export/create` | POST | Create differential export package |
| `/_/ingest/export/download/:exportId` | GET | Download export package |

### Offline Plugin (metadata-healer)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_/healer/ui` | GET | Import management interface |
| `/_/healer/import/upload` | POST | Upload and import differential package |
| `/_/healer/import/local` | POST | Import differential package from server local path |
| `/_/healer/import/status/:taskId` | GET | Query import task status |
| `/_/healer/import/history` | GET | Get import history |
| `/_/healer/rebuild-index` | POST | Fully offline rebuild of all local cached packages and the package list |
| `/_/healer/rebuild/status/:taskId` | GET | Query local cache rebuild task status |
| `/_/healer/sync/:name` | POST | Sync metadata for a single package |
| `/_/healer/sync/:scope/:name` | POST | Sync metadata for a scoped package |
| `/_/healer/sync-all` | POST | Sync metadata for all local packages |
| `/_/healer/sync/status/:taskId` | GET | Query sync task status |
| `/_/healer/packages` | GET | List all local packages |

### API Examples

#### Analyze Dependencies

```bash
curl -X POST http://external:4873/_/ingest/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "platforms": [
      {"os": "linux", "arch": "x64", "libc": "glibc"},
      {"os": "win32", "arch": "x64"}
    ],
    "options": {
      "updateToLatest": true,
      "includeOptional": true,
      "includePeer": true
    }
  }'

# Response
{
  "success": true,
  "taskId": "task-1234567890-abc123",
  "message": "Analysis task started"
}
```

#### Query Task Status

```bash
curl http://external:4873/_/ingest/status/task-1234567890-abc123

# Response (in progress)
{
  "taskId": "task-1234567890-abc123",
  "status": "running",
  "progress": 45,
  "message": "Analyzing dependencies (level 2): lodash",
  "detailedProgress": {
    "phase": "analyzing",
    "phaseProgress": 60,
    "totalProgress": 45,
    "currentPackage": "lodash@4.17.21",
    "processed": 120,
    "total": 200,
    "estimatedRemaining": 30000,
    "phaseDescription": "Analyzing dependencies (level 2): lodash"
  }
}

# Response (completed)
{
  "taskId": "task-1234567890-abc123",
  "status": "completed",
  "progress": 100,
  "result": {
    "analysisId": "analysis-1234567890-xyz789",
    "scanned": 150,
    "refreshed": 150,
    "toDownload": [...],
    "platforms": ["linux-x64", "win32-x64"],
    "timestamp": 1234567890000
  }
}
```

#### Execute Download

```bash
curl -X POST http://external:4873/_/ingest/download \
  -H "Content-Type: application/json" \
  -d '{
    "analysisId": "analysis-1234567890-xyz789"
  }'
```

## Sync Workflows

### Method 1: Direct rsync Sync

```bash
# 1. Online: Open Web UI for sync
#    Visit http://external:4873/_/ingest/ui
#    Select platforms → Analyze deps → Confirm → Download

# 2. Differential sync to offline
rsync -avz --ignore-existing /external/storage/ /internal/storage/

# 3. Offline: Rebuild index (first time or if issues)
curl -X POST http://internal:4873/_/ingest/rebuild-index

# 4. Offline: Normal usage
npm install <package> --registry http://internal:4873
```

### Method 2: Differential Package Export/Import (Recommended)

For scenarios where direct rsync is not possible (e.g., USB transfer).

```bash
# 1. Online: Open Web UI
#    Visit http://external:4873/_/ingest/ui

# 2. Online: Download dependencies (same as Method 1)
#    Select platforms → Analyze deps → Confirm → Download

# 3. Online: Create differential export package
#    In "📤 Differential Export" card:
#    Select base time → Preview changes → Create export → Download

# 4. Transfer diff-export-xxx.tar.gz to offline environment

# 5. Offline: Open import Web UI
#    Visit http://internal:4873/_/healer/ui

# 6. Offline: Upload and import differential package
#    Drag-drop upload → Select import options → Start import

# 7. Offline: Normal usage
npm install <package> --registry http://internal:4873
```

### Command Line Method

```bash
# Online: One-click sync
curl -X POST http://external:4873/_/ingest/sync \
  -H "Content-Type: application/json" \
  -d '{
    "platforms": [
      {"os": "linux", "arch": "x64", "libc": "glibc"},
      {"os": "win32", "arch": "x64"}
    ],
    "options": {
      "updateToLatest": true,
      "includeOptional": true
    }
  }'
```

## Multi-Platform Binary Support

Automatically detects and downloads platform-specific packages:

| Package Pattern | Examples |
|-----------------|----------|
| `@esbuild/*` | @esbuild/linux-x64, @esbuild/win32-x64 |
| `@swc/core-*` | @swc/core-linux-x64-gnu, @swc/core-win32-x64-msvc |
| `@rollup/rollup-*` | @rollup/rollup-linux-x64-gnu |
| `@img/sharp-*` | @img/sharp-linux-x64, @img/sharp-win32-x64 |

## Configuration Reference

### ingest-middleware Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | true | Enable plugin |
| `upstreamRegistry` | string | From uplinks | Upstream registry URL (auto-detected from uplinks if not set) |
| `concurrency` | number | 5 | Processing concurrency (download/scan/analyze/export) |
| `timeout` | number | 60000 | Request timeout (ms) |
| `platforms` | array | - | Target platform list |
| `sync.refreshAllMetadataBeforeAnalyze` | boolean | false | Whether to refresh all metadata before analysis |
| `sync.updateToLatest` | boolean | false | Update to latest versions |
| `sync.completeSiblingVersions` | boolean | false | Complete sibling versions (latest patch in same minor + latest minor in same major) |
| `sync.includeDev` | boolean | false | Include devDependencies |
| `sync.includePeer` | boolean | true | Include peerDependencies |
| `sync.includeOptional` | boolean | true | Include optionalDependencies |
| `sync.maxDepth` | number | 10 | Max dependency tree depth |
| `verifyChecksum` | boolean | true | Verify tarball SHA-1 against upstream after download |
| `minTarballSize` | number | 128 | Minimum tarball size in bytes, smaller files treated as corrupt |

### offline-storage Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `offline` | boolean | false | Force offline mode (resolve all packages locally) |
| `verifyChecksum` | boolean | true | Verify local tarball SHA-1 against metadata |
| `minTarballSize` | number | 128 | Minimum tarball size in bytes, smaller files treated as corrupt |

### metadata-healer Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | true | Enable plugin |
| `syncConcurrency` | number | 5 | Batch metadata sync concurrency (`/sync-all`) |
| `scanCacheTTL` | number | 60000 | Scan cache TTL (ms) |
| `shasumCacheSize` | number | 10000 | Shasum cache size |
| `autoUpdateLatest` | boolean | true | Auto-update latest tag |

## Project Structure

```
verdaccio-offline-sync/
├── packages/
│   ├── verdaccio-ingest-middleware/     # Online plugin
│   │   ├── src/
│   │   │   ├── index.ts                 # Entry
│   │   │   ├── ingest-middleware.ts     # Middleware main class
│   │   │   ├── dependency-resolver.ts   # Dependency tree resolver
│   │   │   ├── package-downloader.ts    # Package downloader
│   │   │   ├── storage-scanner.ts       # Storage scanner
│   │   │   ├── differential-scanner.ts  # Differential file scanner
│   │   │   ├── differential-packer.ts   # Differential packer
│   │   │   ├── web-ui.ts                # Web UI template
│   │   │   └── types.ts                 # Type definitions
│   │   └── package.json
│   │
│   └── verdaccio-metadata-healer/       # Offline plugin
│       ├── src/
│       │   ├── index.ts                 # Entry
│       │   ├── healer-filter.ts         # Filter main class
│       │   ├── import-middleware.ts     # Import middleware
│       │   ├── import-handler.ts        # Import handler
│       │   ├── import-ui.ts             # Import Web UI
│       │   ├── storage-scanner.ts       # Storage scanner
│       │   ├── metadata-patcher.ts      # Metadata patcher
│       │   ├── metadata-syncer.ts      # Metadata syncer
│       │   ├── shasum-cache.ts          # Shasum cache
│       │   └── types.ts                 # Type definitions
│       └── package.json
│
├── package.json                         # Monorepo config
├── pnpm-workspace.yaml
└── README.md
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build single package
pnpm --filter verdaccio-ingest-middleware build

# Test
pnpm test

# Development mode (watch)
pnpm dev
```

## FAQ

### Q: Package not found when installing in offline environment?

1. Confirm package has been synced to offline storage directory
2. Run "Rebuild Local Index" to repair metadata
3. Check if `offline-storage` plugin is correctly configured

### Q: Platform binaries not fully downloaded?

1. Check all required target platforms in Web UI
2. Ensure `includeOptional` option is enabled
3. Verify upstream registry is accessible

### Q: Analysis progress stuck?

1. Check network connection
2. Review error messages in execution log
3. Try reducing concurrency (`concurrency` config)

### Q: How to sync specific packages only?

Use API to specify package list directly:

```bash
curl -X POST http://external:4873/_/ingest/download \
  -H "Content-Type: application/json" \
  -d '{
    "packages": [
      {"name": "react", "version": "18.2.0", "reason": "missing-dependency"},
      {"name": "lodash", "version": "4.17.21", "reason": "missing-dependency"}
    ]
  }'
```

## License

MIT
