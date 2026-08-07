import semver from 'semver';

/** Extract the right-most valid semver suffix from a .tgz filename. */
export function extractTarballVersion(filename: string): string | null {
  if (!filename.endsWith('.tgz')) {
    return null;
  }

  const baseName = filename.slice(0, -'.tgz'.length);
  let separator = baseName.lastIndexOf('-');
  while (separator >= 0) {
    const candidate = baseName.slice(separator + 1);
    if (semver.valid(candidate)) {
      return candidate;
    }
    separator = baseName.lastIndexOf('-', separator - 1);
  }

  return null;
}
