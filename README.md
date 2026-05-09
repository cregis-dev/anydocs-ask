# `@anydocs/ask`

Local-first Q&A service for [anydocs](https://github.com/cregis-dev/anydocs) projects. Reads `pages/{lang}/*.json` + `navigation/{lang}.json`, serves a structured-output, breadcrumb-cited Q&A endpoint to the Reader.

> Status: **v1 alpha (0.1.0-alpha.0).** Index + query + HTTP + evaluation loop (§16) shipped. PRD and architecture: [`PRD.md`](./PRD.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## What it is (and isn't)

- **Is**: an HTTP service that respects the author's *editorial intent* (navigation order, subtree boundaries, publish state). Drag-reorder a section — embeddings are **not** recomputed.
- **Isn't**: a generic AI search. We refuse global flattening. Citations always carry the full breadcrumb.

## v1 scope

End-user Q&A on **public** developer docs / product manuals. One process per anydocs project, multi-project = multi-port. Multilingual is first-class (zh / en today; same-lang preferred, cross-lang translation as fallback — see PRD §4.8).

## CLI

```bash
# Service
anydocs-ask serve            <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex          <projectRoot>
anydocs-ask status           <projectRoot>

# Workspace (defaults to ~/anydocs-ask-runtime/, overridable via --workspace
# or $ANYDOCS_ASK_WORKSPACE — see ARCHITECTURE.md §16.1)
anydocs-ask workspace init
anydocs-ask workspace ls

# Runs jsonl (every /v1/ask appends one line; ARCH §16.4)
anydocs-ask runs tail        <projectRoot> [--n 50]
anydocs-ask runs export      <projectRoot> --since <when> [--format jsonl|csv]

# Evaluation loop (ARCH §16.3 / §16.5 / §16.6)
anydocs-ask golden generate  <projectRoot> [--from structure|runs] [--limit N]
                                           [--since 14d] [--no-llm-rewrite] [--force]
anydocs-ask golden review    <projectRoot> [--reviewer <name>]
anydocs-ask eval             <projectRoot> [--baseline <path>]
anydocs-ask analyze runs     <projectRoot> [--since 7d]
```

`<projectRoot>` may be a filesystem path or a bare name resolved against the
runtime workspace (`<workspace>/projects/<name>`). All runtime data —
index.db, runs/, golden/, reports/ — lives under `<workspace>/state/<projectId>/`,
keeping the source repo clean (双根分离, ARCH §16.1).

## Implementation status

| Stage | Scope | Status |
|---|---|---|
| 1 | Project skeleton + Hono CLI shell + smoke test | ✅ |
| 2 | SQLite schema + sqlite-vec / FTS5 + migrations | ✅ |
| 3 | Structure-layer projection (multi-lang) | ✅ |
| 4 | Content layer + bge-m3 embeddings + cache | ✅ |
| 5 | Index pipeline + chokidar watcher + §4.6 e2e gate | ✅ |
| 6 | Query pipeline (incl. cross-lang fallback) | ✅ |
| 7 | HTTP API + config + CORS | ✅ |
| §16 | Runtime workspace + Golden + Eval + Runs jsonl + Analyze D1-D3 | ✅ |
| §15 | β/γ feedback inbox + Analyze D4-D5 + `--from inbox` | v1.5 |

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
