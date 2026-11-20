import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { link, lstat, mkdir, open, readdir, rename, rm } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { DifferentialPacker } from './differential-packer';
import { DifferentialScanner } from './differential-scanner';
import { normalizedDirectory, safeRelative, stableRead } from './mirror-core';
import { extractTarballVersion } from './tarball-version';
import { ExportManifest, ExportProgress, ExportRecord, ScannedFile } from './types';

interface FileFingerprint {
  checksum: string;
  size: number;
}

async function fingerprintExportFile(file: string): Promise<FileFingerprint> {
  const { sha256, size } = await stableRead(file);
  return { checksum: sha256, size };
}

async function syncExportDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface SnapshotEntry extends FileFingerprint {
  packageName: string;
  version: string;
}

interface SnapshotConflict {
  packageName: string;
  version: string;
  expected: FileFingerprint;
  actual: FileFingerprint;
  source: 'confirmed' | 'alias';
}

interface Attempt {
  exportId: string;
  target: string;
  createdAt: string;
  baseSnapshotId: string | null;
}

type SavedArchive = Attempt & {
  status: 'pending';
  archive: ExportRecord & { checksum: string; fileSize: number };
  // A candidate adds these entries to its predecessor. Confirmed entries are never removed.
  entries: SnapshotEntry[];
};

type SavedAttempt = SavedArchive | (Attempt & (
  { status: 'preparing' | 'empty' } |
  { status: 'failed'; error: string; conflicts?: SnapshotConflict[] }
));

interface Confirmation {
  exportId: string;
  archiveSha256: string;
  confirmedAt: string;
  confirmedBy: string;
}

export class SnapshotError extends Error {
  constructor(message: string, readonly statusCode: number, readonly conflicts?: SnapshotConflict[]) {
    super(message);
  }
}

export function snapshotTarget(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new SnapshotError('target must be 1–64 lowercase letters, digits, dots, underscores or hyphens and start with a letter or digit', 400);
  }
  return value;
}

function archiveId(value: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)) {
    throw new SnapshotError('Snapshot archive not found', 404);
  }
  return value;
}

function entryKey(entry: Pick<SnapshotEntry, 'packageName' | 'version'>): string {
  return `${entry.packageName}@${entry.version}`;
}

function matches(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.checksum === b.checksum && a.size === b.size;
}

function storageTarballIdentity(file: ScannedFile): Pick<SnapshotEntry, 'packageName' | 'version'> {
  const relative = safeRelative(file.relativePath);
  const packageName = normalizedDirectory(path.posix.dirname(relative));
  const version = extractTarballVersion(path.posix.basename(relative));
  if (!version) throw new Error(`Cannot determine npm tarball version: ${relative}`);
  return { packageName, version };
}

async function readJSON<T>(file: string): Promise<T | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Snapshot state must be a regular file');
      return JSON.parse(await handle.readFile('utf8')) as T;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function publishJSON(file: string, value: unknown, exclusive = false): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Linking a prepared file claims a predecessor atomically, even across processes.
    await (exclusive ? link(temp, file) : rename(temp, file));
    await syncExportDirectory(path.dirname(file));
  } finally {
    await rm(temp, { force: true });
  }
}

export class StandaloneSnapshots {
  constructor(
    private readonly storagePath: string,
    private readonly scanner: DifferentialScanner,
    private readonly packer: DifferentialPacker,
    private readonly concurrency: number
  ) {}

  async preview(target: string) {
    const base = await this.baseline(target);
    const plan = await this.plan(base.entries);
    return {
      target,
      baseSnapshotId: base.id,
      type: base.id ? 'incremental' : 'full',
      files: this.scanner.scannedFilesToEntries(plan.files).map(file => ({
        ...file,
        checksum: plan.fingerprints.get(file.path)!.checksum
      })),
      stats: this.scanner.calculateStats(plan.files),
      conflicts: plan.conflicts
    };
  }

  async create(target: string, exportId: string, onProgress: (progress: ExportProgress) => void) {
    const dir = this.directory(target);
    await this.checkDirectory(target, true);
    const file = this.recordPath(target, exportId);
    const attempt: Attempt = { exportId, target, createdAt: new Date().toISOString(), baseSnapshotId: null };
    await publishJSON(file, { ...attempt, status: 'preparing' }, true);
    try {
      const base = await this.baseline(target);
      attempt.baseSnapshotId = base.id;
      const plan = await this.plan(base.entries);
      if (plan.conflicts.length) {
        const first = plan.conflicts[0];
        throw new SnapshotError(
          `Snapshot has ${plan.conflicts.length} content conflict(s), including ${entryKey(first)}`, 409, plan.conflicts
        );
      }
      if (!plan.files.length) {
        await publishJSON(file, { ...attempt, status: 'empty' });
        return { exportId, filename: null, downloadUrl: null, fileSize: 0, stats: this.scanner.calculateStats([]) };
      }

      const trace: NonNullable<ExportManifest['snapshot']> = {
        mode: 'standalone-snapshot', target, baseSnapshotId: base.id, snapshotId: exportId
      };
      const result = await this.packer.createExportPackage(plan.files, {
        exportId, outputDir: dir, onProgress, snapshot: { trace, fingerprints: plan.fingerprints }
      });
      const archive = {
        ...this.packer.createExportRecord(exportId, result.filename, result.checksum, result.manifest),
        checksum: result.checksum,
        fileSize: result.size
      };
      const record: SavedArchive = { ...attempt, status: 'pending', archive, entries: plan.entries };
      await publishJSON(file, record);
      return {
        exportId,
        filename: archive.filename,
        downloadUrl: this.downloadUrl(record),
        fileSize: archive.fileSize,
        stats: result.manifest.stats,
        snapshot: { ...trace, archiveSha256: archive.checksum, status: 'pending' }
      };
    } catch (error) {
      if ((await readJSON<SavedAttempt>(file))?.status === 'preparing') {
        await publishJSON(file, {
          ...attempt,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          conflicts: error instanceof SnapshotError ? error.conflicts : undefined
        });
      }
      throw error;
    }
  }

  async status(target: string) {
    const base = await this.baseline(target);
    const dir = this.directory(target);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    const records = await Promise.all(names.filter(name => name.startsWith('archive-') && name.endsWith('.json'))
      .map(async name => {
        const record = (await readJSON<SavedAttempt>(path.join(dir, name)))!;
        if (record.status !== 'pending') return record;
        const { entries, archive, ...attempt } = record;
        const confirmation = base.confirmations.get(attempt.exportId);
        return {
          ...attempt,
          status: confirmation ? 'confirmed' : attempt.baseSnapshotId === base.id ? 'pending' : 'superseded',
          archive,
          downloadUrl: this.downloadUrl(record),
          confirmation
        };
      }));
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { target, snapshotId: base.id, confirmedVersions: base.entries.size, records };
  }

  async download(target: string, exportId: string) {
    await this.checkDirectory(target);
    const record = await this.archive(target, exportId);
    const artifact = this.archivePath(record);
    try {
      if ((await lstat(artifact)).isFile()) return { path: artifact, filename: record.archive.filename };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    throw new SnapshotError('Snapshot archive is missing or not a regular file', 404);
  }

  async confirm(target: string, exportId: string, archiveSha256: unknown, outcome: unknown, username: string) {
    if (outcome !== 'complete') throw new SnapshotError('Confirmation requires outcome: complete', 400);
    if (typeof archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(archiveSha256)) {
      throw new SnapshotError('Confirmation requires the SHA256 of the imported archive', 400);
    }
    await this.checkDirectory(target);
    const record = await this.archive(target, exportId);
    if (record.archive.checksum !== archiveSha256.toLowerCase()) {
      throw new SnapshotError('Archive SHA256 does not match', 409);
    }
    const successor = this.successorPath(target, record.baseSnapshotId);
    const checkWinner = (winner: Confirmation) => {
      if (winner.exportId !== exportId || winner.archiveSha256 !== record.archive.checksum) {
        throw new SnapshotError('Snapshot predecessor has already been advanced', 409);
      }
      return winner;
    };
    const previous = await readJSON<Confirmation>(successor);
    if (previous) return checkWinner(previous);
    if ((await this.baseline(target)).id !== record.baseSnapshotId) {
      // A simultaneous retry of this same confirmation may have advanced the chain.
      const winner = await readJSON<Confirmation>(successor);
      if (winner) return checkWinner(winner);
      throw new SnapshotError('Snapshot predecessor is no longer current', 409);
    }

    let artifact: FileFingerprint;
    try {
      artifact = await fingerprintExportFile(this.archivePath(record));
    } catch {
      throw new SnapshotError('Local snapshot archive is missing or unreadable', 409);
    }
    if (!matches(artifact, { checksum: record.archive.checksum, size: record.archive.fileSize })) {
      throw new SnapshotError('Local snapshot archive no longer matches its recorded SHA256 and size', 409);
    }
    const confirmation = {
      exportId, archiveSha256: record.archive.checksum, confirmedAt: new Date().toISOString(), confirmedBy: username
    };
    try {
      await publishJSON(successor, confirmation, true);
      return confirmation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return checkWinner((await readJSON<Confirmation>(successor))!);
    }
  }

  private directory(target: string): string {
    const key = createHash('sha256').update(snapshotTarget(target)).digest('hex');
    return path.resolve(this.storagePath, '.standalone-snapshots', key);
  }

  private async checkDirectory(target: string, create = false): Promise<void> {
    const targetDir = this.directory(target);
    const stateDir = path.dirname(targetDir);
    const storage = path.dirname(stateDir);
    if (!(await lstat(storage)).isDirectory()) throw new Error('Storage root must be a real directory');
    for (const dir of [stateDir, targetDir]) {
      if (create) {
        try {
          await mkdir(dir, { mode: 0o700 });
          await syncExportDirectory(path.dirname(dir));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      try {
        if (!(await lstat(dir)).isDirectory()) throw new Error('Snapshot state must be a real directory');
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private recordPath(target: string, exportId: string): string {
    return path.join(this.directory(target), `archive-${archiveId(exportId)}.json`);
  }

  private successorPath(target: string, base: string | null): string {
    return path.join(this.directory(target), `confirmed-after-${base ? archiveId(base) : 'initial'}.json`);
  }

  private archivePath(record: SavedArchive): string {
    return path.join(this.directory(record.target), `snapshot-${archiveId(record.exportId)}.tar.gz`);
  }

  private downloadUrl(record: SavedArchive): string {
    return `/_/ingest/export/snapshot/${record.target}/${record.exportId}/download`;
  }

  private async archive(target: string, exportId: string): Promise<SavedArchive> {
    const record = await readJSON<SavedAttempt>(this.recordPath(target, exportId));
    if (!record || record.target !== target || record.exportId !== exportId || record.status !== 'pending') {
      throw new SnapshotError('Snapshot archive not found or not ready', 404);
    }
    return record;
  }

  private async baseline(target: string) {
    await this.checkDirectory(target);
    let id: string | null = null;
    const entries = new Map<string, SnapshotEntry>();
    const confirmations = new Map<string, Confirmation>();
    while (true) {
      const confirmation = await readJSON<Confirmation>(this.successorPath(target, id));
      if (!confirmation) return { id, entries, confirmations };
      const record = await this.archive(target, confirmation.exportId);
      if (record.baseSnapshotId !== id || record.archive.checksum !== confirmation.archiveSha256 ||
          confirmations.has(record.exportId)) {
        throw new Error('Invalid standalone snapshot confirmation chain');
      }
      for (const entry of record.entries) {
        const key = entryKey(entry);
        if (entries.has(key)) throw new Error(`Duplicate entry in confirmation chain: ${key}`);
        entries.set(key, entry);
      }
      id = record.exportId;
      confirmations.set(id, confirmation);
    }
  }

  private async plan(confirmed: Map<string, SnapshotEntry>) {
    const sources = await this.scanner.scanModifiedFiles({ includeMetadata: false, standaloneSnapshot: true });
    sources.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.absolutePath.localeCompare(b.absolutePath));
    const hashLimit = pLimit(Math.max(1, Math.min(50, Math.floor(this.concurrency))));
    const observed = await Promise.all(sources.map(file => hashLimit(async () => {
      const identity = storageTarballIdentity(file);
      const fingerprint = await fingerprintExportFile(file.absolutePath);
      const filename = `${path.posix.basename(identity.packageName)}-${identity.version}.tgz`;
      const relativePath = `${identity.packageName}/${filename}`;
      return {
        file: { ...file, ...identity, relativePath, size: fingerprint.size },
        entry: { ...identity, ...fingerprint }
      };
    })));
    const seen = new Map<string, SnapshotEntry>();
    const conflicts: SnapshotConflict[] = [];
    const entries: SnapshotEntry[] = [];
    const files: ScannedFile[] = [];
    const fingerprints = new Map<string, FileFingerprint>();
    for (const { file, entry } of observed) {
      const key = entryKey(entry);
      const fromTarget = confirmed.get(key);
      const expected = fromTarget ?? seen.get(key);
      if (expected) {
        if (!matches(expected, entry)) {
          const { packageName, version, checksum, size } = entry;
          conflicts.push({ packageName, version, expected: { checksum: expected.checksum, size: expected.size },
            actual: { checksum, size }, source: fromTarget ? 'confirmed' : 'alias' });
        }
        continue;
      }
      seen.set(key, entry);
      entries.push(entry);
      files.push(file);
      fingerprints.set(file.relativePath, entry);
    }
    return { files, entries, fingerprints, conflicts };
  }
}
