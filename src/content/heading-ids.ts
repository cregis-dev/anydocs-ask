/**
 * Heading slug generator — vendored byte-for-byte from
 * `@anydocs/core` (1.3.x: packages/core/src/utils/heading-ids.ts) so citation
 * URLs (e.g. /zh/welcome#bearer-token) line up with what anydocs Reader emits.
 *
 * Why not `import` it: heading-ids is not a `@anydocs/core` sub-export. We
 * could pull the main entry, but a 5-line vendor with an explicit alignment
 * note is cheaper than an unstable surface. When upgrading @anydocs/core,
 * diff this file against the upstream copy.
 *
 * Source-of-truth pin: anydocs 1.3.5.
 */

export function slugifyHeadingId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function createHeadingIdGenerator(): (title: string) => string {
  const seen = new Map<string, number>();
  return (title: string) => {
    const base = slugifyHeadingId(title);
    if (!base) return '';
    const next = (seen.get(base) ?? 0) + 1;
    seen.set(base, next);
    return next === 1 ? base : `${base}-${next}`;
  };
}
