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
