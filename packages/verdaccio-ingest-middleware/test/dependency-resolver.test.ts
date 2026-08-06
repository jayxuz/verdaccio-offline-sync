import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '@verdaccio/types';

import { DependencyResolver } from '../src/dependency-resolver';

const logger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

describe('DependencyResolver platform optional dependencies', () => {
  it('leaves platform packages to target-platform detection and keeps ordinary optional deps', () => {
    const resolver = new DependencyResolver({ enabled: true }, logger);
    const dependencies = (resolver as any).collectDependencies({
      dependencies: { regular: '^1.0.0' },
      optionalDependencies: {
        fsevents: '^2.3.0',
        '@anthropic-ai/claude-code-linux-x64': '2.1.220',
        '@openai/codex-win32-x64': 'npm:@openai/codex@0.146.1-win32-x64'
      }
    }, {
      includeDev: false,
      includePeer: false,
      includeOptional: true
    }, true);

    assert.deepEqual(dependencies, {
      regular: '^1.0.0',
      fsevents: '^2.3.0'
    });
  });
});
