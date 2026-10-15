import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { OfflinePackageStorage } from './OfflinePackageStorage';
import { getReadCacheManager } from './read-cache';
import { readlinkSync } from 'fs';
import { setPriority } from 'os';

const data = workerData;
const config = data.config;
if (data.hasMatcher) config.getMatchedPackagesSpec = (name: string) => ({ proxy: data.proxy[name] });
const cache = getReadCacheManager(config, data.root);
// Linux nice is per thread. Never lower the foreground Node thread's priority.
try {
  const tid = Number(readlinkSync('/proc/thread-self').split('/').pop());
  if (Number.isSafeInteger(tid) && tid !== process.pid) setPriority(tid, 10);
} catch { /* Cooperative I/O limits and foreground preemption remain available. */ }
cache.setBackgroundPaused(data.paused);
let cancelled = false;
parentPort!.on('message', message => {
  if (message.type === 'cancel') { cancelled = true; cache.cancelBackground(); }
  if (message.type === 'pause') cache.setBackgroundPaused(true);
  if (message.type === 'resume') cache.setBackgroundPaused(false);
});
const timer = setInterval(() => parentPort!.postMessage({ type: 'metrics', metrics: cache.stats().counters }), 100);
const logger: any = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
(async () => {
  for (const name of data.packages) {
    if (cancelled) break;
    parentPort!.postMessage({ type: 'progress', package: name });
    try {
      const directory = path.join(data.root, name);
      const storage = new OfflinePackageStorage(directory, logger, config);
      const result = await storage.warmRead(name, data.forceRehash);
      parentPort!.postMessage({ type: 'result', ...result, metrics: cache.stats().counters });
    } catch (e: any) {
      parentPort!.postMessage({ type: 'result', package: name, error: e.message, preempted: e.code === 'CACHE_CANCELLED', metrics: cache.stats().counters });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
})().catch(e => { parentPort!.postMessage({ type: 'error', error: e.message }); process.exitCode = 1; })
  .finally(() => { cache.close(); clearInterval(timer); parentPort!.postMessage({ type: 'metrics', metrics: cache.stats().counters }); parentPort!.close(); });
