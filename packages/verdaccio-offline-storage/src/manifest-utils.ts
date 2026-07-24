import type { Manifest } from '@verdaccio/types';

const LOCAL_MAP_FIELDS = [
  'versions',
  'dist-tags',
  '_attachments',
  '_distfiles',
  '_uplinks',
  'time'
] as const;

export function normalizeLocalManifest<T extends Manifest>(manifest: T): T {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('manifest must be an object');
  }

  for (const field of LOCAL_MAP_FIELDS) {
    const value = (manifest as any)[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      (manifest as any)[field] = {};
    }
  }

  return manifest;
}

function asMap(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function extractTarballFilename(tarball: unknown): string | undefined {
  if (typeof tarball !== 'string' || tarball.length === 0) {
    return undefined;
  }

  const path = tarball.split(/[?#]/, 1)[0];
  const filename = path.substring(path.lastIndexOf('/') + 1);
  return filename.endsWith('.tgz') ? filename : undefined;
}

function isValidLocalIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function mergeLocalManifests(local: Manifest, incoming: Manifest): Manifest {
  if (!local || typeof local !== 'object' || Array.isArray(local)) {
    throw new TypeError('local manifest must be an object');
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new TypeError('incoming manifest must be an object');
  }

  const localManifest = local as any;
  const incomingManifest = incoming as any;
  const distfiles: Record<string, any> = { ...asMap(incomingManifest._distfiles) };

  for (const version of Object.values(asMap(incomingManifest.versions))) {
    const dist = asMap(asMap(version).dist);
    const filename = extractTarballFilename(dist.tarball);
    if (!filename) {
      continue;
    }

    const record: Record<string, any> = {
      ...asMap(distfiles[filename]),
      url: dist.tarball
    };
    if (typeof dist.shasum === 'string' && dist.shasum.length > 0) {
      record.sha = dist.shasum;
    }
    distfiles[filename] = record;
  }

  const merged = {
    ...localManifest,
    ...incomingManifest,
    versions: {
      ...asMap(localManifest.versions),
      ...asMap(incomingManifest.versions)
    },
    _attachments: {
      ...asMap(localManifest._attachments),
      ...asMap(incomingManifest._attachments)
    },
    _distfiles: {
      ...distfiles,
      ...asMap(localManifest._distfiles)
    },
    _uplinks: {
      ...asMap(incomingManifest._uplinks),
      ...asMap(localManifest._uplinks)
    }
  } as Manifest;

  if (isValidLocalIdentity(localManifest._rev)) {
    (merged as any)._rev = localManifest._rev;
  } else {
    delete (merged as any)._rev;
  }
  if (isValidLocalIdentity(localManifest._id)) {
    (merged as any)._id = localManifest._id;
  } else {
    delete (merged as any)._id;
  }

  return normalizeLocalManifest(merged);
}
