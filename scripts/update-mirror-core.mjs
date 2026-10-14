import { copyFile } from 'node:fs/promises';
for (const plugin of ['verdaccio-ingest-middleware','verdaccio-metadata-healer']) {
  for (const name of ['mirror-core.ts','mirror-router.ts']) {
    await copyFile(new URL(name,import.meta.url),new URL('../packages/'+plugin+'/src/'+name,import.meta.url));
  }
}
