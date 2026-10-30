import React from 'react';
import type { ConfigValueSource, RuntimeConfiguration } from '../runtime-configuration';

const SOURCE_LABELS: Record<ConfigValueSource, string> = {
  environment: 'Environment override',
  project: 'Project file',
  default: 'Engine default',
  runtime: 'Runtime configuration',
};

export function RuntimeConfigurationPanel({ configuration, ready }: {
  configuration: RuntimeConfiguration | null;
  ready: boolean;
}) {
  return (
    <section className="ca-panel ca-effective-settings" aria-label="Effective Ask configuration">
      <div className="ca-panel-head">
        <div><span className="ca-kicker">Reported by Ask</span><h2>Effective configuration</h2></div>
        <span className="ca-badge" data-tone={configuration && ready ? 'live' : 'neutral'}>
          {configuration ? ready ? 'active' : 'loaded' : 'unavailable'}
        </span>
      </div>
      {configuration ? <>
        <dl className="ca-runtime-values">
          <div>
            <dt>Answer mode</dt>
            <dd>{configuration.mode === 'agent' ? 'Agentic RAG' : 'RAG'}</dd>
            <span>{SOURCE_LABELS[configuration.agent.source]}</span>
            {configuration.agent.environmentVariable && <code>{configuration.agent.environmentVariable}={String(configuration.agent.enabled)}</code>}
          </div>
          <div>
            <dt>Answer model</dt>
            <dd><code>{configuration.model.name}</code></dd>
            <span>{SOURCE_LABELS[configuration.model.source]}</span>
            {configuration.model.environmentVariable && <code>{configuration.model.environmentVariable}</code>}
          </div>
        </dl>
        <p className="ca-runtime-loaded">Loaded <time dateTime={configuration.loadedAt}>{new Date(configuration.loadedAt).toLocaleString()}</time>. File edits apply after the Ask service restarts.</p>
      </> : <p className="ca-runtime-loaded">Ask has not reported its effective settings. Check service availability and the Ask engine version. The Console file below does not confirm the running configuration.</p>}
    </section>
  );
}
