import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createContext, Script } from 'node:vm';
import { getWebUIHTML } from '../src/web-ui';

function createPage(fail = false) {
  const elements = new Map<string, any>();
  const createElement = () => ({
    textContent: '', value: '', disabled: false, style: {}, children: [] as any[],
    classList: { add() {}, remove() {} },
    append(...children: any[]) { this.children.push(...children); },
    appendChild(child: any) { this.children.push(child); },
    replaceChildren(...children: any[]) { this.children = children; }
  });
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const requests: Array<{ url: string; body?: any }> = [];
  const page = createContext({
    document: {
      getElementById: element, createElement,
      addEventListener() {}, querySelectorAll: () => []
    },
    fetch: async (url: string, options?: { body?: string }) => {
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      return {
        ok: !fail,
        json: async () => fail ? { success: false, error: '测试上游错误' }
          : url.endsWith('/cache') ? { packages: [{ name: '@scope/demo', versions: ['1.0.0'] }] }
          : { success: true, refreshed: 1 }
      };
    }
  });
  const script = getWebUIHTML().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Script(script).runInContext(page);
  // 本测试只验证刷新和包列表的真实界面流程，不触发无关的状态刷新。
  page.refreshCacheStatus = () => {};
  return { page, element, requests };
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
