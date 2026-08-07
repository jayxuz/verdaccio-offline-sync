import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractTarballVersion } from '../src/tarball-version';

describe('extractTarballVersion', () => {
  it('keeps hyphenated platform qualifiers as part of the version', () => {
    assert.equal(extractTarballVersion('codex-0.146.1-win32-x64.tgz'), '0.146.1-win32-x64');
    assert.equal(
      extractTarballVersion('codex-0.146.1-linux-arm64-musl.tgz'),
      '0.146.1-linux-arm64-musl'
    );
    assert.equal(extractTarballVersion('claude-code-linux-x64-2.1.220.tgz'), '2.1.220');
  });
});
