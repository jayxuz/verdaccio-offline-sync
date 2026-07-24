import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import {
  ensureDirectoryComponent,
  normalizeManifest,
  repairStorageManifests
} from './repair-storage-manifests.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(projectRoot, 'scripts', 'repair-storage-manifests.mjs');
const temporaryDirectories = [];
const cliEnvironment = { ...process.env };
delete cliEnvironment.NODE_TEST_CONTEXT;

async function makeTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join('/tmp', prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function completeMaps(overrides = {}) {
  return {
    versions: {},
    'dist-tags': {},
    _attachments: {},
    _distfiles: {},
    _uplinks: {},
    time: {},
    ...overrides
  };
}

async function createStorageFixtures() {
  const root = await makeTemporaryDirectory('verdaccio-manifest-storage-');
  const storage = join(root, 'storage', 'data');
  const paths = {
    healthy: join(storage, 'healthy', 'package.json'),
    missingAttachments: join(storage, '@scope', 'missing-attachments', 'package.json'),
    missingDistfiles: join(storage, 'missing-distfiles', 'package.json'),
    invalid: join(storage, 'invalid', 'package.json'),
    tarball: join(storage, 'missing-distfiles', 'missing-distfiles-2.0.0.tgz')
  };

  await writeJson(paths.healthy, {
    name: 'healthy',
    ...completeMaps({
      versions: {
        '1.0.0': {
          name: 'healthy',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.example/healthy/-/healthy-1.0.0.tgz',
            shasum: 'healthy-sha'
          }
        }
      },
      _attachments: {
        'healthy-1.0.0.tgz': { shasum: 'attachment-must-stay' }
      },
      _distfiles: {
        'healthy-1.0.0.tgz': {
          url: 'https://registry.example/healthy/-/healthy-1.0.0.tgz',
          sha: 'healthy-sha'
        }
      }
    })
  });

  await writeJson(paths.missingAttachments, {
    name: '@scope/missing-attachments',
    ...completeMaps({
      versions: {
        '1.0.0': {
          name: '@scope/missing-attachments',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.example/@scope/missing-attachments/-/missing-attachments-1.0.0.tgz',
            shasum: 'sha-one'
          }
        }
      },
      _distfiles: {
        'missing-attachments-1.0.0.tgz': {
          url: 'https://local.example/preserved.tgz'
        }
      },
      _attachments: undefined
    })
  });

  await writeJson(paths.missingDistfiles, {
    name: 'missing-distfiles',
    ...completeMaps({
      versions: {
        '2.0.0': {
          name: 'missing-distfiles',
          version: '2.0.0',
          dist: {
            tarball: 'https://registry.example/missing-distfiles/-/missing-distfiles-2.0.0.tgz?download=1',
            shasum: 'sha-two'
          }
        }
      },
      _distfiles: undefined
    })
  });

  await mkdir(dirname(paths.invalid), { recursive: true });
  await writeFile(paths.invalid, '{ definitely-not-json\n');
  await writeFile(paths.tarball, 'tarball bytes must not be deleted');

  return { root, storage, paths };
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: cliEnvironment
  });
}

function parseReport(result) {
  assert.notEqual(
    result.stdout.trim(),
    '',
    `CLI 没有输出报告；status=${result.status} signal=${result.signal} error=${result.error?.message || ''} stderr: ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

function reportCounts(report) {
  const { errors, ...counts } = report;
  return counts;
}

async function snapshot(path) {
  return {
    bytes: await readFile(path),
    mtimeNs: (await stat(path, { bigint: true })).mtimeNs
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })));
});

describe('repair-storage-manifests CLI', () => {
  it('作为模块导入时不会自动执行 CLI', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(new URL('./repair-storage-manifests.mjs', import.meta.url).href)})`
    ], { cwd: projectRoot, encoding: 'utf8', env: cliEnvironment });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('默认 dry-run 只报告，保持所有清单的字节和 mtime 不变', async () => {
    const { storage, paths } = await createStorageFixtures();
    const manifestPaths = [
      paths.healthy,
      paths.missingAttachments,
      paths.missingDistfiles,
      paths.invalid
    ];
    const before = new Map(await Promise.all(manifestPaths.map(async (path) => [path, await snapshot(path)])));

    const result = runCli(['--storage', storage]);
    const report = parseReport(result);

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(reportCounts(report), {
      scan: 4,
      wouldModify: 2,
      modified: 0,
      missingAttachments: 1,
      missingDistfiles: 1,
      parseErrors: 1,
      backfilledDistfiles: 2,
      backups: 0,
      fileErrors: 1
    });
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].path, 'invalid/package.json');
    assert.equal(report.errors[0].stage, 'parse');
    for (const path of manifestPaths) {
      const after = await snapshot(path);
      assert.deepEqual(after.bytes, before.get(path).bytes, path);
      assert.equal(after.mtimeNs, before.get(path).mtimeNs, path);
    }
  });

  it('拒绝相对路径、storage 内备份目录以及缺少备份目录的 apply', async () => {
    const { root, storage, paths } = await createStorageFixtures();
    const before = await snapshot(paths.missingAttachments);
    const cases = [
      {
        args: ['--storage', 'relative/storage'],
        message: /storage.*绝对路径/i
      },
      {
        args: ['--storage', storage, '--apply'],
        message: /apply.*backup-dir/i
      },
      {
        args: ['--storage', storage, '--apply', '--backup-dir', join(storage, 'backup')],
        message: /backup.*storage/i
      },
      {
        args: ['--storage', storage, '--apply', '--backup-dir', 'relative/backup'],
        message: /backup-dir.*绝对路径/i
      }
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, testCase.message);
    }

    assert.deepEqual((await snapshot(paths.missingAttachments)), before);
    assert.equal((await stat(root)).isDirectory(), true);
  });

  it('拒绝经符号链接解析后位于 storage 内的备份目录', async () => {
    const { root, storage, paths } = await createStorageFixtures();
    const storageAlias = join(root, 'storage-alias');
    await symlink(storage, storageAlias, 'dir');
    const before = await snapshot(paths.missingAttachments);

    const result = runCli([
      '--storage',
      storage,
      '--apply',
      '--backup-dir',
      join(storageAlias, 'backup')
    ]);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /backup.*storage/i);
    assert.deepEqual(await snapshot(paths.missingAttachments), before);
  });

  it('拒绝 storage 内指向外部目录的符号链接且不读取或修改外部清单', async () => {
    const root = await makeTemporaryDirectory('verdaccio-storage-symlink-');
    const storage = join(root, 'storage');
    const external = join(root, 'external');
    const externalManifest = join(external, 'package.json');
    const backup = join(root, 'backup');
    await mkdir(storage, { recursive: true });
    await writeJson(externalManifest, { name: 'outside' });
    await symlink(external, join(storage, 'escape'), 'dir');
    const before = await snapshot(externalManifest);

    const result = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    const report = parseReport(result);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(report.fileErrors, 1);
    assert.equal(report.modified, 0);
    assert.equal(report.backups, 0);
    assert.equal(report.errors[0].stage, 'scan');
    assert.match(report.errors[0].message, /符号链接/);
    assert.deepEqual(await snapshot(externalManifest), before);
  });

  it('拒绝 backup 子目录指向 storage 的符号链接且不修改原清单', async () => {
    const root = await makeTemporaryDirectory('verdaccio-backup-symlink-');
    const storage = join(root, 'storage');
    const manifestPath = join(storage, 'package', 'package.json');
    const backup = join(root, 'backup');
    await writeJson(manifestPath, { name: 'package' });
    await mkdir(backup, { recursive: true });
    await symlink(dirname(manifestPath), join(backup, 'package'), 'dir');
    const before = await snapshot(manifestPath);

    const result = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    const report = parseReport(result);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(report.fileErrors, 1);
    assert.equal(report.modified, 0);
    assert.equal(report.backups, 0);
    assert.equal(report.errors[0].stage, 'backup');
    assert.match(report.errors[0].message, /符号链接/);
    assert.deepEqual(await snapshot(manifestPath), before);
  });

  it('apply 先按相对路径备份，再修复清单且不覆盖坏 JSON 或删除 tgz', async () => {
    const { root, storage, paths } = await createStorageFixtures();
    const backup = join(root, 'backup');
    const originalMissingAttachments = await readFile(paths.missingAttachments);
    const originalMissingDistfiles = await readFile(paths.missingDistfiles);
    const originalInvalid = await snapshot(paths.invalid);

    const result = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    const report = parseReport(result);

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(reportCounts(report), {
      scan: 4,
      wouldModify: 0,
      modified: 2,
      missingAttachments: 1,
      missingDistfiles: 1,
      parseErrors: 1,
      backfilledDistfiles: 2,
      backups: 2,
      fileErrors: 1
    });
    assert.equal(report.errors.length, 1);
    assert.deepEqual(
      await readFile(join(backup, '@scope', 'missing-attachments', 'package.json')),
      originalMissingAttachments
    );
    assert.deepEqual(
      await readFile(join(backup, 'missing-distfiles', 'package.json')),
      originalMissingDistfiles
    );

    const repairedAttachments = JSON.parse(await readFile(paths.missingAttachments, 'utf8'));
    assert.deepEqual(repairedAttachments._attachments, {});
    assert.deepEqual(repairedAttachments._distfiles['missing-attachments-1.0.0.tgz'], {
      url: 'https://local.example/preserved.tgz',
      sha: 'sha-one'
    });

    const repairedDistfiles = JSON.parse(await readFile(paths.missingDistfiles, 'utf8'));
    assert.deepEqual(repairedDistfiles._distfiles['missing-distfiles-2.0.0.tgz'], {
      url: 'https://registry.example/missing-distfiles/-/missing-distfiles-2.0.0.tgz?download=1',
      sha: 'sha-two'
    });
    assert.deepEqual(repairedDistfiles._attachments, {});
    assert.equal((await readFile(paths.missingDistfiles, 'utf8')).endsWith('\n'), true);
    assert.equal(await readFile(paths.tarball, 'utf8'), 'tarball bytes must not be deleted');
    assert.deepEqual(await snapshot(paths.invalid), originalInvalid);
    assert.deepEqual(
      JSON.parse(await readFile(paths.healthy, 'utf8'))._attachments,
      { 'healthy-1.0.0.tgz': { shasum: 'attachment-must-stay' } }
    );

    const leftovers = (await import('node:fs/promises')).readdir(dirname(paths.missingDistfiles));
    assert.equal((await leftovers).some((name) => name.includes('.tmp-')), false);
  });

  it('第二次 apply 修改数和备份数均为零', async () => {
    const { root, storage } = await createStorageFixtures();
    const backup = join(root, 'backup');

    const first = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    assert.equal(parseReport(first).modified, 2);

    const second = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    const report = parseReport(second);

    assert.equal(second.status, 1, second.stderr);
    assert.equal(report.modified, 0);
    assert.equal(report.wouldModify, 0);
    assert.equal(report.backups, 0);
    assert.equal(report.parseErrors, 1);
  });

  it('备份目标已有不同内容时失败且不修改原清单', async () => {
    const { root, storage, paths } = await createStorageFixtures();
    const backup = join(root, 'backup');
    const conflictingBackup = join(backup, '@scope', 'missing-attachments', 'package.json');
    await mkdir(dirname(conflictingBackup), { recursive: true });
    await writeFile(conflictingBackup, 'different backup');
    const before = await snapshot(paths.missingAttachments);

    const result = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);

    const report = parseReport(result);
    assert.equal(result.status, 1);
    assert.equal(report.fileErrors, 2);
    assert.equal(report.modified, 1);
    assert.equal(report.backups, 1);
    assert.match(result.stderr, /备份.*已存在.*不同/i);
    assert.deepEqual(await snapshot(paths.missingAttachments), before);
  });

  it('missingDistfiles 按缺失或非法字段的 manifest 数统计而非 entry 数', () => {
    const withoutVersions = normalizeManifest({ name: 'empty' });
    assert.equal(withoutVersions.missingDistfiles, 1);
    assert.equal(withoutVersions.backfilledDistfiles, 0);

    const multipleVersions = normalizeManifest({
      name: 'multiple',
      versions: {
        '1.0.0': { dist: { tarball: 'https://example.test/a-1.0.0.tgz' } },
        '2.0.0': { dist: { tarball: 'https://example.test/a-2.0.0.tgz' } }
      },
      _distfiles: null
    });
    assert.equal(multipleVersions.missingDistfiles, 1);
    assert.equal(multipleVersions.backfilledDistfiles, 2);

    const validButEmpty = normalizeManifest({
      name: 'valid-map',
      versions: {
        '1.0.0': { dist: { tarball: 'https://example.test/a-1.0.0.tgz' } },
        '2.0.0': { dist: { tarball: 'https://example.test/a-2.0.0.tgz' } }
      },
      _distfiles: {}
    });
    assert.equal(validButEmpty.missingDistfiles, 0);
    assert.equal(validButEmpty.backfilledDistfiles, 2);
  });

  it('首次读取后文件变化时拒绝备份和覆盖并继续报告', async () => {
    const root = await makeTemporaryDirectory('verdaccio-snapshot-before-backup-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const manifestPath = join(storage, 'package', 'package.json');
    await writeJson(manifestPath, { name: 'package' });
    const concurrentBytes = Buffer.from('{"name":"concurrent"}\n');

    const report = await repairStorageManifests(
      { storage, apply: true, backupDir: backup },
      {
        beforeBackup: async ({ path }) => {
          if (path === manifestPath) {
            await writeFile(path, concurrentBytes);
          }
        }
      }
    );

    assert.equal(report.modified, 0);
    assert.equal(report.backups, 0);
    assert.equal(report.fileErrors, 1);
    assert.equal(report.errors[0].stage, 'snapshot');
    assert.deepEqual(await readFile(manifestPath), concurrentBytes);
  });

  it('rename 前文件变化时拒绝覆盖并保留来自原快照的安全备份', async () => {
    const root = await makeTemporaryDirectory('verdaccio-snapshot-before-rename-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const manifestPath = join(storage, 'package', 'package.json');
    await writeJson(manifestPath, { name: 'package' });
    const originalBytes = await readFile(manifestPath);
    const concurrentBytes = Buffer.from('{"name":"concurrent"}\n');

    const report = await repairStorageManifests(
      { storage, apply: true, backupDir: backup },
      {
        beforeRename: async ({ path }) => {
          if (path === manifestPath) {
            await writeFile(path, concurrentBytes);
          }
        }
      }
    );

    assert.equal(report.modified, 0);
    assert.equal(report.backups, 1);
    assert.equal(report.fileErrors, 1);
    assert.equal(report.errors[0].stage, 'write');
    assert.deepEqual(await readFile(manifestPath), concurrentBytes);
    assert.deepEqual(await readFile(join(backup, 'package', 'package.json')), originalBytes);
  });

  it('合法 JSON 非对象只记录错误并继续修复其他文件', async () => {
    const root = await makeTemporaryDirectory('verdaccio-file-errors-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const invalidManifest = join(storage, 'a-invalid', 'package.json');
    const repairableManifest = join(storage, 'b-repairable', 'package.json');
    await mkdir(dirname(invalidManifest), { recursive: true });
    await writeFile(invalidManifest, 'null\n');
    await writeJson(repairableManifest, { name: 'repairable' });

    const result = runCli(['--storage', storage, '--apply', '--backup-dir', backup]);
    const report = parseReport(result);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(report.scan, 2);
    assert.equal(report.fileErrors, 1);
    assert.equal(report.modified, 1);
    assert.equal(report.backups, 1);
    assert.equal(report.errors[0].path, 'a-invalid/package.json');
    assert.equal(report.errors[0].stage, 'normalize');
    assert.equal(await readFile(invalidManifest, 'utf8'), 'null\n');
    assert.deepEqual(JSON.parse(await readFile(repairableManifest, 'utf8'))._attachments, {});
  });

  it('目录 fsync 明确不支持时降级成功，其他错误在 rename 后准确计数', async () => {
    const unsupportedRoot = await makeTemporaryDirectory('verdaccio-fsync-unsupported-');
    const unsupportedStorage = join(unsupportedRoot, 'storage');
    const unsupportedBackup = join(unsupportedRoot, 'backup');
    await writeJson(join(unsupportedStorage, 'package', 'package.json'), { name: 'package' });
    const unsupportedError = Object.assign(new Error('unsupported'), { code: 'EINVAL' });

    const degradedReport = await repairStorageManifests(
      { storage: unsupportedStorage, apply: true, backupDir: unsupportedBackup },
      { syncDirectory: async () => { throw unsupportedError; } }
    );
    assert.equal(degradedReport.modified, 1);
    assert.equal(degradedReport.backups, 1);
    assert.equal(degradedReport.fileErrors, 0);

    const failedRoot = await makeTemporaryDirectory('verdaccio-fsync-failed-');
    const failedStorage = join(failedRoot, 'storage');
    const failedBackup = join(failedRoot, 'backup');
    await writeJson(join(failedStorage, 'package', 'package.json'), { name: 'package' });
    const ioError = Object.assign(new Error('directory sync failed'), { code: 'EIO' });
    const failedReport = await repairStorageManifests(
      { storage: failedStorage, apply: true, backupDir: failedBackup },
      { syncDirectory: async () => { throw ioError; } }
    );
    assert.equal(failedReport.modified, 1);
    assert.equal(failedReport.backups, 1);
    assert.equal(failedReport.fileErrors, 1);
    assert.equal(failedReport.errors[0].stage, 'write');
  });

  it('严格 umask 下仍恢复原清单和备份的源文件权限', async () => {
    const root = await makeTemporaryDirectory('verdaccio-mode-preservation-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const manifestPath = join(storage, 'package', 'package.json');
    const backupPath = join(backup, 'package', 'package.json');
    await writeJson(manifestPath, { name: 'package' });
    await chmod(manifestPath, 0o640);
    const previousUmask = process.umask(0o077);

    try {
      const report = await repairStorageManifests({ storage, apply: true, backupDir: backup });
      assert.equal(report.modified, 1);
      assert.equal((await stat(manifestPath)).mode & 0o7777, 0o640);
      assert.equal((await stat(backupPath)).mode & 0o7777, 0o640);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('备份临时文件写入失败时不遗留最终文件或临时文件并可安全重试', async () => {
    const root = await makeTemporaryDirectory('verdaccio-backup-temp-failure-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const manifestPath = join(storage, 'package', 'package.json');
    const backupParent = join(backup, 'package');
    const backupPath = join(backupParent, 'package.json');
    await writeJson(manifestPath, { name: 'package' });

    const failedReport = await repairStorageManifests(
      { storage, apply: true, backupDir: backup },
      {
        beforeBackupFileSync: async () => {
          throw new Error('injected backup sync failure');
        }
      }
    );

    assert.equal(failedReport.modified, 0);
    assert.equal(failedReport.backups, 0);
    assert.equal(failedReport.fileErrors, 1);
    const failedEntries = await (await import('node:fs/promises')).readdir(backupParent);
    assert.equal(failedEntries.includes('package.json'), false);
    assert.equal(failedEntries.some((name) => name.includes('.tmp-')), false);

    const retryReport = await repairStorageManifests({ storage, apply: true, backupDir: backup });
    assert.equal(retryReport.modified, 1);
    assert.equal(retryReport.backups, 1);
    assert.equal((await stat(backupPath)).isFile(), true);
  });

  it('备份文件和父目录完成 fsync 后才允许 manifest rename', async () => {
    const root = await makeTemporaryDirectory('verdaccio-durability-order-');
    const storage = join(root, 'storage');
    const backup = join(root, 'backup');
    const manifestPath = join(storage, 'package', 'package.json');
    await writeJson(manifestPath, { name: 'package' });
    const events = [];

    const report = await repairStorageManifests(
      { storage, apply: true, backupDir: backup },
      {
        afterBackupFileSync: async () => events.push('backup-file-sync'),
        afterBackupDirectorySync: async () => events.push('backup-directory-sync'),
        beforeRename: async () => events.push('manifest-rename')
      }
    );

    assert.equal(report.modified, 1);
    assert.deepEqual(events, [
      'backup-file-sync',
      'backup-directory-sync',
      'manifest-rename'
    ]);
  });

  it('现有目录不会调用 mkdir，即使 mkdir 会返回 EPERM', async () => {
    let mkdirCalls = 0;
    const syncCalls = [];
    const directoryStat = {
      isSymbolicLink: () => false,
      isDirectory: () => true
    };

    const canonical = await ensureDirectoryComponent(
      '/existing-root',
      async (path) => syncCalls.push(path),
      {
        lstat: async () => directoryStat,
        mkdir: async () => {
          mkdirCalls += 1;
          throw Object.assign(new Error('access denied'), { code: 'EPERM' });
        },
        realpath: async () => '/existing-root'
      }
    );

    assert.equal(canonical, '/existing-root');
    assert.equal(mkdirCalls, 0);
    assert.deepEqual(syncCalls, []);
  });

  it('仅在 lstat 返回 ENOENT 时创建目录并同步父目录和自身', async () => {
    let exists = false;
    let mkdirCalls = 0;
    const syncCalls = [];
    const directoryStat = {
      isSymbolicLink: () => false,
      isDirectory: () => true
    };

    const canonical = await ensureDirectoryComponent(
      '/new-backup-root',
      async (path) => syncCalls.push(path),
      {
        lstat: async () => {
          if (!exists) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return directoryStat;
        },
        mkdir: async () => {
          mkdirCalls += 1;
          exists = true;
        },
        realpath: async (path) => path
      }
    );

    assert.equal(canonical, '/new-backup-root');
    assert.equal(mkdirCalls, 1);
    assert.deepEqual(syncCalls, ['/', '/new-backup-root']);
  });
});
