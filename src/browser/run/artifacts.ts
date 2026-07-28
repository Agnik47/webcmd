import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Locator as PlaywrightLocator,
  Page as PlaywrightPage,
} from 'playwright-core';
import type { BrowserRunScreenshotReceipt } from './types.js';

export interface BrowserRunArtifactWriterOptions {
  baseDir?: string;
}

function defaultArtifactBaseDir(): string {
  const cacheDir = process.env.WEBCMD_CACHE_DIR
    || path.join(os.homedir(), '.webcmd', 'cache');
  return path.join(cacheDir, 'browser-run');
}

function screenshotType(options: Record<string, unknown>): 'png' | 'jpeg' {
  return options.type === 'jpeg' ? 'jpeg' : 'png';
}

export class BrowserRunArtifactWriter {
  readonly #baseDir: string;

  constructor(options: BrowserRunArtifactWriterOptions = {}) {
    this.#baseDir = path.resolve(options.baseDir ?? defaultArtifactBaseDir());
  }

  async writeScreenshot(
    target: Pick<PlaywrightPage, 'screenshot'> | Pick<PlaywrightLocator, 'screenshot'>,
    input: unknown,
  ): Promise<BrowserRunScreenshotReceipt> {
    const requested = (
      typeof input === 'object'
      && input !== null
      && !Array.isArray(input)
    )
      ? input as Record<string, unknown>
      : {};
    const { path: _ignoredPath, ...safeOptions } = requested;
    const type = screenshotType(safeOptions);
    const artifactId = `shot_${randomBytes(12).toString('hex')}`;
    const filename = `${artifactId}.${type === 'jpeg' ? 'jpg' : 'png'}`;
    const runDir = path.join(this.#baseDir, artifactId);
    const outputPath = path.join(runDir, filename);

    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const bytes = await target.screenshot({
      ...safeOptions,
      type,
      path: undefined,
    } as never);
    const buffer = Buffer.from(bytes);
    await fs.writeFile(outputPath, buffer, { mode: 0o600 });

    return {
      kind: 'screenshot',
      artifactId,
      filename,
      contentType: type === 'jpeg' ? 'image/jpeg' : 'image/png',
      byteSize: buffer.byteLength,
      path: outputPath,
    };
  }
}
