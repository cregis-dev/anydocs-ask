/** Shared, credential-free diagnostics reported by the running Ask service. */
export type ConfigValueSource = 'environment' | 'project' | 'default' | 'runtime';

export type RuntimeConfiguration = {
  loadedAt: string;
  mode: 'agent' | 'rag';
  agent: {
    enabled: boolean;
    source: ConfigValueSource;
    environmentVariable: 'ANYDOCS_AGENT_ENABLED' | null;
  };
  model: {
    name: string;
    source: ConfigValueSource;
    environmentVariable: 'ANTHROPIC_MODEL' | null;
  };
};
