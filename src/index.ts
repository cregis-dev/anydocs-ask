/**
 * Public library entry for `@anydocs/ask`.
 *
 * Surface intentionally narrow — most consumers use the CLI. The named
 * exports here are for tests and for downstream consumers who want to
 * embed the runtime (e.g. an in-process Reader during build).
 */

export { createApp, type AppDeps } from './server/app.ts';
export { Runtime } from './server/runtime.ts';
export type { RuntimeOptions, RuntimeStartResult } from './server/runtime.ts';
export { loadConfig } from './config.ts';
export type { ResolvedConfig } from './config.ts';
export { ask, search } from './query/answer.ts';
export type {
  AskRequest,
  AskResult,
  AskAnswer,
  AskClarify,
  AskError,
  Citation,
  ClarifyOption,
  SearchHit,
  SearchResult,
} from './query/types.ts';
