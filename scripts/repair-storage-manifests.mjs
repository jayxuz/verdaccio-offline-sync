#!/usr/bin/env node

import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_FIELDS = [
  'versions',
  'dist-tags',
  '_attachments',
  '_distfiles',
  '_uplinks',
  'time'
];
const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set([
  'EBADF',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EPERM'
]);
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(['EACCES', 'EISDIR']);

class UsageError extends Error {}

class AtomicWriteError extends Error {
  constructor(message, cause, renamed) {
    super(message, { cause });
    this.renamed = renamed;
  }
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractTarballFilename(tarball) {
  if (typeof tarball !== 'string' || tarball.length === 0) {
    return undefined;
  }

  const path = tarball.split(/[?#]/, 1)[0];
  const filename = path.slice(path.lastIndexOf('/') + 1);
  return filename.endsWith('.tgz') ? filename : undefined;
}

export function normalizeManifest(manifest) {
  if (!isMap(manifest)) {
    throw new TypeError('清单根节点必须是对象');
  }

  let changed = false;
  const missingAttachments = isMap(manifest._attachments) ? 0 : 1;
  const missingDistfiles = isMap(manifest._distfiles) ? 0 : 1;
  let backfilledDistfiles = 0;

  for (const field of MAP_FIELDS) {
    if (!isMap(manifest[field])) {
      manifest[field] = {};
      changed = true;
    }
  }

  for (const version of Object.values(manifest.versions)) {
    if (!isMap(version) || !isMap(version.dist)) {
      continue;
    }

    const filename = extractTarballFilename(version.dist.tarball);
    if (!filename) {
      continue;
    }

    const currentValue = manifest._distfiles[filename];
    const record = isMap(currentValue) ? currentValue : {};
    let recordChanged = !isMap(currentValue);

    if ((typeof record.url !== 'string' || record.url.length === 0)
      && typeof version.dist.tarball === 'string'
      && version.dist.tarball.length > 0) {
      record.url = version.dist.tarball;
      recordChanged = true;
    }
    if ((typeof record.sha !== 'string' || record.sha.length === 0)
      && typeof version.dist.shasum === 'string'
      && version.dist.shasum.length > 0) {
      record.sha = version.dist.shasum;
      recordChanged = true;
    }

    if (recordChanged) {
      manifest._distfiles[filename] = record;
      backfilledDistfiles += 1;
      changed = true;
    }
  }

  return {
    manifest,
    changed,
    missingAttachments,
    missingDistfiles,
    backfilledDistfiles
  };
}

function isSameOrInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (pathFromParent !== '..'
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent));
}

function validateOptions({ storage, apply, backupDir }) {
  if (!storage) {
    throw new UsageError('必须提供 --storage /absolute/storage/data');
  }
  if (!isAbsolute(storage)) {
    throw new UsageError('storage 必须是绝对路径');
  }
  if (apply && !backupDir) {
    throw new UsageError('--apply 必须同时提供 --backup-dir');
  }
  if (backupDir && !isAbsolute(backupDir)) {
    throw new UsageError('backup-dir 必须是绝对路径');
  }

  const resolvedStorage = resolve(storage);
  const resolvedBackup = backupDir ? resolve(backupDir) : undefined;
  if (resolvedBackup && isSameOrInside(resolvedStorage, resolvedBackup)) {
    throw new UsageError('backup 目录不能与 storage 相同或位于 storage 内部');
  }

  return {
    storage: resolvedStorage,
    apply: Boolean(apply),
    backupDir: resolvedBackup
  };
}

function createReport() {
  return {
    scan: 0,
    wouldModify: 0,
    modified: 0,
    missingAttachments: 0,
    missingDistfiles: 0,
    parseErrors: 0,
    backfilledDistfiles: 0,
    backups: 0,
    fileErrors: 0,
    errors: []
  };
}

function displayPath(storage, path) {
  const pathFromStorage = relative(storage, path);
  if (pathFromStorage === '') {
    return '.';
  }
  if (isAbsolute(pathFromStorage) || pathFromStorage === '..' || pathFromStorage.startsWith(`..${sep}`)) {
    return path;
  }
  return pathFromStorage.split(sep).join('/');
}

function recordFileError(report, storage, path, stage, error) {
  report.fileErrors += 1;
  report.errors.push({
    path: displayPath(storage, path),
    stage,
    message: error instanceof Error ? error.message : String(error)
  });
}

async function inspectSafePath(path, canonicalStorage, expectedKind) {
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw new Error(`拒绝符号链接：${path}`);
  }
  if (expectedKind === 'directory' && !before.isDirectory()) {
    throw new Error(`预期目录：${path}`);
  }
  if (expectedKind === 'file' && !before.isFile()) {
    throw new Error(`预期普通文件：${path}`);
  }

  const canonicalBefore = await realpath(path);
  if (!isSameOrInside(canonicalStorage, canonicalBefore)) {
    throw new Error(`路径越出 storage：${path}`);
  }

  const after = await lstat(path);
  if (after.isSymbolicLink()) {
    throw new Error(`检查期间路径变为符号链接：${path}`);
  }
  const canonicalAfter = await realpath(path);
  if (canonicalAfter !== canonicalBefore || !isSameOrInside(canonicalStorage, canonicalAfter)) {
    throw new Error(`检查期间路径发生变化：${path}`);
  }
  return canonicalAfter;
}

async function ensureStorageDirectory(storage) {
  let storageStat;
  try {
    storageStat = await lstat(storage);
  } catch (error) {
    throw new Error(`无法访问 storage：${storage}`, { cause: error });
  }
  if (storageStat.isSymbolicLink()) {
    throw new Error(`storage 不能是符号链接：${storage}`);
  }
  if (!storageStat.isDirectory()) {
    throw new Error(`storage 不是目录：${storage}`);
  }
  return realpath(storage);
}

async function findManifestPaths(storage, canonicalStorage, report) {
  const manifests = [];

  async function visit(directory) {
    let entries;
    try {
      const canonicalBefore = await inspectSafePath(directory, canonicalStorage, 'directory');
      entries = await readdir(directory, { withFileTypes: true });
      const canonicalAfter = await inspectSafePath(directory, canonicalStorage, 'directory');
      if (canonicalAfter !== canonicalBefore) {
        throw new Error(`扫描期间目录发生变化：${directory}`);
      }
    } catch (error) {
      recordFileError(report, storage, directory, 'scan', error);
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        recordFileError(report, storage, path, 'scan', new Error(`拒绝符号链接：${path}`));
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        report.scan += 1;
        try {
          await inspectSafePath(path, canonicalStorage, 'file');
          manifests.push(path);
        } catch (error) {
          recordFileError(report, storage, path, 'scan', error);
        }
      }
    }
  }

  await visit(storage);
  return manifests;
}

async function readSafeStorageFile(path, canonicalStorage) {
  const canonicalBefore = await inspectSafePath(path, canonicalStorage, 'file');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const handle = await open(path, flags);
  let bytes;
  let fileStat;
  try {
    fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`预期普通文件：${path}`);
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const canonicalAfter = await inspectSafePath(path, canonicalStorage, 'file');
  if (canonicalAfter !== canonicalBefore) {
    throw new Error(`读取期间文件路径发生变化：${path}`);
  }
  return { bytes, stat: fileStat };
}

async function assertSnapshotUnchanged(path, canonicalStorage, originalBytes) {
  const current = await readSafeStorageFile(path, canonicalStorage);
  if (!current.bytes.equals(originalBytes)) {
    throw new Error(`清单在修复期间已被其他进程修改：${path}`);
  }
}

function isUnsupportedDirectoryFsyncError(error) {
  return DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code)
    || (process.platform === 'win32'
      && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code));
}

async function syncDirectoryWithFallback(directory, syncDirectory) {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if (!isUnsupportedDirectoryFsyncError(error)) {
      throw error;
    }
  }
}

export async function ensureDirectoryComponent(path, syncDirectory, fileSystem = {
  lstat,
  mkdir,
  realpath
}) {
  let created = false;
  let before;
  try {
    before = await fileSystem.lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    try {
      await fileSystem.mkdir(path);
      created = true;
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') {
        throw mkdirError;
      }
    }
    before = await fileSystem.lstat(path);
  }

  if (before.isSymbolicLink()) {
    throw new Error(`备份路径包含符号链接：${path}`);
  }
  if (!before.isDirectory()) {
    throw new Error(`备份路径组件不是目录：${path}`);
  }
  const canonicalBefore = await fileSystem.realpath(path);
  const after = await fileSystem.lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error(`检查期间备份目录发生变化：${path}`);
  }
  const canonicalAfter = await fileSystem.realpath(path);
  if (canonicalAfter !== canonicalBefore) {
    throw new Error(`检查期间备份目录发生变化：${path}`);
  }
  if (created) {
    await syncDirectoryWithFallback(dirname(path), syncDirectory);
    await syncDirectoryWithFallback(path, syncDirectory);
  }
  return canonicalAfter;
}

async function ensureBackupRoot(backupDir, canonicalStorage, dependencies) {
  const root = parse(backupDir).root;
  let current = root;
  let canonicalCurrent = await ensureDirectoryComponent(root, dependencies.syncBackupDirectory);
  const segments = relative(root, backupDir).split(sep).filter(Boolean);

  for (const segment of segments) {
    current = join(current, segment);
    canonicalCurrent = await ensureDirectoryComponent(current, dependencies.syncBackupDirectory);
  }
  if (isSameOrInside(canonicalStorage, canonicalCurrent)) {
    throw new Error('backup 目录不能与 storage 相同或位于 storage 内部');
  }
  return canonicalCurrent;
}

async function ensureBackupParent(
  backupDir,
  canonicalBackup,
  relativePath,
  canonicalStorage,
  dependencies
) {
  const relativeDirectory = dirname(relativePath);
  if (relativeDirectory === '.') {
    return canonicalBackup;
  }
  if (isAbsolute(relativeDirectory)
    || relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`)) {
    throw new Error(`非法备份相对路径：${relativePath}`);
  }

  let current = backupDir;
  let canonicalCurrent = canonicalBackup;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, segment);
    canonicalCurrent = await ensureDirectoryComponent(current, dependencies.syncBackupDirectory);
    if (!isSameOrInside(canonicalBackup, canonicalCurrent)) {
      throw new Error(`备份目录越界：${current}`);
    }
    if (isSameOrInside(canonicalStorage, canonicalCurrent)) {
      throw new Error(`备份目录指向 storage：${current}`);
    }
  }
  return canonicalCurrent;
}

async function readSafeBackupFile(path, canonicalBackup, canonicalStorage) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`备份目标不是安全的普通文件：${path}`);
  }
  const canonicalPath = await realpath(path);
  if (!isSameOrInside(canonicalBackup, canonicalPath)
    || isSameOrInside(canonicalStorage, canonicalPath)) {
    throw new Error(`备份目标越界：${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function backupManifestBytes({
  destination,
  originalBytes,
  mode,
  canonicalBackup,
  canonicalStorage,
  dependencies
}) {
  const parentDirectory = dirname(destination);
  const tempPath = join(
    parentDirectory,
    `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`
  );
  let handle;
  let tempStat;
  let published = false;
  let finalValidated = false;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW || 0),
      mode
    );
    tempStat = await handle.stat();
    await handle.writeFile(originalBytes);
    await handle.chmod(mode & 0o7777);
    await dependencies.beforeBackupFileSync?.({ path: destination, tempPath });
    await handle.sync();
    await dependencies.afterBackupFileSync?.({ path: destination, tempPath });
    await handle.close();
    handle = undefined;

    try {
      await link(tempPath, destination);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const existingBytes = await readSafeBackupFile(destination, canonicalBackup, canonicalStorage);
      if (!existingBytes.equals(originalBytes)) {
        throw new Error(`备份目标已存在且内容不同：${destination}`);
      }
      finalValidated = true;
    }

    if (published) {
      const writtenBytes = await readSafeBackupFile(destination, canonicalBackup, canonicalStorage);
      if (!writtenBytes.equals(originalBytes)) {
        throw new Error(`备份写入后内容不一致：${destination}`);
      }
      finalValidated = true;
    }
    await rm(tempPath, { force: true });
    await syncDirectoryWithFallback(parentDirectory, dependencies.syncBackupDirectory);
    await dependencies.afterBackupDirectorySync?.({ path: destination, directory: parentDirectory });
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (published && !finalValidated && tempStat) {
      try {
        const destinationStat = await lstat(destination);
        if (destinationStat.dev === tempStat.dev && destinationStat.ino === tempStat.ino) {
          await rm(destination, { force: true });
        }
      } catch {
        // 最终路径可能尚未发布或已由其他进程移除；不要删除身份不明的文件。
      }
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson({
  path,
  manifest,
  originalBytes,
  mode,
  canonicalStorage,
  dependencies
}) {
  const directory = dirname(path);
  const tempPath = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`
  );
  let handle;
  let renamed = false;

  try {
    await inspectSafePath(directory, canonicalStorage, 'directory');
    handle = await open(
      tempPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW || 0),
      mode
    );
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.chmod(mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await dependencies.beforeRename?.({ path });
    await assertSnapshotUnchanged(path, canonicalStorage, originalBytes);
    await inspectSafePath(directory, canonicalStorage, 'directory');
    await rename(tempPath, path);
    renamed = true;

    await syncDirectoryWithFallback(directory, dependencies.syncDirectory);
    return { renamed: true };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (!renamed) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
    throw new AtomicWriteError(error.message, error, renamed);
  }
}

export async function repairStorageManifests(options, injectedDependencies = {}) {
  const { storage, apply, backupDir } = validateOptions(options);
  const report = createReport();
  const dependencies = {
    beforeBackup: undefined,
    beforeBackupFileSync: undefined,
    afterBackupFileSync: undefined,
    afterBackupDirectorySync: undefined,
    beforeRename: undefined,
    syncDirectory: fsyncDirectory,
    syncBackupDirectory: fsyncDirectory,
    ...injectedDependencies
  };
  const canonicalStorage = await ensureStorageDirectory(storage);
  let canonicalBackup;

  if (apply) {
    try {
      canonicalBackup = await ensureBackupRoot(backupDir, canonicalStorage, dependencies);
    } catch (error) {
      recordFileError(report, storage, backupDir, 'backup', error);
      return report;
    }
  }

  const manifestPaths = await findManifestPaths(storage, canonicalStorage, report);
  for (const manifestPath of manifestPaths) {
    let original;
    try {
      original = await readSafeStorageFile(manifestPath, canonicalStorage);
    } catch (error) {
      recordFileError(report, storage, manifestPath, 'read', error);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(original.bytes.toString('utf8'));
    } catch (error) {
      report.parseErrors += 1;
      recordFileError(report, storage, manifestPath, 'parse', error);
      continue;
    }

    let normalized;
    try {
      normalized = normalizeManifest(manifest);
    } catch (error) {
      recordFileError(report, storage, manifestPath, 'normalize', error);
      continue;
    }
    report.missingAttachments += normalized.missingAttachments;
    report.missingDistfiles += normalized.missingDistfiles;
    report.backfilledDistfiles += normalized.backfilledDistfiles;
    if (!normalized.changed) {
      continue;
    }

    if (!apply) {
      report.wouldModify += 1;
      continue;
    }

    try {
      await dependencies.beforeBackup?.({ path: manifestPath });
      await assertSnapshotUnchanged(manifestPath, canonicalStorage, original.bytes);
    } catch (error) {
      recordFileError(report, storage, manifestPath, 'snapshot', error);
      continue;
    }

    const relativePath = relative(storage, manifestPath);
    const backupPath = join(backupDir, relativePath);
    try {
      await ensureBackupParent(
        backupDir,
        canonicalBackup,
        relativePath,
        canonicalStorage,
        dependencies
      );
      await backupManifestBytes({
        destination: backupPath,
        originalBytes: original.bytes,
        mode: original.stat.mode,
        canonicalBackup,
        canonicalStorage,
        dependencies
      });
      // backups 表示本轮修改尝试已有安全备份保障；复用同内容备份也计 1。
      report.backups += 1;
    } catch (error) {
      recordFileError(report, storage, manifestPath, 'backup', error);
      continue;
    }

    try {
      const result = await atomicWriteJson({
        path: manifestPath,
        manifest: normalized.manifest,
        originalBytes: original.bytes,
        mode: original.stat.mode,
        canonicalStorage,
        dependencies
      });
      if (result.renamed) {
        report.modified += 1;
      }
    } catch (error) {
      if (error.renamed) {
        report.modified += 1;
      }
      recordFileError(report, storage, manifestPath, 'write', error);
    }
  }

  return report;
}

export function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--storage' || argument === '--backup-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new UsageError(`${argument} 缺少路径参数`);
      }
      const key = argument === '--storage' ? 'storage' : 'backupDir';
      if (options[key] !== undefined) {
        throw new UsageError(`${argument} 不能重复提供`);
      }
      options[key] = value;
      index += 1;
    } else {
      throw new UsageError(`未知参数：${argument}`);
    }
  }
  return validateOptions(options);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    const report = await repairStorageManifests(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.fileErrors > 0) {
      for (const error of report.errors) {
        process.stderr.write(`${error.path} [${error.stage}]: ${error.message}\n`);
      }
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  process.exitCode = await main();
}
