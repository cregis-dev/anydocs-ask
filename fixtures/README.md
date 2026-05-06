# Fixtures

Snapshots of anydocs projects used for unit / integration / e2e tests.

| Fixture | Source | Purpose |
|---|---|---|
| `starter-docs/` | `anydocs/examples/starter-docs` (2026-05-06 snapshot) | Smallest valid anydocs project — single section, single page per lang, double lang (zh + en). Used to validate structure-layer projection (stage 3) and the §4.6 "drag-zero-reembed" e2e test (stage 5). |

These fixtures are **frozen copies** — do not edit them in-place to chase upstream anydocs changes. If anydocs schema evolves and we need new fixtures, refresh deliberately and bump tests.
