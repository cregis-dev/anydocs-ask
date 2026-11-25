import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [directory, expectedProject, release] = process.argv.slice(2);
assert.ok(directory && expectedProject && /^[0-9a-f]{40}$/.test(release), 'Expected content path, project ID and full release SHA');
assert.equal(readFileSync(join(directory, '.content-release'), 'utf8').trim(), release, 'Wrong or incomplete content release');
assert.equal(JSON.parse(readFileSync(join(directory, 'anydocs.config.json'), 'utf8')).projectId,
  expectedProject, 'Refusing content for another project');
for (const name of ['pages', 'navigation']) assert.ok(statSync(join(directory, name)).isDirectory(), name);
