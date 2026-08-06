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
  return middleware;
}

describe('packument persistence failures', () => {
  for (const methodName of [
    'savePackumentsFromResolverCache',
    'savePackumentsForPackages'
  ] as const) {
    it(`${methodName} continues the batch but rejects with every package failure`, async () => {
      const middleware = createMiddleware();
      const attempted: string[] = [];
      middleware.resolver = {
        getCachedPackument: (name: string) => ({ name, versions: {}, 'dist-tags': {} })
      };
      middleware.downloader = {
        downloadPackument: async (name: string) => ({ name, versions: {}, 'dist-tags': {} }),
        savePackument: async (name: string) => {
          attempted.push(name);
          if (name !== 'working') {
            throw new Error(`disk failure for ${name}`);
          }
        }
      };

      await assert.rejects(
        middleware[methodName](['broken-a', 'working', 'broken-b']),
        (error: Error) => {
          assert.match(error.message, /broken-a: disk failure for broken-a/);
          assert.match(error.message, /broken-b: disk failure for broken-b/);
          return true;
        }
      );
      assert.deepEqual(attempted.sort(), ['broken-a', 'broken-b', 'working']);
    });
  }

  it('download task is failed when final metadata persistence fails', async () => {
    const middleware = createMiddleware();
    middleware.tasks.set('download-task', { taskId: 'download-task', status: 'pending' });
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
      middleware.executeDownload('download-task', [
        { name: 'demo', version: '1.0.0', reason: 'missing' }
      ]),
      /demo: metadata write failed for demo/
    );
    assert.equal(middleware.tasks.get('download-task').status, 'failed');
    assert.match(middleware.tasks.get('download-task').error, /demo/);
  });

  it('rebuild responds with failure after collecting package persistence errors', async () => {
    const middleware = createMiddleware();
    const attempted: string[] = [];
    middleware.scanner = {
      scanAllPackages: async () => [
        { name: 'working', versions: ['1.0.0'] },
        { name: 'broken', versions: ['1.0.0'] }
      ],
      readPackument: async () => null,
      extractVersionFromTarball: async (name: string, version: string) => ({ name, version })
    };
    middleware.downloader = {
      savePackument: async (name: string) => {
        attempted.push(name);
        if (name === 'broken') {
          throw new Error('storage unavailable');
        }
      }
    };
    const response: any = {
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

    await middleware.handleRebuildIndex({}, response);

    assert.deepEqual(attempted, ['working', 'broken']);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /broken: storage unavailable/);
  });
});

describe('platform version candidates', () => {
  it('uses the newest local tarball and also checks versions selected for this upgrade', () => {
    const middleware = createMiddleware();

    const candidates = middleware.collectPlatformCandidates(
      [{
        name: '@anthropic-ai/claude-code',
        versions: ['2.1.218', '2.1.219'],
        latestVersion: '2.1.218',
        dependencies: {}
      }],
      [{
        name: '@anthropic-ai/claude-code',
        version: '2.1.220',
        reason: 'newer-version'
      }]
    );

    assert.deepEqual(candidates, [
      { name: '@anthropic-ai/claude-code', version: '2.1.219' },
      { name: '@anthropic-ai/claude-code', version: '2.1.220' }
    ]);
  });
});
