import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Logger } from '@verdaccio/types';

import IngestMiddleware from '../src/ingest-middleware';

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createMiddleware(config: Record<string, unknown> = {}): Promise<any> {
  const middleware = Object.create(IngestMiddleware.prototype);
  Object.defineProperty(middleware, 'config', {
    configurable: true,
    value: { enabled: true, concurrency: 2, ...config },
    writable: true
  });
  middleware.logger = {
    debug() {},
    error() {},
    info() {},
    trace() {},
    warn() {}
  } as unknown as Logger;
  middleware.tasks = new Map();
  const storagePath = await mkdtemp(path.join(tmpdir(), 'ingest-scan-cache-'));
  tempDirs.push(storagePath);
  middleware.storagePath = storagePath;
  return middleware;
}

function createResponse(): any {
  return {
    body: undefined,
    statusCode: 200,
    json(body: unknown) {
      this.body = body;
      return this;
    },
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }
  };
}

function cachedPackage(name: string): any {
  return { name, versions: ['1.0.0'], latestVersion: '1.0.0', dependencies: {} };
}

describe('scan cache for /ingest/cache', () => {
  it('scans once on cold start and serves memory cache within TTL', async () => {
    const middleware = await createMiddleware();
    let scanCount = 0;
    middleware.scanner = {
      scanAllPackages: async () => {
        scanCount++;
        return [cachedPackage('demo')];
      }
    };

    const first = createResponse();
    await middleware.handleCacheStatus({ query: {} }, first);
    assert.equal(scanCount, 1);
    assert.equal(first.body.success, true);
    assert.equal(first.body.totalPackages, 1);
    assert.equal(first.body.totalVersions, 1);
    assert.equal(first.body.packages[0].name, 'demo');
    assert.equal(typeof first.body.builtAt, 'number');
    assert.equal(first.body.stale, false, '冷启动同步扫描后数据应为新鲜');
    assert.equal(first.body.rebuilding, false);

    const second = createResponse();
    await middleware.handleCacheStatus({ query: {} }, second);
    assert.equal(scanCount, 1, 'TTL 内不应重复扫描');
    assert.equal(second.body.stale, false);
    assert.equal(second.body.rebuilding, false);
  });

  it('serves stale data immediately and rebuilds in background after dirty', async () => {
    const middleware = await createMiddleware();
    let scanCount = 0;
    let releaseScan: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    middleware.scanner = {
      scanAllPackages: async () => {
        scanCount++;
        if (scanCount === 2) {
          await gate;
        }
        return [cachedPackage(`demo-v${scanCount}`)];
      }
    };

    await middleware.handleCacheStatus({ query: {} }, createResponse());
    assert.equal(scanCount, 1);

    middleware.markScanCacheDirty();

    const staleResponse = createResponse();
    await middleware.handleCacheStatus({ query: {} }, staleResponse);
    // 旧数据立即返回，后台重建进行中
    assert.equal(staleResponse.body.packages[0].name, 'demo-v1');
    assert.equal(staleResponse.body.stale, true);
    assert.equal(staleResponse.body.rebuilding, true);
    assert.equal(scanCount, 2, '后台重建应已启动');

    releaseScan();
    await middleware.scanCacheRebuild;

    const freshResponse = createResponse();
    await middleware.handleCacheStatus({ query: {} }, freshResponse);
    assert.equal(freshResponse.body.packages[0].name, 'demo-v2');
    assert.equal(freshResponse.body.stale, false);
    assert.equal(freshResponse.body.rebuilding, false);
    assert.equal(scanCount, 2);
  });

  it('persists snapshot to disk and reloads it without scanning', async () => {
    const first = await createMiddleware();
    let scanCount = 0;
    first.scanner = {
      scanAllPackages: async () => {
        scanCount++;
        return [cachedPackage('snapshot-demo')];
      }
    };
    await first.handleCacheStatus({ query: {} }, createResponse());
    assert.equal(scanCount, 1);

    const snapshotPath = path.join(first.storagePath, '.ingest-scan-cache.json');
    await stat(snapshotPath);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8'));
    assert.equal(snapshot.status.packages[0].name, 'snapshot-demo');

    // 新实例（模拟进程/容器重启）：应从磁盘快照恢复，不触发扫描
    const second = await createMiddleware();
    second.storagePath = first.storagePath;
    let rescanCount = 0;
    second.scanner = {
      scanAllPackages: async () => {
        rescanCount++;
        return [];
      }
    };

    const response = createResponse();
    await second.handleCacheStatus({ query: {} }, response);
    assert.equal(rescanCount, 0, '快照新鲜时不应扫描');
    assert.equal(response.body.packages[0].name, 'snapshot-demo');
    assert.equal(response.body.stale, false);
    assert.equal(response.body.rebuilding, false);
  });

  it('rebuilds in background when snapshot is older than TTL', async () => {
    const middleware = await createMiddleware({ scanCacheTtlSeconds: 1 });
    let scanCount = 0;
    middleware.scanner = {
      scanAllPackages: async () => {
        scanCount++;
        return [cachedPackage('ttl-demo')];
      }
    };
    await middleware.handleCacheStatus({ query: {} }, createResponse());
    assert.equal(scanCount, 1);

    // 人为把缓存时间戳拨到 TTL 之前
    middleware.scanCache.builtAt = Date.now() - 5000;

    const response = createResponse();
    await middleware.handleCacheStatus({ query: {} }, response);
    assert.equal(response.body.stale, true);
    assert.equal(response.body.rebuilding, true);

    await middleware.scanCacheRebuild;
    assert.equal(scanCount, 2);
  });

  it('updateTask marks scan cache dirty only when task completes', async () => {
    const middleware = await createMiddleware();
    middleware.tasks.set('task-1', { taskId: 'task-1', status: 'pending' });
    middleware.tasks.set('task-2', { taskId: 'task-2', status: 'pending' });

    middleware.updateTask('task-1', { status: 'running' });
    assert.equal(middleware.scanCacheDirty, undefined);

    middleware.updateTask('task-2', { status: 'completed' });
    assert.equal(middleware.scanCacheDirty, true);
  });
});
