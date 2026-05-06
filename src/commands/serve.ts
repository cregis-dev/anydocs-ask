import { resolve } from 'node:path';
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from '../server/app.ts';

export type ServeOptions = {
  projectRoot: string;
  host?: string;
  port?: number;
};

export async function runServe(opts: ServeOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3100;

  // TODO(stage 7): load anydocs.ask.json from projectRoot, merge with defaults.
  // TODO(stage 5): boot index manager + chokidar watcher here, await warm-up.

  const app = createApp({ projectRoot });

  return await new Promise<number>((resolvePromise) => {
    const server = nodeServe(
      { fetch: app.fetch, hostname: host, port },
      (info) => {
        process.stdout.write(
          `anydocs-ask listening on http://${info.address}:${info.port} (project: ${projectRoot})\n`,
        );
      },
    );

    const shutdown = (signal: string) => {
      process.stdout.write(`\nreceived ${signal}, shutting down...\n`);
      server.close(() => resolvePromise(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}
