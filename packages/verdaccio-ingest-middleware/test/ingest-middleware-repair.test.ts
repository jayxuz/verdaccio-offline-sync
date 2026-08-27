import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '@verdaccio/types';

import IngestMiddleware from '../src/ingest-middleware';

function createMiddleware(): any {
  const middleware = Object.create(IngestMiddleware.prototype);
  Object.defineProperty(middleware, 'config', {
    configurable: true,
    value: { enabled: true, concurrency: 2 },
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
  middleware.repairScanCache = new Map();
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

describe('executeRepairScan', () => {
  it('finds incomplete packages and selects versions via the smart rules', async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('scan-task', { taskId: 'scan-task', status: 'pending' });

    const packuments: Record<string, any> = {
      'lib-a': {
        name: 'lib-a',
        versions: {
          '1.0.0': { dependencies: { 'broken-dep': '^1.0.0' } }
        },
        'dist-tags': { latest: '1.0.0' }
      },
      'broken-dep': {
        name: 'broken-dep',
        versions: {
          '1.0.0': {},
          '1.5.0': {},
          '2.0.0': {}
        },
        'dist-tags': { latest: '2.0.0' }
      },
      lonely: {
        name: 'lonely',
        versions: { '0.1.0': {} },
        'dist-tags': { latest: '0.1.0' }
      }
    };

    middleware.scanner = {
      scanAllPackageIntegrity: async () => [
        { name: 'lib-a', tarballVersions: ['1.0.0'], hasMetadata: true },
        { name: 'broken-dep', tarballVersions: [], hasMetadata: true },
        { name: 'lonely', tarballVersions: [], hasMetadata: true },
        { name: '@scope/gone', tarballVersions: [], hasMetadata: false }
      ],
      readPackument: async (name: string) => packuments[name] || null
    };

    const result = await middleware.executeRepairScan('scan-task', { versionScope: 'smart' });

    assert.equal(middleware.tasks.get('scan-task').status, 'completed');
    assert.equal(result.scanned, 4);
    assert.equal(result.healthy, 1);
    assert.equal(result.incompleteCount, 2);

    const brokenDep = result.plans.find((p: any) => p.name === 'broken-dep');
    assert.ok(brokenDep, 'broken-dep should have a repair plan');
    assert.deepEqual(
      brokenDep.selectedVersions.map((s: any) => s.version),
      ['2.0.0', '1.5.0']
    );
    const v15 = brokenDep.selectedVersions.find((s: any) => s.version === '1.5.0');
    assert.ok(v15.reasons.includes('dependent-range'), '1.5.0 should be hit by ^1.0.0');
    assert.ok(v15.reasons.includes('major-latest'));

    const lonely = result.plans.find((p: any) => p.name === 'lonely');
    assert.deepEqual(
      lonely.selectedVersions.map((s: any) => s.version),
      ['0.1.0']
    );

    assert.equal(result.totalVersionsToDownload, 3);
    assert.deepEqual(
      result.unrepairable.map((u: any) => u.name),
      ['@scope/gone']
    );

    // 扫描结果已缓存，可通过 scanId 再次获取
    assert.ok(middleware.repairScanCache.has(result.scanId));
  });

  it('marks incomplete packages without selectable versions as unrepairable', async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('scan-task', { taskId: 'scan-task', status: 'pending' });

    middleware.scanner = {
      scanAllPackageIntegrity: async () => [
        { name: 'pre-only', tarballVersions: [], hasMetadata: true }
      ],
      readPackument: async () => ({
        name: 'pre-only',
        versions: { '1.0.0-alpha.1': {} },
        'dist-tags': {}
      })
    };

    const result = await middleware.executeRepairScan('scan-task', {});

    assert.equal(result.plans.length, 0);
    assert.equal(result.unrepairable.length, 1);
    assert.equal(result.unrepairable[0].name, 'pre-only');
  });

  it("versionScope 'latest' selects only latest and skips healthy packument reads", async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('scan-task', { taskId: 'scan-task', status: 'pending' });

    const readPackumentCalls: string[] = [];
    middleware.scanner = {
      scanAllPackageIntegrity: async () => [
        { name: 'lib-a', tarballVersions: ['1.0.0'], hasMetadata: true },
        { name: 'broken-dep', tarballVersions: [], hasMetadata: true }
      ],
      readPackument: async (name: string) => {
        readPackumentCalls.push(name);
        if (name === 'broken-dep') {
          return {
            name,
            versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} },
            'dist-tags': { latest: '2.0.0' }
          };
        }
        return { name, versions: { '1.0.0': { dependencies: { 'broken-dep': '^1.0.0' } } } };
      }
    };

    const result = await middleware.executeRepairScan('scan-task', {
      versionScope: 'latest'
    });

    assert.equal(result.options?.versionScope, 'latest');
    assert.equal(result.totalVersionsToDownload, 1);
    assert.deepEqual(
      result.plans[0].selectedVersions.map((s: any) => s.version),
      ['2.0.0']
    );
    // latest 模式不读取健康包的 packument（跳过依赖命中分析）
    assert.deepEqual(readPackumentCalls, ['broken-dep']);
  });

  it("versionScope defaults to 'latest' when not provided", async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('scan-task', { taskId: 'scan-task', status: 'pending' });

    middleware.scanner = {
      scanAllPackageIntegrity: async () => [
        { name: 'broken-dep', tarballVersions: [], hasMetadata: true }
      ],
      readPackument: async (name: string) => ({
        name,
        versions: { '1.0.0': {}, '2.0.0': {} },
        'dist-tags': { latest: '2.0.0' }
      })
    };

    const result = await middleware.executeRepairScan('scan-task', {});

    assert.equal(result.options?.versionScope, 'latest');
    assert.equal(result.totalVersionsToDownload, 1);
  });
});

describe('handleRepair', () => {
  it('responds 404 for an unknown scanId', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware.handleRepair({ body: { scanId: 'repair-scan-missing' } }, response);

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.success, false);
  });

  it('responds 400 when neither scanId nor packages are given', async () => {
    const middleware = createMiddleware();
    const response = createResponse();

    await middleware.handleRepair({ body: {} }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.success, false);
  });

  it('starts a repair task from a cached scan', async () => {
    const middleware = createMiddleware();
    middleware.repairScanCache.set('scan-1', {
      scanId: 'scan-1',
      plans: [
        {
          name: 'broken-dep',
          metadataVersionCount: 3,
          selectedVersions: [
            { version: '2.0.0', reasons: ['dist-tag-latest', 'major-latest'] },
            { version: '1.5.0', reasons: ['dependent-range'] }
          ]
        }
      ]
    });
    // executeRepair 异步执行，提供最小可用 stub 防止未处理拒绝
    middleware.downloader = {
      clearRequestCache() {},
      cleanupTarball: async () => {},
      downloadPackage: async (name: string, version: string) => ({
        package: { name, version },
        size: 10,
        verified: true
      }),
      downloadPackument: async (name: string) => ({ name, versions: {}, 'dist-tags': {} }),
      savePackument: async () => {}
    };

    const response = createResponse();
    await middleware.handleRepair({ body: { scanId: 'scan-1' } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.total, 2);
    assert.ok(response.body.taskId);

    const task = middleware.tasks.get(response.body.taskId);
    assert.ok(task, 'task should be tracked');
  });
});

describe('executeRepair', () => {
  it('classifies 404 failures as upstreamMissing and keeps them retryable-incompatible', async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('repair-task', { taskId: 'repair-task', status: 'pending' });

    middleware.downloader = {
      clearRequestCache() {},
      cleanupTarball: async () => {},
      downloadPackage: async (name: string, version: string) => {
        if (name === 'gone') {
          throw new Error(`404 Not Found - GET https://registry.example.com/${name}`);
        }
        if (name === 'flaky') {
          throw new Error('ECONNRESET');
        }
        return { package: { name, version }, size: 10, verified: true };
      },
      downloadPackument: async (name: string) => ({ name, versions: {}, 'dist-tags': {} }),
      savePackument: async () => {}
    };

    const result = await middleware.executeRepair('repair-task', [
      { name: 'ok', version: '1.0.0', reason: 'integrity-repair' },
      { name: 'gone', version: '2.0.0', reason: 'integrity-repair' },
      { name: 'flaky', version: '3.0.0', reason: 'integrity-repair' }
    ]);

    assert.equal(middleware.tasks.get('repair-task').status, 'completed');
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.success, false);
    assert.equal(result.repairedPackages, 1);
    assert.deepEqual(
      result.upstreamMissing.map((p: any) => `${p.name}@${p.version}`),
      ['gone@2.0.0']
    );
    // failedPackages 保留全部失败项，兼容 /ingest/retry 的输入契约
    assert.equal(result.failedPackages.length, 2);
  });

  it('fails the task when final metadata persistence fails', async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('repair-task', { taskId: 'repair-task', status: 'pending' });

    middleware.downloader = {
      clearRequestCache() {},
      cleanupTarball: async () => {},
      downloadPackage: async (name: string, version: string) => ({
        package: { name, version },
        size: 10,
        verified: true
      }),
      downloadPackument: async (name: string) => ({ name, versions: {}, 'dist-tags': {} }),
      savePackument: async (name: string) => {
        throw new Error(`metadata write failed for ${name}`);
      }
    };

    await assert.rejects(
      middleware.executeRepair('repair-task', [
        { name: 'demo', version: '1.0.0', reason: 'integrity-repair' }
      ]),
      /demo: metadata write failed for demo/
    );
    assert.equal(middleware.tasks.get('repair-task').status, 'failed');
  });
});
