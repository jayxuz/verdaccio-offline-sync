import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Logger } from '@verdaccio/types';
import tar from 'tar';

import { ImportHandler } from '../src/import-handler';
import type { ExportManifest, ImportProgress } from '../src/types';

const temporaryDirectories: string[] = [];

const logger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe('ImportHandler metadata rebuild', () => {
  it('waits for the real rebuilder before reporting the imported package as refreshed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'import-handler-'));
    temporaryDirectories.push(root);
    const storagePath = path.join(root, 'storage');
    const exportPath = path.join(root, 'export');
    const packageFile = 'demo/demo-2.0.0.tgz';
    const archivePath = path.join(root, 'diff-export.tar.gz');
    await mkdir(path.join(exportPath, 'demo'), { recursive: true });
    await mkdir(storagePath, { recursive: true });
    await writeFile(path.join(exportPath, packageFile), 'tarball-content');

    const manifest: ExportManifest = {
      version: 1,
      exportId: 'export-1',
      timestamp: new Date().toISOString(),
      type: 'incremental',
      files: [{
        path: packageFile,
        size: 15,
        mtime: new Date().toISOString(),
        checksum: 'unused',
        type: 'tarball',
        packageName: 'demo',
        version: '2.0.0'
      }],
      stats: { totalFiles: 1, totalSize: 15, packages: 1, versions: 1 }
    };
    await writeFile(
      path.join(exportPath, '.export-manifest.json'),
      JSON.stringify(manifest)
    );
    await tar.create({
      cwd: exportPath,
      file: archivePath,
      gzip: true
    }, ['.export-manifest.json', packageFile]);

    const rebuiltPackages: string[][] = [];
    const progressEvents: ImportProgress[] = [];
    const handler = new ImportHandler(
      storagePath,
      logger,
      async (packageNames, onProgress) => {
        rebuiltPackages.push(packageNames);
        onProgress?.(1, 1, packageNames[0]);
      }
    );

    const result = await handler.importPackage(
      archivePath,
      { rebuildMetadata: true, validateChecksum: false },
      (progress) => progressEvents.push(progress)
    );

    assert.equal(result.success, true);
    assert.equal(result.metadataRebuilt, true);
    assert.deepEqual(rebuiltPackages, [['demo']]);
    assert.equal(
      await readFile(path.join(storagePath, packageFile), 'utf8'),
      'tarball-content'
    );
    assert.equal(
      progressEvents.some(({ phaseDescription }) =>
        phaseDescription === '元数据重建完成，本地包列表已刷新'
      ),
      true
    );
  });
});
