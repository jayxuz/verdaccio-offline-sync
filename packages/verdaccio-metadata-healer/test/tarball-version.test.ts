import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractTarballVersion } from '../src/tarball-version';

describe('extractTarballVersion', () => {
  it('recognizes regular and platform-qualified semver suffixes', () => {
    assert.equal(extractTarballVersion('demo-1.2.3.tgz'), '1.2.3');
    assert.equal(extractTarballVersion('demo-1.2.3-beta.1+build.7.tgz'), '1.2.3-beta.1+build.7');
    assert.equal(extractTarballVersion('codex-0.146.1-win32-x64.tgz'), '0.146.1-win32-x64');
    assert.equal(
      extractTarballVersion('codex-0.146.1-linux-arm64-musl.tgz'),
      '0.146.1-linux-arm64-musl'
    );
    assert.equal(extractTarballVersion('claude-code-linux-x64-2.1.220.tgz'), '2.1.220');
  });

  it('rejects files without a valid tgz semver suffix', () => {
    assert.equal(extractTarballVersion('demo-latest.tgz'), null);
    assert.equal(extractTarballVersion('demo-1.2.3.tar.gz'), null);
  });
});
