export const BROWSER_RUN_PROTOCOL_VERSION = 1 as const;
export const BROWSER_RUN_PLAYWRIGHT_VERSION = '1.61.1' as const;

export const BROWSER_RUN_DEFAULT_TIMEOUT_MS = 30_000;
export const BROWSER_RUN_MAX_SOURCE_BYTES = 256 * 1024;
export const BROWSER_RUN_DEFAULT_MAX_OUTPUT_CHARS = 65_536;
export const BROWSER_RUN_DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const BROWSER_RUN_MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
export const BROWSER_RUN_MAX_UPLOAD_FILES = 8;
export const BROWSER_RUN_MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const BROWSER_RUN_MAX_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;

export type BrowserRunObserveMode = 'diff' | 'full' | 'none';

export type BrowserRunErrorCode =
  | 'BROWSER_RUN_INVALID_INPUT'
  | 'BROWSER_RUN_SOURCE_LIMIT'
  | 'BROWSER_RUN_SYNTAX_ERROR'
  | 'BROWSER_RUN_PROTOCOL_MISMATCH'
  | 'BROWSER_RUN_API_UNSUPPORTED'
  | 'BROWSER_RUN_TIMEOUT'
  | 'BROWSER_RUN_MEMORY_LIMIT'
  | 'BROWSER_RUN_CANCELLED'
  | 'BROWSER_RUN_OUTPUT_LIMIT'
  | 'BROWSER_RUN_SERIALIZATION_ERROR';

export class BrowserRunError extends Error {
  constructor(
    readonly code: BrowserRunErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'BrowserRunError';
  }
}

export interface BrowserRunOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  memoryLimitBytes?: number;
  observe?: BrowserRunObserveMode;
}

export interface BrowserRunLogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  args: unknown[];
}

export interface BrowserRunPageMetadata {
  id: string;
  url: string;
  title: string;
}

export type BrowserRunObservation =
  | { mode: 'none' }
  | { mode: 'full'; content: string }
  | { mode: 'diff'; changed: string };

export interface BrowserRunLimits {
  outputTruncated: boolean;
  observationTruncated: boolean;
}

export interface BrowserRunResult {
  ok: true;
  result: unknown;
  logs: BrowserRunLogEntry[];
  page: BrowserRunPageMetadata;
  observation: BrowserRunObservation;
  limits: BrowserRunLimits;
}

export interface BrowserRunScreenshotReceipt {
  kind: 'screenshot';
  artifactId: string;
  filename: string;
  contentType: 'image/png' | 'image/jpeg';
  byteSize: number;
  path: string;
}
