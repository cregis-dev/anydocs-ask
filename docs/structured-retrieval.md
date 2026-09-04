# Structured Retrieval

## Goals

- Preserve authored heading boundaries and OpenAPI object boundaries.
- Retrieve small, discriminative child chunks without giving the generator incomplete context.
- Resolve endpoints, fields, headers, error codes, addresses, and hashes exactly.
- Keep citations attached to real public pages.

## Index Model

`chunk_parents` stores one semantic unit per heading. Generated OpenAPI pages add explicit headings for request parameters, request/response object paths, and example fragments, so paths such as `data.rows[]` and `data.settlement_details.order_settlement_detail` become stable parents.

`chunks` stores the retrievable children. Children alone are embedded and indexed by FTS5. Each child records `parent_id`, `chunk_kind`, and `object_path`.

`chunk_identifiers` is an exact lookup table keyed by normalized identifier. It covers API paths, operation IDs, header names, snake-case and dotted fields, error codes, transaction hashes, and supported chain addresses. Field paths also index useful snake-case suffixes.

## Query Flow

1. Extract exact identifiers from the original and rewritten query.
2. Run vector and BM25 retrieval over children.
3. Inject exact identifier hits with protected rank, then keep the fused RRF order.
4. Select diverse child hits.
5. Before generation, replace children that share a parent with one bounded parent context.
6. Keep the winning child's citation identity, but link generated OpenAPI pages to the real operation URL.

Parents larger than 6,000 characters are not expanded. This prevents a large page or schema from displacing the relevant evidence. Search/MCP results continue to return precise children; parent expansion is only used for answer generation.

## OpenAPI Projection

The OpenAPI loader:

- uses `operationId` for the public operation slug, with method/path as fallback;
- resolves component schemas, parameters, request bodies, and responses;
- indexes path-level and operation-level parameters;
- preserves all nested fields without a fixed field-count cutoff;
- records enum, default, range, length, pattern, nullable, and examples;
- splits request and response schemas by object boundary;
- splits oversized JSON examples recursively at object and array boundaries.

This projection is retrieval-only. It does not change the rendered API reference itself.

## Operational Notes

Migration `003_parent_child_identifiers.sql` is additive. Existing databases open normally, but a full reindex is required to populate parents and identifiers. Embedding cache entries remain reusable because child text hashes are still the cache key.
