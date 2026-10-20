import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import pacote from 'pacote';
import type { Logger } from '@verdaccio/types';

import IngestMiddleware from '../src/ingest-middleware';
import { DependencyResolver } from '../src/dependency-resolver';
import { PackageDownloader } from '../src/package-downloader';
import { StorageScanner } from '../src/storage-scanner';

const platforms = [{ os: 'linux', arch: 'x64' }, { os: 'win32', arch: 'x64' }];
const options = { includeOptional: true, updateToLatest: false };
const linuxName = '@astrojs/compiler-binding-linux-x64-gnu';
const windowsName = '@astrojs/compiler-binding-win32-x64-msvc';

async function createFixture(t: TestContext, alias = false) {
  const storagePath = await mkdtemp(path.join(tmpdir(), 'ingest-analysis-'));
  t.after(() => rm(storagePath, { recursive: true, force: true }));
  // 分析结果缓存使用一小时定时器，测试结束时一并释放。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logger = {
    debug() {}, error() {}, info() {}, trace() {}, warn() {}
  } as unknown as Logger;
  const config = { enabled: true, concurrency: 2 };
  const tarball = Buffer.alloc(256, 1);
  const shasum = createHash('sha1').update(tarball).digest('hex');
  const packuments: Record<string, any> = {};
  const addPackage = (name: string, version: string, fields = {}) => {
    packuments[name] = {
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: { shasum }, ...fields } }
    };
  };
  const nativeName = alias ? '@openai/codex' : linuxName;
  const nativeVersion = alias ? '0.146.1-linux-x64' : '0.4.0';
  addPackage('@astrojs/compiler', '0.4.0', {
    optionalDependencies: alias
      ? { '@openai/codex-linux-x64': `npm:${nativeName}@${nativeVersion}` }
      : { [linuxName]: '0.4.0', [windowsName]: '0.4.0' }
  });
  addPackage(nativeName, nativeVersion, { os: ['linux'], cpu: ['x64'] });
  if (!alias) addPackage(windowsName, '0.4.0', { os: ['win32'], cpu: ['x64'] });

  const persist = async (_storage: unknown, name: string, packument: any) => {
    const dir = path.join(storagePath, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(packument));
  };
  const writeLocal = async (name: string, filename: string, size = tarball.length) => {
    await persist(null, name, packuments[name]);
    const file = path.join(storagePath, name, filename);
    await writeFile(file, Buffer.alloc(size, 1));
    return file;
  };
  await writeLocal('@astrojs/compiler', 'compiler-0.4.0.tgz');

  const downloads: string[] = [];
  t.mock.method(pacote, 'packument', async (name: string) => {
    assert.ok(packuments[name], `未定义测试包：${name}`);
    return packuments[name];
  });
  t.mock.method(pacote, 'manifest', async (spec: string) => {
    const canonical = spec.includes('@npm:') ? spec.split('@npm:')[1] : spec;
    const separator = canonical.lastIndexOf('@');
    const manifest = packuments[canonical.slice(0, separator)]
      ?.versions[canonical.slice(separator + 1)];
    assert.ok(manifest, `未定义测试版本：${spec}`);
    return manifest;
  });
  t.mock.method(pacote, 'tarball', async (spec: string) => {
    downloads.push(spec);
    return tarball;
  });

  const middleware: any = Object.create(IngestMiddleware.prototype);
  Object.defineProperty(middleware, 'config', { value: config });
  Object.assign(middleware, {
    logger, storagePath, tasks: new Map(), analysisCache: new Map(),
    scanner: new StorageScanner(config, storagePath, logger),
    resolver: new DependencyResolver(config, logger),
    downloader: new PackageDownloader(config, storagePath, logger, {}, persist)
  });
  const analyze = () => middleware.executeAnalysis(middleware.createTask(), platforms, options);
  return { middleware, analyze, writeLocal, persist, packuments, downloads, nativeName, nativeVersion };
}

it('平台包下载完成后再次分析不再列出，已有文件的内容和修改时间保持不变', async (t) => {
  const fixture = await createFixture(t);
  const existingFile = await fixture.writeLocal(linuxName, 'compiler-binding-linux-x64-gnu-0.4.0.tgz');
  const before = await stat(existingFile);
  const contents = await readFile(existingFile);

  const first = await fixture.analyze();
  assert.deepEqual(first.toDownload.map((pkg: any) => `${pkg.name}@${pkg.version}`), [
    `${windowsName}@0.4.0`
  ]);
  const result = await fixture.middleware.executeDownload(
    fixture.middleware.createTask(), first.toDownload
  );
  assert.equal(result.success, true);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(fixture.downloads, [`${windowsName}@0.4.0`]);

  const second = await fixture.analyze();
  assert.deepEqual(second.toDownload, []);
  assert.deepEqual(await readFile(existingFile), contents);
  assert.equal((await stat(existingFile)).mtimeMs, before.mtimeMs);
});

it('仅有元数据、过小的文件和其他版本都不能冒充所需的平台包缓存', async (t) => {
  const fixture = await createFixture(t);
  await fixture.persist(null, linuxName, fixture.packuments[linuxName]);
  await fixture.writeLocal(windowsName, 'astrojs-compiler-binding-win32-x64-msvc-0.4.0.tgz', 1);
  await fixture.writeLocal(linuxName, 'compiler-binding-linux-x64-gnu-0.3.0.tgz');
  const result = await fixture.analyze();
  assert.deepEqual(result.toDownload.map((pkg: any) => `${pkg.name}@${pkg.version}`).sort(), [
    `${linuxName}@0.4.0`, `${windowsName}@0.4.0`
  ].sort());
});

it('平台别名按真实包名及完整预发布版本检查本地缓存', async (t) => {
  const fixture = await createFixture(t, true);
  await fixture.writeLocal(fixture.nativeName, `openai-codex-${fixture.nativeVersion}.tgz`);
  assert.deepEqual((await fixture.analyze()).toDownload, []);
});
