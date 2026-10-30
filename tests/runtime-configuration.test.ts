import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRuntimeConfiguration, loadConfig } from '../src/config.ts';

test('runtime diagnostics preserve startup overrides independently of later env and file edits', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-config-snapshot-'));
  const keys = ['ANYDOCS_AGENT_ENABLED', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY'] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    await fs.writeFile(join(root, 'anydocs.ask.json'), JSON.stringify({
      agent: { enabled: true }, llm: { model: 'project-model' },
    }));
    process.env.ANYDOCS_AGENT_ENABLED = ' FALSE ';
    process.env.ANTHROPIC_MODEL = 'deployment-model';
    process.env.ANTHROPIC_API_KEY = 'secret-must-not-be-reported';
    const { config } = await loadConfig(root);
    const snapshot = describeRuntimeConfiguration(config);
    assert.equal(snapshot.mode, 'rag');
    assert.deepEqual(snapshot.agent, {
      enabled: false, source: 'environment', environmentVariable: 'ANYDOCS_AGENT_ENABLED',
    });
    assert.deepEqual(snapshot.model, {
      name: 'deployment-model', source: 'environment', environmentVariable: 'ANTHROPIC_MODEL',
    });
    assert.ok(Number.isFinite(Date.parse(snapshot.loadedAt)));
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-must-not-be-reported|ANTHROPIC_API_KEY/);

    process.env.ANYDOCS_AGENT_ENABLED = 'true';
    process.env.ANTHROPIC_MODEL = 'new-deployment-model';
    await fs.writeFile(join(root, 'anydocs.ask.json'), '{}');
    assert.deepEqual(describeRuntimeConfiguration(config), snapshot);
    assert.equal(describeRuntimeConfiguration((await loadConfig(root)).config).mode, 'agent');
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime diagnostics distinguish project, default and programmatically changed values', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-config-source-'));
  const agentEnv = process.env.ANYDOCS_AGENT_ENABLED;
  const modelEnv = process.env.ANTHROPIC_MODEL;
  try {
    delete process.env.ANYDOCS_AGENT_ENABLED;
    delete process.env.ANTHROPIC_MODEL;
    const defaults = describeRuntimeConfiguration((await loadConfig(root)).config);
    assert.equal(defaults.agent.source, 'default');
    assert.equal(defaults.model.source, 'default');
    await fs.writeFile(join(root, 'anydocs.ask.json'), JSON.stringify({
      agent: { enabled: true }, llm: { model: 'project-model' },
    }));
    const { config } = await loadConfig(root);
    assert.equal(describeRuntimeConfiguration(config).agent.source, 'project');
    assert.equal(describeRuntimeConfiguration(config).model.source, 'project');
    config.agent.enabled = false;
    assert.equal(describeRuntimeConfiguration(config).agent.source, 'runtime');
  } finally {
    if (agentEnv === undefined) delete process.env.ANYDOCS_AGENT_ENABLED;
    else process.env.ANYDOCS_AGENT_ENABLED = agentEnv;
    if (modelEnv === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = modelEnv;
    await fs.rm(root, { recursive: true, force: true });
  }
});
