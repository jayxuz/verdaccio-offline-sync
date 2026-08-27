import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectRangesFromPackument, selectRepairVersions } from '../src/repair-planner';

function makePackument(
  name: string,
  versions: string[],
  distTags: Record<string, string> = {}
): any {
  const versionMap: Record<string, any> = {};
  for (const version of versions) {
    versionMap[version] = { name, version };
  }
  return { name, versions: versionMap, 'dist-tags': distTags };
}

describe('selectRepairVersions', () => {
  it('selects dist-tags.latest only when nothing else matches', () => {
    const packument = makePackument('demo', ['1.0.0', '1.1.0', '1.2.0'], { latest: '1.2.0' });

    const selected = selectRepairVersions(packument, []);

    assert.deepEqual(selected, [
      { version: '1.2.0', reasons: ['dist-tag-latest', 'major-latest'] }
    ]);
  });

  it('selects the newest stable version of each major', () => {
    const packument = makePackument(
      'demo',
      ['1.0.0', '1.2.3', '2.0.0', '2.5.1', '2.5.0'],
      { latest: '2.5.1' }
    );

    const selected = selectRepairVersions(packument, []);

    // 按版本降序输出
    assert.deepEqual(
      selected.map((s) => s.version),
      ['2.5.1', '1.2.3']
    );
    assert.deepEqual(selected[0].reasons.sort(), ['dist-tag-latest', 'major-latest']);
    assert.deepEqual(selected[1].reasons, ['major-latest']);
  });

  it('skips majors that only have prerelease versions by default', () => {
    const packument = makePackument('demo', ['1.0.0', '2.0.0-alpha.1', '2.0.0-beta.1'], {
      latest: '1.0.0'
    });

    const selected = selectRepairVersions(packument, []);

    assert.deepEqual(
      selected.map((s) => s.version),
      ['1.0.0']
    );
  });

  it('includes prerelease majors when includePrerelease is set', () => {
    const packument = makePackument('demo', ['1.0.0', '2.0.0-alpha.1', '2.0.0-beta.1'], {
      latest: '1.0.0'
    });

    const selected = selectRepairVersions(packument, [], { includePrerelease: true });

    assert.deepEqual(
      selected.map((s) => s.version),
      ['2.0.0-beta.1', '1.0.0']
    );
  });

  it('selects a prerelease latest because the tag is explicit intent', () => {
    const packument = makePackument('demo', ['1.0.0', '2.0.0-beta.1'], {
      latest: '2.0.0-beta.1'
    });

    const selected = selectRepairVersions(packument, []);

    assert.deepEqual(
      selected.map((s) => s.version),
      ['2.0.0-beta.1', '1.0.0']
    );
    assert.ok(selected[0].reasons.includes('dist-tag-latest'));
  });

  it('resolves dependent ranges with maxSatisfying', () => {
    const packument = makePackument('demo', ['1.0.0', '1.1.0', '1.2.0', '2.0.0'], {
      latest: '2.0.0'
    });

    const selected = selectRepairVersions(packument, ['^1.0.0']);

    const hit = selected.find((s) => s.version === '1.2.0');
    assert.ok(hit, 'expected 1.2.0 to be selected');
    assert.ok(hit.reasons.includes('dependent-range'));
    assert.ok(hit.reasons.includes('major-latest'));
  });

  it('resolves exact versions, dist-tags and npm aliases from ranges', () => {
    const packument = makePackument('demo', ['1.0.0', '1.2.0', '2.0.0'], { latest: '2.0.0' });

    const selected = selectRepairVersions(packument, [
      '1.0.0', // 精确版本
      'latest', // dist-tag
      'npm:demo@^1.0.0' // npm alias
    ]);
    const versions = selected.map((s) => s.version);

    assert.ok(versions.includes('1.0.0'), 'exact version should be selected');
    assert.ok(versions.includes('2.0.0'), 'dist-tag should resolve to latest');
    assert.ok(versions.includes('1.2.0'), 'npm alias range should resolve');
    const exact = selected.find((s) => s.version === '1.0.0');
    assert.deepEqual(exact?.reasons, ['dependent-range']);
  });

  it('merges reasons when several rules hit the same version', () => {
    const packument = makePackument('demo', ['1.0.0', '1.2.0'], { latest: '1.2.0' });

    const selected = selectRepairVersions(packument, ['^1.0.0', '~1.2.0']);

    // ^1.0.0 与 ~1.2.0 的 maxSatisfying 都是 1.2.0，加上 latest/major 规则应合并为单条
    assert.equal(selected.length, 1);
    assert.equal(selected[0].version, '1.2.0');
    assert.deepEqual(
      selected[0].reasons.sort(),
      ['dependent-range', 'dist-tag-latest', 'major-latest']
    );
  });

  it('ignores non-registry ranges and ranges without a local match', () => {
    const packument = makePackument('demo', ['1.0.0'], { latest: '1.0.0' });

    const selected = selectRepairVersions(packument, [
      'git+ssh://git@example.com/demo.git',
      'file:../demo',
      'link:../demo',
      'workspace:*',
      'https://example.com/demo.tgz',
      '99.0.0',
      '>=99.0.0',
      ''
    ]);

    // 只有 latest/major 规则选中的 1.0.0，垃圾 range 不应新增任何版本
    assert.deepEqual(
      selected.map((s) => s.version),
      ['1.0.0']
    );
  });

  it('returns empty list when metadata has no usable versions', () => {
    assert.deepEqual(selectRepairVersions(null, []), []);
    assert.deepEqual(selectRepairVersions({ name: 'demo' }, []), []);
    assert.deepEqual(selectRepairVersions(makePackument('demo', [], {}), ['^1.0.0']), []);
  });

  it("versionScope 'latest' selects only dist-tags.latest", () => {
    const packument = makePackument('demo', ['1.0.0', '1.2.3', '2.0.0', '2.5.1'], {
      latest: '2.5.1'
    });

    const selected = selectRepairVersions(packument, ['^1.0.0'], { versionScope: 'latest' });

    assert.deepEqual(selected, [{ version: '2.5.1', reasons: ['dist-tag-latest'] }]);
  });

  it("versionScope 'latest' selects nothing when dist-tags.latest is absent", () => {
    const packument = makePackument('demo', ['1.0.0', '2.0.0'], {});

    const selected = selectRepairVersions(packument, ['^1.0.0'], { versionScope: 'latest' });

    assert.deepEqual(selected, []);
  });

  it("versionScope 'latest' still honors an explicit prerelease latest tag", () => {
    const packument = makePackument('demo', ['1.0.0', '2.0.0-beta.1'], {
      latest: '2.0.0-beta.1'
    });

    const selected = selectRepairVersions(packument, [], { versionScope: 'latest' });

    assert.deepEqual(selected, [{ version: '2.0.0-beta.1', reasons: ['dist-tag-latest'] }]);
  });

  it('does not select prerelease via range unless includePrerelease is set', () => {
    const packument = makePackument('demo', ['1.0.0', '1.1.0-beta.1'], { latest: '1.0.0' });

    const selected = selectRepairVersions(packument, ['^1.0.0']);
    assert.deepEqual(
      selected.map((s) => s.version),
      ['1.0.0']
    );

    const withPre = selectRepairVersions(packument, ['^1.0.0'], { includePrerelease: true });
    assert.deepEqual(
      withPre.map((s) => s.version),
      ['1.1.0-beta.1', '1.0.0']
    );
  });
});

describe('collectRangesFromPackument', () => {
  it('collects dependencies/peerDependencies/optionalDependencies for target packages only', () => {
    const packument = {
      name: 'consumer',
      versions: {
        '1.0.0': {
          dependencies: { 'target-a': '^1.0.0', 'other-pkg': '^2.0.0' },
          devDependencies: { 'target-b': '^3.0.0' },
          peerDependencies: { 'target-b': '>=3.0.0' }
        },
        '2.0.0': {
          dependencies: { 'target-a': '^1.1.0' },
          optionalDependencies: { 'target-c': '4.5.6' }
        }
      }
    };
    const targets = new Set(['target-a', 'target-b', 'target-c']);
    const into = new Map<string, Set<string>>();

    collectRangesFromPackument(packument, targets, into);

    assert.deepEqual([...(into.get('target-a') || [])].sort(), ['^1.0.0', '^1.1.0']);
    // devDependencies 中的 ^3.0.0 不收集，peerDependencies 中的 >=3.0.0 收集
    assert.deepEqual([...(into.get('target-b') || [])], ['>=3.0.0']);
    assert.deepEqual([...(into.get('target-c') || [])], ['4.5.6']);
    assert.ok(!into.has('other-pkg'), 'non-target package should be ignored');
  });

  it('tolerates malformed packuments', () => {
    const into = new Map<string, Set<string>>();
    collectRangesFromPackument(null, new Set(['a']), into);
    collectRangesFromPackument({ name: 'x' }, new Set(['a']), into);
    collectRangesFromPackument(
      { versions: { '1.0.0': null, '2.0.0': { dependencies: 'oops' } } },
      new Set(['a']),
      into
    );
    assert.equal(into.size, 0);
  });
});
