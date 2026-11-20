import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createContext, Script } from 'node:vm';
import { getWebUIHTML } from '../src/web-ui';

function createPage(fail = false, snapshot = false) {
  const elements = new Map<string, any>();
  const createElement = () => ({
    textContent: '', value: '', disabled: false, style: {}, innerHTML: '', children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    append(...children: any[]) { this.children.push(...children); },
    appendChild(child: any) { this.children.push(child); },
    replaceChildren(...children: any[]) { this.children = children; }
  });
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const requests: Array<{ url: string; body?: any; authorization?: string }> = [];
  const checksum = 'a'.repeat(64);
  const exportId = '9bc2a161-cc3e-4d2c-9c5d-d5e243bbc000';
  const route = '/_/ingest/export/snapshot/nexus-prod';
  const page = createContext({
    window: { prompt: () => checksum },
    document: {
      getElementById: element, createElement,
      addEventListener() {}, querySelectorAll: () => [],
      querySelector: () => ({ value: snapshot ? 'snapshot' : 'full' })
    },
    fetch: async (url: string, options?: { body?: string; headers?: { Authorization?: string } }) => {
      const authorization = options?.headers?.Authorization;
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : undefined,
        ...(authorization && { authorization }) });
      return {
        ok: !fail,
        json: async () => fail ? { success: false, error: '测试上游错误' }
          : url.endsWith('/cache') ? { packages: [{ name: '@scope/demo', versions: ['1.0.0'] }] }
          : url.endsWith('/export/preview') ? { success: true, files: [], stats: { totalFiles: 0, packages: 0, totalSize: 0 } }
          : url === route ? { success: true, snapshotId: null, records: [
            { status: 'pending', createdAt: '2026-11-20', exportId, archive: { filename: 'fixture.tar.gz', checksum } }
          ] }
          : { success: true, refreshed: 1 }
      };
    }
  });
  const script = getWebUIHTML().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Script(script).runInContext(page);
  // 本测试只验证刷新和包列表的真实界面流程，不触发无关的状态刷新。
  page.refreshCacheStatus = () => {};
  return { page, element, requests, checksum, exportId, route };
}

it('在线页面的批量、单包和列表同步只使用摄取接口，保留 scoped 包名', async () => {
  const { page, element, requests } = createPage();
  await page.startSyncAll();
  assert.deepEqual(requests.shift(), { url: '/_/ingest/refresh', body: { all: true } });
  assert.equal(element('syncResultSuccess').textContent, 1);
  assert.equal(element('syncAllBtn').disabled, false);

  element('syncPackageName').value = '@scope/demo';
  await page.syncSinglePackage();
  assert.deepEqual(requests.shift(), {
    url: '/_/ingest/refresh', body: { packages: ['@scope/demo'] }
  });

  await page.loadPackageList();
  assert.equal(requests.shift()?.url, '/_/ingest/cache');
  const item = element('syncPkgListContainer').children[0];
  assert.equal(item.children[0].textContent, '@scope/demo');
  await item.children[1].onclick();
  assert.deepEqual(requests.shift(), {
    url: '/_/ingest/refresh', body: { packages: ['@scope/demo'] }
  });
});

it('刷新失败时显示错误并恢复按钮，不启动不存在的 healer 任务轮询', async () => {
  const { page, element, requests } = createPage(true);
  await page.startSyncAll();
  assert.equal(element('syncResultFailed').textContent, '测试上游错误');
  assert.equal(element('syncAllBtn').disabled, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/_/ingest/refresh');
});

it('uses the explicit snapshot mode and sends the entered hash only on full import confirmation', async () => {
  const { page, element, requests, checksum, exportId, route } = createPage(false, true);
  element('exportSnapshotTarget').value = 'nexus-prod';
  element('exportSnapshotToken').value = 'fixture-token';
  const authorization = 'Bearer fixture-token';
  await page.previewExport();
  assert.deepEqual(requests.shift(), {
    url: '/_/ingest/export/preview',
    body: { mode: 'standalone-snapshot', since: 'last', target: 'nexus-prod' },
    authorization
  });
  await page.loadSnapshotStatus();
  assert.deepEqual(requests.shift(), { url: route, body: undefined, authorization });
  const confirm = element('snapshotRecords').children[0].children[2];
  assert.equal(confirm.textContent, '确认已完整导入');
  await confirm.onclick();
  assert.deepEqual(requests.shift(), {
    url: route + '/' + exportId + '/confirm',
    body: { outcome: 'complete', archiveSha256: checksum },
    authorization
  });
});
