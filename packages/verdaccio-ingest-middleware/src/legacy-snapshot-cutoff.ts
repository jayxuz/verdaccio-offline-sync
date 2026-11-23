import { constants } from 'fs';
import { open } from 'fs/promises';
import path from 'path';
import { LegacySnapshotMigrationRequest } from './types';

export interface LegacyCutoff {
  source: 'manual' | 'history';
  cutoff: string;
  historyExportId?: string;
}

export interface LegacyCutoffHint {
  exportId: string;
  cutoff: string;
  fileCount: number;
}

/** Parse a real calendar instant and require an unambiguous UTC offset. */
export function parseLegacyCutoff(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const [offsetHour, offsetMinute] = [Number(match[10] || 0), Number(match[11] || 0)];
  if (year < 1970 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return undefined;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number((match[7] || '').padEnd(3, '0'))));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day ||
      local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return undefined;
  const millis = local.getTime() - (match[9] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
  if (millis < 0 || millis > now) return undefined;
  return new Date(millis).toISOString();
}

export function legacyMigrationRequest(value: unknown, creating: boolean): LegacySnapshotMigrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('legacyMigration must be an object');
  const raw = value as Record<string, unknown>;
  const common = creating ? ['source', 'attestPriorImport', 'previewFingerprint'] : ['source'];
  if (creating && (raw.attestPriorImport !== true || typeof raw.previewFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.previewFingerprint))) {
    throw new Error('V1 migration create requires explicit same-target prior import attestation and a current preview fingerprint');
  }
  const confirm = creating ? { attestPriorImport: true as const, previewFingerprint: raw.previewFingerprint as string } : {};
  if (raw.source === 'manual' && Object.keys(raw).every(key => [...common, 'cutoff'].includes(key))) {
    const cutoff = parseLegacyCutoff(raw.cutoff);
    if (!cutoff) throw new Error('V1 cutoff must be a valid non-future ISO timestamp with Z or an explicit UTC offset');
    return { source: 'manual', cutoff, ...confirm };
  }
  if (raw.source === 'history' && Object.keys(raw).every(key => [...common, 'exportId'].includes(key)) &&
      typeof raw.exportId === 'string' && /^export-\d{10,16}-[a-z0-9]{1,16}$/.test(raw.exportId)) {
    return { source: 'history', exportId: raw.exportId, ...confirm };
  }
  throw new Error('Select an eligible V1 incremental export history record or enter an explicit cutoff');
}

/** Ordinary V2 and ambiguous V1 full exports share a format, so neither supplies an automatic hint. */
export async function readLegacyCutoffHints(storage: string): Promise<{ candidates: LegacyCutoffHint[]; historyUnavailable: boolean }> {
  try {
    const handle = await open(path.join(storage, '.export-history.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      const limit = 1024 * 1024;
      if (!stat.isFile() || stat.size > limit) return { candidates: [], historyUnavailable: true };
      const data = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > limit) return { candidates: [], historyUnavailable: true };
      const history = JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
      if (history?.version !== 1 || !Array.isArray(history.exports)) return { candidates: [], historyUnavailable: true };
      const ids = new Set<string>();
      const duplicates = new Set<string>();
      const candidates: LegacyCutoffHint[] = [];
      for (const record of history.exports) {
        if (!record || typeof record.exportId !== 'string' || !/^export-\d{10,16}-[a-z0-9]{1,16}$/.test(record.exportId)) continue;
        if (ids.has(record.exportId)) duplicates.add(record.exportId);
        ids.add(record.exportId);
        if (record.type !== 'incremental' || typeof record.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(record.checksum) ||
            !Number.isSafeInteger(record.fileCount) || record.fileCount < 1) continue;
        const cutoff = parseLegacyCutoff(record.timestamp);
        const predecessor = parseLegacyCutoff(record.baseTimestamp);
        if (!cutoff || !predecessor || predecessor >= cutoff || Date.parse(cutoff) !== record.timestampMs) continue;
        candidates.push({ exportId: record.exportId, cutoff, fileCount: record.fileCount });
      }
      return { candidates: candidates.filter(hit => !duplicates.has(hit.exportId))
        .sort((a, b) => b.cutoff.localeCompare(a.cutoff) || b.exportId.localeCompare(a.exportId)).slice(0, 100), historyUnavailable: false };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { candidates: [], historyUnavailable: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
}
