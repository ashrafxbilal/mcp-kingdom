import fs from 'node:fs/promises';
import path from 'node:path';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${safeJsonStringify(value, 2)}\n`, 'utf8');
}

export function timestampId(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function expandEnvString(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let expanded = value;

  if (expanded.startsWith('~/')) {
    const home = env.HOME ?? env.USERPROFILE;
    if (home) {
      expanded = path.join(home, expanded.slice(2));
    }
  }

  expanded = expanded.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
  expanded = expanded.replace(/\$([A-Z0-9_]+)/gi, (_, name: string) => env[name] ?? '');
  return expanded;
}

export function expandDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return expandEnvString(value, env) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandDeep(item, env)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandDeep(item, env);
    }
    return out as T;
  }
  return value;
}

export function truncateText(value: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (value.length <= maxCharacters) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxCharacters)}\n\n... [truncated ${value.length - maxCharacters} chars]`,
    truncated: true,
  };
}

export function safeJsonStringify(value: unknown, spacing = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === 'bigint') {
        return currentValue.toString();
      }
      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }
      return currentValue;
    },
    spacing,
  );
}

export function scoreText(haystack: string, query: string): number {
  const normalizedHaystack = haystack.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 1;
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = 0;

  for (const term of terms) {
    if (normalizedHaystack === term) {
      score += 20;
      continue;
    }
    if (normalizedHaystack.startsWith(term)) {
      score += 10;
      continue;
    }
    const index = normalizedHaystack.indexOf(term);
    if (index >= 0) {
      score += Math.max(3, 8 - Math.min(index, 5));
    }
  }

  return score;
}

export function parseObjectArgument(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed JSON arguments must be an object.');
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('arguments must be an object or a JSON string.');
}

export function splitPathList(value: string): string[] {
  return value
    .split(path.delimiter)
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
