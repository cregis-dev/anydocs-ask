/**
 * Immutable build/deployment metadata exposed by health checks, run records,
 * and the console. Values are supplied by the image build and deployment
 * environment; local development intentionally reports nulls.
 */

export type RuntimeBuildMetadata = {
  release: string | null;
  engine_release: string | null;
  built_at: string | null;
  release_url: string | null;
};

export function readRuntimeBuildMetadata(
  env: Record<string, string | undefined>,
): RuntimeBuildMetadata {
  return {
    release: clean(env.ANYDOCS_RELEASE),
    engine_release: clean(env.ANYDOCS_ENGINE_RELEASE),
    built_at: clean(env.ANYDOCS_BUILD_TIME),
    release_url: safeHttpUrl(env.ANYDOCS_RELEASE_URL),
  };
}

export function hasRuntimeBuildMetadata(build: RuntimeBuildMetadata): boolean {
  return Boolean(build.release || build.engine_release || build.built_at || build.release_url);
}

function clean(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function safeHttpUrl(value: string | undefined): string | null {
  const normalized = clean(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
