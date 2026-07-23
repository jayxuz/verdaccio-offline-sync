import type { Manifest } from '@verdaccio/types';

export type PackumentPersistence = (
  verdaccioStorage: any,
  packageName: string,
  packument: any
) => Promise<void>;

/**
 * 仅通过 Verdaccio 的包存储接口持久化元数据。
 * tarball 文件写入仍由 PackageDownloader 的下载路径负责。
 */
export const persistPackumentWithVerdaccioStorage: PackumentPersistence = async (
  verdaccioStorage,
  packageName,
  packument
) => {
  const getPackageStorage = verdaccioStorage?.localStorage?._getLocalStorage;
  const packageStorage = typeof getPackageStorage === 'function'
    ? getPackageStorage.call(verdaccioStorage.localStorage, packageName)
    : undefined;

  if (!packageStorage || typeof packageStorage.upsertPackage !== 'function') {
    throw new Error(`Package storage for ${packageName} does not support upsertPackage`);
  }

  await new Promise<void>((resolve, reject) => {
    packageStorage.upsertPackage(
      packageName,
      packument as Manifest,
      (error?: Error | null) => error ? reject(error) : resolve()
    );
  });
};
