import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import {
  isDocsLang,
  isPageStatus,
  type DocsLang,
  type NavigationDoc,
  type NavItem,
  type PageDoc,
} from './types.ts';

type OpenApiDescriptor = {
  id: string;
  type: 'openapi';
  lang: DocsLang;
  status: 'published';
  source: { kind: 'file'; path: string };
  display?: { title?: string; groupId?: string };
  runtime?: { routeBase?: string };
};

type OpenApiSpec = {
  info?: { title?: unknown };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

export async function loadOpenApiPages(
  projectRoot: string,
  warnings: string[],
): Promise<Map<DocsLang, PageDoc[]>> {
  const out = new Map<DocsLang, PageDoc[]>();
  const dir = join(projectRoot, 'api-sources');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const descriptorPath = join(dir, entry);
    const descriptor = await readDescriptor(descriptorPath, warnings);
    if (!descriptor) continue;

    const specPath = join(projectRoot, descriptor.source.path);
    const spec = await readSpec(specPath, warnings);
    if (!spec) continue;

    const pages = pagesFromSpec(descriptor, spec);
    const existing = out.get(descriptor.lang) ?? [];
    existing.push(...pages);
    out.set(descriptor.lang, existing);
  }

  return out;
}

/**
 * Add generated OpenAPI operations to the in-memory navigation tree.
 *
 * API references are described by api-sources rather than authored as dozens
 * of navigation page entries. Replacing the existing API Reference link with
 * a virtual folder lets every downstream consumer see the generated pages as
 * normal members of the product subtree without changing navigation/*.json.
 */
export function attachOpenApiPagesToNavigation(
  navigationsByLang: Map<DocsLang, NavigationDoc>,
  apiPagesByLang: Map<DocsLang, PageDoc[]>,
  warnings: string[],
): void {
  for (const [lang, pages] of apiPagesByLang) {
    const navigation = navigationsByLang.get(lang);
    if (!navigation) continue;

    const groups = groupApiPages(pages);
    for (const group of groups.values()) {
      const target = findGroupContainer(navigation.items, group.groupId, group.routeBase);
      if (!target) {
        warnings.push(
          `api-sources: cannot attach OpenAPI group "${group.groupId}" to navigation/${lang}.json; generated pages remain orphaned`,
        );
        continue;
      }

      const folder: NavItem = {
        type: 'folder',
        id: `api-reference:${group.groupId}`,
        title: lang === 'zh' ? 'API 参考' : 'API Reference',
        children: group.pages.map((page) => ({ type: 'page', pageId: page.id })),
      };
      const linkIndex = target.children.findIndex(
        (item) => item.type === 'link' && sameRoute(item.href, group.routeBase),
      );
      if (linkIndex >= 0) target.children.splice(linkIndex, 1, folder);
      else target.children.push(folder);
    }
  }
}

type ApiPageGroup = {
  groupId: string;
  routeBase: string;
  pages: PageDoc[];
};

function groupApiPages(pages: PageDoc[]): Map<string, ApiPageGroup> {
  const groups = new Map<string, ApiPageGroup>();
  for (const page of pages) {
    const groupId = stringOr(page.metadata?.openapi_group_id, 'api-reference');
    const routeBase = stringOr(page.metadata?.openapi_route_base, '');
    const key = `${groupId}\0${routeBase}`;
    const group = groups.get(key) ?? { groupId, routeBase, pages: [] };
    group.pages.push(page);
    groups.set(key, group);
  }
  return groups;
}

function findGroupContainer(
  items: NavItem[],
  groupId: string,
  routeBase: string,
): Extract<NavItem, { type: 'section' | 'folder' }> | null {
  const routeSegment = normalizeRoute(routeBase).split('/').filter(Boolean).at(-1);
  const candidateIds = new Set(
    [groupId, `${groupId}-api`, routeSegment].filter((id): id is string => Boolean(id)),
  );

  for (const item of items) {
    if ((item.type === 'section' || item.type === 'folder') && item.id && candidateIds.has(item.id)) {
      return item;
    }
  }
  for (const item of items) {
    if (item.type !== 'section' && item.type !== 'folder') continue;
    const nested = findGroupContainer(item.children, groupId, routeBase);
    if (nested) return nested;
  }
  return null;
}

function sameRoute(left: string, right: string): boolean {
  return Boolean(right) && normalizeRoute(left) === normalizeRoute(right);
}

function normalizeRoute(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

async function readDescriptor(
  path: string,
  warnings: string[],
): Promise<OpenApiDescriptor | null> {
  const parsed = await readJson(path, warnings);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'openapi') return null;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    warnings.push(`${path}: OpenAPI descriptor missing id`);
    return null;
  }
  if (!isDocsLang(o.lang)) {
    warnings.push(`${path}: OpenAPI descriptor has invalid lang (${String(o.lang)})`);
    return null;
  }
  if (!isPageStatus(o.status) || o.status !== 'published') return null;
  if (!o.source || typeof o.source !== 'object' || Array.isArray(o.source)) {
    warnings.push(`${path}: OpenAPI descriptor missing source`);
    return null;
  }
  const source = o.source as Record<string, unknown>;
  if (source.kind !== 'file' || typeof source.path !== 'string') {
    warnings.push(`${path}: OpenAPI descriptor source must be { kind: "file", path }`);
    return null;
  }
  return {
    id: o.id,
    type: 'openapi',
    lang: o.lang,
    status: 'published',
    source: { kind: 'file', path: source.path },
    display: objectRecord(o.display) ? {
      ...(typeof o.display.title === 'string' ? { title: o.display.title } : {}),
      ...(typeof o.display.groupId === 'string' ? { groupId: o.display.groupId } : {}),
    } : undefined,
    runtime: objectRecord(o.runtime) && typeof o.runtime.routeBase === 'string'
      ? { routeBase: o.runtime.routeBase }
      : undefined,
  };
}

async function readSpec(path: string, warnings: string[]): Promise<OpenApiSpec | null> {
  const parsed = await readJson(path, warnings);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${path}: OpenAPI spec is not an object`);
    return null;
  }
  return parsed as OpenApiSpec;
}

async function readJson(path: string, warnings: string[]): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    warnings.push(`${path}: read failed (${describeError(err)})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    warnings.push(`${path}: JSON parse failed (${describeError(err)})`);
    return null;
  }
}

function pagesFromSpec(descriptor: OpenApiDescriptor, spec: OpenApiSpec): PageDoc[] {
  const pages: PageDoc[] = [];
  const baseId = descriptor.id.replace(/-en$/, '');
  const routeBase = routeBaseSlug(descriptor);
  const specTitle = descriptor.display?.title ?? stringOr(spec.info?.title, 'API Reference');

  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [methodRaw, operation] of Object.entries(pathItem)) {
      const method = methodRaw.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== 'object') continue;

      const op = operation as Record<string, unknown>;
      const methodUpper = method.toUpperCase();
      const operationSlug = `${method}-${slugPath(apiPath)}`;
      const summary = stringOr(op.summary, '');
      const title = `${methodUpper} ${apiPath}${summary ? ` — ${summary}` : ''}`;
      const markdown = renderOperationMarkdown({
        apiPath,
        method: methodUpper,
        operation: op,
        spec,
        specTitle,
      });

      pages.push({
        id: `api-${baseId}-${operationSlug}`,
        lang: descriptor.lang,
        slug: `${routeBase}/${operationSlug}`,
        title,
        description: summary || `${methodUpper} ${apiPath}`,
        tags: ['api-reference', descriptor.display?.groupId ?? baseId],
        status: 'published',
        content: { version: 1, blocks: [] },
        metadata: {
          source_type: 'openapi',
          openapi_id: descriptor.id,
          openapi_group_id: descriptor.display?.groupId ?? baseId,
          openapi_group_title: descriptor.display?.title ?? specTitle,
          openapi_route_base: descriptor.runtime?.routeBase ?? '',
          operation_method: methodUpper,
          operation_path: apiPath,
          operation_id: stringOr(op.operationId, ''),
        },
        render: { markdown },
      });
    }
  }

  return pages;
}

function renderOperationMarkdown(args: {
  apiPath: string;
  method: string;
  operation: Record<string, unknown>;
  spec: OpenApiSpec;
  specTitle: string;
}): string {
  const { apiPath, method, operation, spec, specTitle } = args;
  const lines: string[] = [];
  const summary = stringOr(operation.summary, '');
  const description = stringOr(operation.description, '');
  const operationId = stringOr(operation.operationId, '');

  lines.push(`# ${method} ${apiPath}${summary ? ` — ${summary}` : ''}`);
  lines.push('');
  lines.push(`API reference: ${specTitle}`);
  if (operationId) lines.push(`Operation ID: \`${operationId}\``);
  lines.push('');
  lines.push('## HTTP Request');
  lines.push('');
  lines.push('```http');
  lines.push(`${method} ${apiPath}`);
  lines.push('```');
  lines.push('');
  if (summary || description) {
    lines.push('## Description');
    lines.push('');
    if (summary) lines.push(summary);
    if (description) lines.push(description);
    lines.push('');
  }

  const requestSchema = requestBodySchema(operation, spec);
  if (requestSchema) {
    lines.push('## Request Body Fields');
    lines.push('');
    for (const field of schemaFields(requestSchema, spec)) {
      lines.push(formatField(field));
    }
    lines.push('');
  }

  const responseSchema = responseBodySchema(operation, spec);
  if (responseSchema) {
    lines.push('## Response Fields');
    lines.push('');
    for (const field of schemaFields(responseSchema, spec).slice(0, 80)) {
      lines.push(formatField(field));
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

type Field = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example: string;
};

function requestBodySchema(operation: Record<string, unknown>, spec: OpenApiSpec): unknown | null {
  const requestBody = deref(operation.requestBody, spec);
  if (!objectRecord(requestBody)) return null;
  const json = mediaSchema(requestBody.content);
  return json ? flattenSchema(json, spec) : null;
}

function responseBodySchema(operation: Record<string, unknown>, spec: OpenApiSpec): unknown | null {
  const responses = objectRecord(operation.responses) ? operation.responses : null;
  const ok = responses?.['200'] ?? responses?.['201'] ?? responses?.default;
  const resolved = deref(ok, spec);
  if (!objectRecord(resolved)) return null;
  const json = mediaSchema(resolved.content);
  return json ? flattenSchema(json, spec) : null;
}

function mediaSchema(content: unknown): unknown | null {
  if (!objectRecord(content)) return null;
  const json = content['application/json'] ?? content['application/*+json'];
  if (!objectRecord(json)) return null;
  return json.schema ?? null;
}

function schemaFields(schema: unknown, spec: OpenApiSpec): Field[] {
  const out: Field[] = [];

  collectSchemaFields(schema, spec, '', 0, out);
  return out;
}

function collectSchemaFields(
  schema: unknown,
  spec: OpenApiSpec,
  prefix: string,
  depth: number,
  out: Field[],
): void {
  if (depth > 6 || out.length >= 200) return;
  const resolved = flattenSchema(schema, spec);
  if (!objectRecord(resolved) || !objectRecord(resolved.properties)) return;

  const required = new Set(Array.isArray(resolved.required) ? resolved.required.filter(isString) : []);
  for (const [name, propRaw] of Object.entries(resolved.properties)) {
    if (out.length >= 200) return;
    const prop = flattenSchema(propRaw, spec);
    if (!objectRecord(prop)) continue;

    const fieldName = prefix ? `${prefix}.${name}` : name;
    out.push({
      name: fieldName,
      type: schemaType(prop),
      required: required.has(name),
      description: stringOr(prop.description, ''),
      example: exampleText(prop.example),
    });

    if (prop.type === 'array') {
      collectSchemaFields(prop.items, spec, `${fieldName}[]`, depth + 1, out);
    } else {
      collectSchemaFields(prop, spec, fieldName, depth + 1, out);
    }
  }
}

function formatField(field: Field): string {
  const bits = [`- \`${field.name}\``, field.type];
  if (field.required) bits.push('required');
  let line = bits.join(' — ');
  if (field.description) line += `: ${field.description}`;
  if (field.example) line += ` Example: \`${field.example}\``;
  return line;
}

function flattenSchema(schema: unknown, spec: OpenApiSpec): unknown {
  const resolved = deref(schema, spec);
  if (!objectRecord(resolved)) return resolved;
  if (Array.isArray(resolved.allOf)) {
    const merged: Record<string, unknown> = { ...resolved };
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    for (const part of resolved.allOf) {
      const flat = flattenSchema(part, spec);
      if (!objectRecord(flat)) continue;
      if (objectRecord(flat.properties)) Object.assign(properties, flat.properties);
      if (Array.isArray(flat.required)) {
        for (const item of flat.required) if (typeof item === 'string') required.add(item);
      }
      for (const [k, v] of Object.entries(flat)) {
        if (k !== 'properties' && k !== 'required' && k !== 'allOf') merged[k] = v;
      }
    }
    merged.properties = properties;
    merged.required = [...required];
    delete merged.allOf;
    return merged;
  }
  return resolved;
}

function deref(value: unknown, spec: OpenApiSpec): unknown {
  if (!objectRecord(value) || typeof value.$ref !== 'string') return value;
  const m = /^#\/components\/schemas\/([^/]+)$/.exec(value.$ref);
  if (!m) return value;
  return spec.components?.schemas?.[m[1]!] ?? value;
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === 'string') {
    if (schema.type === 'array' && objectRecord(schema.items)) {
      return `array<${schemaType(schema.items)}>`;
    }
    return schema.format ? `${schema.type} · ${String(schema.format)}` : schema.type;
  }
  if (Array.isArray(schema.type)) return schema.type.filter(isString).join(' | ');
  if (schema.$ref) return basename(String(schema.$ref));
  if (schema.properties) return 'object';
  return 'unknown';
}

function routeBaseSlug(descriptor: OpenApiDescriptor): string {
  const routeBase = descriptor.runtime?.routeBase;
  if (routeBase) {
    const prefix = `/${descriptor.lang}/`;
    if (routeBase.startsWith(prefix)) return trimSlashes(routeBase.slice(prefix.length));
    return trimSlashes(routeBase);
  }
  return `reference/${descriptor.id.replace(/-en$/, '')}`;
}

function slugPath(path: string): string {
  return trimSlashes(path)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'root';
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function exampleText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
