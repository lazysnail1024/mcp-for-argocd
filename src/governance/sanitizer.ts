const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';
const REDACTED_VALUE = '[REDACTED]';

// Fields in Argo CD responses that hold JSON-serialized Kubernetes manifests.
const EMBEDDED_MANIFEST_KEYS = new Set([
  'manifest',
  'liveState',
  'targetState',
  'normalizedLiveState',
  'predictedLiveState'
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const redactRecordValues = (record: unknown): unknown => {
  if (!isPlainObject(record)) return record;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    out[key] = REDACTED_VALUE;
  }
  return out;
};

const sanitizeMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'managedFields') {
      continue;
    }
    if (key === 'annotations' && isPlainObject(value)) {
      const nextAnnotations: Record<string, unknown> = {};
      for (const [annKey, annVal] of Object.entries(value)) {
        if (annKey === LAST_APPLIED_ANNOTATION) {
          continue;
        }
        nextAnnotations[annKey] = annVal;
      }
      if (Object.keys(nextAnnotations).length > 0) {
        cleaned.annotations = nextAnnotations;
      }
      continue;
    }
    cleaned[key] = sanitizePayload(value);
  }
  return cleaned;
};

// Recursively strip Kubernetes machine noise (managedFields and last-applied-configuration)
// and enforce a fallback "[REDACTED]" guard on v1/Secret data/stringData in case
// a Secret carried `argocd.argoproj.io/show-secret-value: "true"`.
// Normal ConfigMap / env / Helm configuration fields are preserved intact.
export const sanitizeManifestString = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return raw;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(sanitizePayload(parsed));
  } catch {
    return raw;
  }
};

export const sanitizePayload = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const isSecret = value.kind === 'Secret';
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'managedFields') {
      continue;
    }
    if (key === 'metadata' && isPlainObject(entry)) {
      result.metadata = sanitizeMetadata(entry);
      continue;
    }
    if (isSecret && (key === 'data' || key === 'stringData')) {
      result[key] = redactRecordValues(entry);
      continue;
    }
    if (EMBEDDED_MANIFEST_KEYS.has(key) && typeof entry === 'string') {
      result[key] = sanitizeManifestString(entry);
      continue;
    }
    result[key] = sanitizePayload(entry);
  }

  return result as T;
};
