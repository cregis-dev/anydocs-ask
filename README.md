# `@anydocs/ask`

Local-first Q&A service for [anydocs](https://github.com/cregis-dev/anydocs) projects. Reads `pages/{lang}/*.json` + `navigation/{lang}.json`, serves a structured-output, breadcrumb-cited Q&A endpoint to the Reader.

> Status: **v1 in development.** PRD and architecture are locked; implementation is staged. See [`PRD.md`](./PRD.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## What it is (and isn't)

- **Is**: an HTTP service that respects the author's *editorial intent* (navigation order, subtree boundaries, publish state). Drag-reorder a section — embeddings are **not** recomputed.
- **Isn't**: a generic AI search. We refuse global flattening. Citations always carry the full breadcrumb.

## v1 scope

End-user Q&A on **public** developer docs / product manuals. One process per anydocs project, multi-project = multi-port. Multilingual is first-class (zh / en today; same-lang preferred, cross-lang translation as fallback — see PRD §4.8).

## CLI (planned)

```bash
anydocs-ask serve   <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex <projectRoot>
anydocs-ask status  <projectRoot>
```

`serve` boots the Hono server and the file watcher; `reindex` forces a full rebuild; `status` prints index health.

## Implementation status

| Stage | Scope | Status |
|---|---|---|
| 1 | Project skeleton + Hono CLI shell + smoke test | **In progress** |
| 2 | SQLite schema + sqlite-vec / FTS5 + migrations | Pending |
| 3 | Structure-layer projection (multi-lang) | Pending |
| 4 | Content layer + bge-m3 embeddings + cache | Pending |
| 5 | Index pipeline + chokidar watcher + §4.6 e2e gate | Pending |
| 6 | Query pipeline (incl. cross-lang fallback) | Pending |
| 7 | HTTP API + config + CORS | Pending |

## Develop

```bash
pnpm install
pnpm dev serve ./fixtures/starter-docs   # runs the CLI directly via --experimental-strip-types
pnpm test                                # node --test
pnpm typecheck
pnpm build                               # emits dist/
```

Requires Node >= 20, pnpm >= 8.

## License

MIT
