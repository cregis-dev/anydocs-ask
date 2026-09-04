/**
 * Long/structured question preparation for API troubleshooting.
 *
 * Retrieval needs a compact semantic query, while answer generation needs
 * exact evidence. This module creates both without trusting an LLM to copy
 * identifiers or suspicious whitespace faithfully.
 */

export const QUESTION_REWRITE_THRESHOLD_CHARS = 500;
export const MAX_QUESTION_CHARS = 20_000;
const MAX_RETRIEVAL_QUERY_CHARS = 600;
const MAX_PROMPT_QUESTION_CHARS = 2_400;

export type DiagnosticContext = {
  structured: boolean;
  summary: string | null;
  endpoints: string[];
  errorCodes: string[];
  exceptionNames: string[];
  importantFields: string[];
  /** Verbatim excerpts. Every item must occur in the redacted input. */
  exactClues: string[];
};

export type PreparedDiagnosticInput = {
  safeQuestion: string;
  diagnostic: DiagnosticContext;
  fallbackRetrievalQuestion: string;
};

const SENSITIVE_KEY = [
  'authorization',
  'api[_-]?key',
  'access[_-]?key',
  'access[_-]?signature',
  'secret',
  'client[_-]?secret',
  'private[_-]?key',
  'password',
  'passwd',
  'cookie',
  'session[_-]?id',
  'token',
  'auth[_-]?token',
  'sign',
  'signature',
].join('|');

const QUOTED_SECRET_RE = new RegExp(
  `(["']?(?:${SENSITIVE_KEY})["']?\\s*[:=]\\s*)(["'])([^"'\\r\\n]*)(\\2)`,
  'gi',
);
const BARE_SECRET_RE = new RegExp(
  `(^|[,{;\\s])((?:${SENSITIVE_KEY})\\s*[:=]\\s*)([^,;}\\s]+)`,
  'gim',
);
const HEADER_SECRET_RE = new RegExp(
  `(^|\\n)([ \\t]*(?:--header\\s+)?["']?(?:authorization|access[_-]?key|access[_-]?signature|x-api-key|cookie)\\s*:\\s*)[^\\r\\n"']+`,
  'gi',
);

export function redactSensitiveText(input: string): string {
  return input
    .replace(HEADER_SECRET_RE, (_match, prefix: string, key: string) => `${prefix}${key}[REDACTED]`)
    .replace(QUOTED_SECRET_RE, (_match, prefix: string, quote: string) => (
      `${prefix}${quote}[REDACTED]${quote}`
    ))
    .replace(BARE_SECRET_RE, (_match, boundary: string, prefix: string) => (
      `${boundary}${prefix}[REDACTED]`
    ));
}

export function prepareDiagnosticInput(question: string): PreparedDiagnosticInput {
  const safeQuestion = redactSensitiveText(question.trim());
  const structured = isStructuredDiagnosticInput(safeQuestion);
  const endpoints = uniqueMatches(
    safeQuestion,
    /\/(?:openapi|api)\/v\d+(?:\.[0-9]+)?\/[A-Za-z0-9_./-]+/gi,
    8,
    160,
  );
  const errorCodes = uniqueMatches(
    safeQuestion,
    /\b(?:[AE]\d{4}|HTTP\s*[1-5]\d{2}|[1-5]\d{2}\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable))\b/gi,
    8,
    80,
  );
  const exceptionNames = uniqueMatches(
    safeQuestion,
    /\b[A-Za-z_$][A-Za-z0-9_$.]*(?:Exception|Error)\b/g,
    8,
    120,
  );
  const importantFields = extractJsonLikeKeys(safeQuestion);
  const exactClues = extractExactClues(safeQuestion, endpoints, errorCodes, exceptionNames);
  const diagnostic: DiagnosticContext = {
    structured,
    summary: extractMessage(safeQuestion),
    endpoints,
    errorCodes,
    exceptionNames,
    importantFields,
    exactClues,
  };
  return {
    safeQuestion,
    diagnostic,
    fallbackRetrievalQuestion: buildFallbackRetrievalQuestion(safeQuestion, diagnostic),
  };
}

export function mergeLlmDiagnostic(
  prepared: PreparedDiagnosticInput,
  raw: unknown,
): DiagnosticContext {
  const llm = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const summary = cleanScalar(llm.summary, 360) ?? prepared.diagnostic.summary;
  return {
    structured: prepared.diagnostic.structured,
    summary,
    endpoints: mergeVerifiedList(
      prepared.diagnostic.endpoints,
      llm.endpoints,
      prepared.safeQuestion,
      8,
      160,
    ),
    errorCodes: mergeVerifiedList(
      prepared.diagnostic.errorCodes,
      llm.error_codes,
      prepared.safeQuestion,
      8,
      80,
    ),
    exceptionNames: mergeVerifiedList(
      prepared.diagnostic.exceptionNames,
      llm.exception_names,
      prepared.safeQuestion,
      8,
      120,
    ),
    importantFields: mergeVerifiedList(
      prepared.diagnostic.importantFields,
      llm.important_fields,
      prepared.safeQuestion,
      16,
      80,
    ),
    exactClues: mergeVerifiedList(
      prepared.diagnostic.exactClues,
      llm.exact_clues,
      prepared.safeQuestion,
      12,
      260,
      true,
    ),
  };
}

export function buildDiagnosticPromptQuestion(
  prepared: PreparedDiagnosticInput,
  diagnostic: DiagnosticContext,
  effectiveQuestion: string,
): string {
  if (!diagnostic.structured && prepared.safeQuestion.length <= QUESTION_REWRITE_THRESHOLD_CHARS) {
    return prepared.safeQuestion;
  }
  const lines = [
    'API troubleshooting request (sensitive values redacted):',
    `Resolved question: ${effectiveQuestion}`,
  ];
  if (diagnostic.summary) lines.push(`Observed symptom: ${diagnostic.summary}`);
  if (diagnostic.endpoints.length > 0) lines.push(`Endpoints: ${diagnostic.endpoints.join(', ')}`);
  if (diagnostic.errorCodes.length > 0) lines.push(`Error codes/status: ${diagnostic.errorCodes.join(', ')}`);
  if (diagnostic.exceptionNames.length > 0) lines.push(`Exceptions: ${diagnostic.exceptionNames.join(', ')}`);
  if (diagnostic.importantFields.length > 0) {
    lines.push(`Relevant fields: ${diagnostic.importantFields.join(', ')}`);
  }
  if (diagnostic.exactClues.length > 0) {
    lines.push('Verbatim evidence:');
    lines.push(...diagnostic.exactClues.map((clue) => `- ${clue}`));
  }
  return lines.join('\n').slice(0, MAX_PROMPT_QUESTION_CHARS);
}

export function diagnosticRetrievalHints(diagnostic: DiagnosticContext): string[] {
  return [
    ...diagnostic.endpoints,
    ...diagnostic.errorCodes,
    ...diagnostic.exceptionNames,
    ...diagnostic.importantFields,
  ].slice(0, 20);
}

function isStructuredDiagnosticInput(question: string): boolean {
  if (question.length > QUESTION_REWRITE_THRESHOLD_CHARS) return true;
  const signals = [
    /["'][A-Za-z_][A-Za-z0-9_.-]*["']\s*:/,
    /\b(?:request|response|payload|body|请求|响应|报错|错误)\b/i,
    /\/(?:openapi|api)\/v\d+/i,
    /\b(?:curl|HTTP\/[12]|Exception|stack trace)\b/i,
  ];
  return signals.filter((pattern) => pattern.test(question)).length >= 2;
}

function extractJsonLikeKeys(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /["']([A-Za-z_][A-Za-z0-9_.-]{0,79})["']\s*:/g;
  for (const match of question.matchAll(re)) {
    const field = match[1]!;
    const key = field.toLowerCase();
    if (seen.has(key) || key === 'code' || key === 'msg' || key === 'message') continue;
    seen.add(key);
    out.push(field);
    if (out.length >= 16) break;
  }
  return out;
}

function extractMessage(question: string): string | null {
  const match = question.match(/["'](?:msg|message|error|detail)["']\s*:\s*["']([^"'\r\n]{1,300})["']/i);
  if (match?.[1]) return match[1].trim();
  const exceptionLine = question.match(/[^\r\n]{0,180}(?:Exception|Error)[:\s][^\r\n]{0,180}/i)?.[0];
  return exceptionLine?.trim().slice(0, 300) || null;
}

function extractExactClues(
  question: string,
  endpoints: string[],
  errorCodes: string[],
  exceptions: string[],
): string[] {
  const clues = [...endpoints, ...errorCodes, ...exceptions];
  const fieldValueRe = /["']([A-Za-z_][A-Za-z0-9_.-]{0,79})["']\s*:\s*["']([^"'\r\n]{0,220})["']/g;
  for (const match of question.matchAll(fieldValueRe)) {
    const full = match[0]!;
    const value = match[2] ?? '';
    if (
      /^(?:msg|message|error|detail|to_address|from_address|currency|callback_url|endpoint|path)$/i.test(match[1]!)
      || /^\s|\s$/.test(value)
    ) {
      clues.push(full);
    }
  }
  const userAsk = question.match(/(?:这是什么问题|为什么(?:会)?这样|怎么(?:解决|处理|修改)|what(?:'s| is)? wrong|why|how (?:do|can|should))[^\r\n]{0,180}[?？]?$/i)?.[0];
  if (userAsk) clues.push(userAsk);
  return uniqueStrings(clues, 12, 260);
}

function buildFallbackRetrievalQuestion(
  safeQuestion: string,
  diagnostic: DiagnosticContext,
): string {
  if (!diagnostic.structured) return safeQuestion;
  const parts = [
    ...diagnostic.endpoints,
    ...diagnostic.errorCodes,
    ...diagnostic.exceptionNames,
    diagnostic.summary ?? '',
    ...diagnostic.importantFields,
  ];
  const userAsk = safeQuestion.match(/(?:这是什么问题|为什么(?:会)?这样|怎么(?:解决|处理|修改)|what(?:'s| is)? wrong|why|how (?:do|can|should))[^\r\n]{0,180}[?？]?$/i)?.[0];
  if (userAsk) parts.push(userAsk);
  const compact = uniqueStrings(parts, 24, 160).join(' ');
  return (compact || safeQuestion.slice(0, MAX_RETRIEVAL_QUERY_CHARS))
    .slice(0, MAX_RETRIEVAL_QUERY_CHARS);
}

function uniqueMatches(
  text: string,
  pattern: RegExp,
  maxItems: number,
  maxChars: number,
): string[] {
  return uniqueStrings([...text.matchAll(pattern)].map((match) => match[0]!), maxItems, maxChars);
}

function uniqueStrings(values: string[], maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxChars);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanScalar(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return cleaned || null;
}

function mergeVerifiedList(
  deterministic: string[],
  llmValue: unknown,
  source: string,
  maxItems: number,
  maxChars: number,
  caseSensitive = false,
): string[] {
  const candidate = Array.isArray(llmValue)
    ? llmValue.filter((item): item is string => typeof item === 'string')
    : [];
  const haystack = caseSensitive ? source : source.toLowerCase();
  const verified = candidate.filter((item) => {
    const needle = item.trim();
    if (!needle) return false;
    return haystack.includes(caseSensitive ? needle : needle.toLowerCase());
  });
  return uniqueStrings([...deterministic, ...verified], maxItems, maxChars);
}
