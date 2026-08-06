import { PlatformConfig } from './types';

const PLATFORM_PACKAGE_PATTERNS = [
  /@esbuild\//,
  /@swc\/core-/,
  /@rollup\/rollup-/,
  /@img\/sharp-/,
  /-linux-/,
  /-win32-/,
  /-darwin-/,
  /-x64/,
  /-arm64/,
  /-gnu$/,
  /-musl$/,
  /-msvc$/
];

export function isPlatformSpecificPackageName(packageName: string): boolean {
  return PLATFORM_PACKAGE_PATTERNS.some((pattern) => pattern.test(packageName));
}

export function matchesPlatformPackageName(
  packageName: string,
  platform: PlatformConfig
): boolean {
  const name = packageName.toLowerCase();
  const osMatch =
    (platform.os === 'linux' && name.includes('linux')) ||
    (platform.os === 'win32' && name.includes('win32')) ||
    (platform.os === 'darwin' && name.includes('darwin'));

  if (!osMatch) return false;

  const archMatch =
    (platform.arch === 'x64' && (name.includes('x64') || name.includes('x86_64'))) ||
    (platform.arch === 'arm64' && (name.includes('arm64') || name.includes('aarch64'))) ||
    (platform.arch === 'ia32' && (name.includes('ia32') || name.includes('x86')));

  if (!archMatch) return false;

  if (platform.os === 'linux' && platform.libc) {
    return platform.libc === 'glibc'
      ? name.includes('gnu') || !name.includes('musl')
      : name.includes('musl');
  }

  return true;
}
