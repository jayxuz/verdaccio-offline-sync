import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Logger } from '@verdaccio/types';

import { StorageScanner } from '../src/storage-scanner';

const silentLogger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

/** 写一个满足 min-size（默认 128 字节）的假 tarball */
async function writeTarball(dir: string, filename: string, size = 256): Promise<void> {
  await writeFile(path.join(dir, filename), Buffer.alloc(size));
}

describe('scanAllPackageIntegrity', () => {
  let storagePath: string;
  let scanner: StorageScanner;

  beforeEach(async () => {
    storagePath = await mkdtemp(path.join(tmpdir(), 'integrity-scan-'));
    scanner = new StorageScanner(
      { enabled: true, concurrency: 2 } as any,
      storagePath,
      silentLogger
    );
  });

  afterEach(async () => {
    await rm(storagePath, { recursive: true, force: true });
  });

  it('reports healthy packages with their valid tarball versions', async () => {
    const dir = path.join(storagePath, 'pkg-a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-a' }));
    await writeTarball(dir, 'pkg-a-1.0.0.tgz');
    await writeTarball(dir, 'pkg-a-1.1.0.tgz');

    const result = await scanner.scanAllPackageIntegrity();

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].tarballVersions.sort(), ['1.0.0', '1.1.0']);
    assert.equal(result[0].hasMetadata, true);
  });

  it('reports metadata-only packages with empty tarballVersions', async () => {
    const dir = path.join(storagePath, 'pkg-b');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-b' }));

    const result = await scanner.scanAllPackageIntegrity();

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].tarballVersions, []);
    assert.equal(result[0].hasMetadata, true);
  });

  it('treats undersized tarballs as missing (incomplete)', async () => {
    const dir = path.join(storagePath, 'pkg-c');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-c' }));
    await writeTarball(dir, 'pkg-c-1.0.0.tgz', 50); // 低于 128 字节下限

    const result = await scanner.scanAllPackageIntegrity();

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].tarballVersions, []);
    assert.equal(result[0].hasMetadata, true);
  });

  it('skips empty directories and marks corrupt metadata as unrepairable', async () => {
    await mkdir(path.join(storagePath, 'pkg-empty'), { recursive: true });

    const corruptDir = path.join(storagePath, 'pkg-corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, 'package.json'), 'not-json{');

    const result = await scanner.scanAllPackageIntegrity();

    const names = result.map((info) => info.name);
    assert.ok(!names.includes('pkg-empty'), 'empty dir should be excluded');
    const corrupt = result.find((info) => info.name === 'pkg-corrupt');
    assert.ok(corrupt, 'corrupt-metadata package should be present');
    assert.equal(corrupt.hasMetadata, false);
    assert.deepEqual(corrupt.tarballVersions, []);
  });

  it('handles scoped packages and both tarball naming styles', async () => {
    // scoped 风格：scope-pkg-1.0.0.tgz
    const dirOne = path.join(storagePath, '@scope', 'pkg-one');
    await mkdir(dirOne, { recursive: true });
    await writeFile(path.join(dirOne, 'package.json'), JSON.stringify({ name: '@scope/pkg-one' }));
    await writeTarball(dirOne, 'scope-pkg-one-2.0.0.tgz');

    // 非 scoped 风格：pkg-1.0.0.tgz（Verdaccio 默认）
    const dirTwo = path.join(storagePath, '@scope', 'pkg-two');
    await mkdir(dirTwo, { recursive: true });
    await writeFile(path.join(dirTwo, 'package.json'), JSON.stringify({ name: '@scope/pkg-two' }));
    await writeTarball(dirTwo, 'pkg-two-1.0.0.tgz');

    const result = await scanner.scanAllPackageIntegrity();
    const byName = new Map(result.map((info) => [info.name, info]));

    assert.deepEqual(byName.get('@scope/pkg-one')?.tarballVersions, ['2.0.0']);
    assert.deepEqual(byName.get('@scope/pkg-two')?.tarballVersions, ['1.0.0']);
  });

  it('reports scan progress', async () => {
    for (const name of ['pkg-1', 'pkg-2', 'pkg-3']) {
      const dir = path.join(storagePath, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }));
    }

    const events: Array<[number, number, string]> = [];
    await scanner.scanAllPackageIntegrity((processed, total, current) => {
      events.push([processed, total, current]);
    });

    assert.equal(events.length, 3);
    assert.deepEqual(events.map(([, total]) => total), [3, 3, 3]);
    assert.deepEqual(events.map(([processed]) => processed), [1, 2, 3]);
  });
});
