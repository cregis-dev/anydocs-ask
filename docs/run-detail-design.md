# Run Detail Diagnostics Workspace

## Goal

Replace the narrow Traffic drawer with a stable, shareable page for diagnosing one RAG run end to end. The page must distinguish retrieval candidates from the context actually sent to generation and from chunks cited in the final answer.

## Route and navigation

- Detail URL: `/p/:project/runs/:requestId`
- Traffic rows navigate to the detail URL instead of opening an overlay.
- The detail URL carries a same-project `return` target so Back to traffic restores the selected range, query, source, outcome, and page.
- The browser Back button works without custom history handling.

## Information architecture

1. Run identity: outcome, source, timestamp, request ID, session ID.
2. Summary: total latency, candidate count, generation-context count, citation count.
3. Question and answer: readable at normal line length, with errors shown explicitly.
4. Pipeline timing: router, embedding, retrieval, rerank, and generation.
5. Retrieval inspector:
   - `Generation context`: the bounded and parent-expanded units sent to the LLM.
   - `Candidates`: every fused child chunk in final retrieval order.
   - `Citations`: chunks referenced by the final answer.
6. Runtime configuration: model, router strategy, current-page context, and request filters.

## Chunk presentation

Each chunk is a native expandable row. Its collapsed summary shows rank, page and heading, retrieval-path badges, final score, and whether it was used or cited. Expanded content shows:

- complete indexed child text;
- parent text when the child expanded to a structural parent;
- vector, BM25, exact-identifier, RRF, and final scores;
- chunk kind, object path, identifiers, token count, and stable content hash;
- links to the document in the Index explorer and published docs when available.

Only generation-context rows start expanded. Candidate lists remain scan-friendly even when top-K is large.

## Persistence and compatibility

- Run JSONL stores compact metadata and a short preview, not full indexed text.
- `content_hash` is the stable lookup key because a full reindex recreates numeric chunk IDs.
- The detail API resolves by matching chunk ID first, then content hash.
- Legacy runs without snapshots still resolve by numeric ID when possible and display a clear unavailable state otherwise.
- Existing JSONL readers treat all new fields as optional.

## Responsive behavior

- Desktop: constrained full-page workspace with a main column and compact metadata rail.
- Tablet and mobile: one column; retrieval controls remain horizontally scrollable.
- Expandable rows use semantic `details/summary`, visible focus states, and 44px minimum targets.
- Motion is limited to opacity and transform and respects `prefers-reduced-motion`.
