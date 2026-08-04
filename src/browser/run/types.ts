export const BROWSER_RUN_PLAYWRIGHT_VERSION = '1.61.1' as const;

export const BROWSER_RUN_DEFAULT_TIMEOUT_MS = 30_000;
export const BROWSER_RUN_MAX_SOURCE_BYTES = 256 * 1024;
export const BROWSER_RUN_DEFAULT_MAX_OUTPUT_CHARS = 65_536;
export const BROWSER_RUN_DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

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

export interface BrowserRunArtifactReceipt {
  artifactId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  locator: string;
}

export interface BrowserRunArtifactSink {
  write(input: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<BrowserRunArtifactReceipt>;
}

export interface BrowserRunWarning {
  code: 'BROWSER_RUN_SIDE_EFFECTS_MAY_HAVE_OCCURRED';
  message: string;
}

export interface BrowserRunLimits {
  outputTruncated: boolean;
  snapshotTruncated: boolean;
}

export interface BrowserRunFailureDetails {
  logs: BrowserRunLogEntry[];
  page: BrowserRunPageMetadata;
  snapshotDiff?: string;
  artifacts: BrowserRunArtifactReceipt[];
  warnings: BrowserRunWarning[];
  limits: BrowserRunLimits;
}

export class BrowserRunError extends Error {
  constructor(
    readonly code: BrowserRunErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: BrowserRunFailureDetails,
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

export interface BrowserRunResult {
  ok: true;
  result: unknown;
  logs: BrowserRunLogEntry[];
  page: BrowserRunPageMetadata;
  snapshotDiff?: string;
  artifacts: BrowserRunArtifactReceipt[];
  warnings: BrowserRunWarning[];
  limits: BrowserRunLimits;
}
