import { persistVerdaccioMetadata } from './mirror-core';

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
  await persistVerdaccioMetadata(verdaccioStorage, packageName, packument);
};
