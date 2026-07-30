import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

describe('log', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    delete process.env.WEBCMD_VERBOSE;
  });

  afterEach(() => {
    delete process.env.WEBCMD_VERBOSE;
    vi.restoreAllMocks();
  });

  it.each([
    ['info', 'hello', 'ℹ  hello\n'],
    ['status', 'working', 'working\n'],
    ['success', 'done', 'done\n'],
    ['warn', 'careful', '⚠  careful\n'],
    ['error', 'broken', '✖  broken\n'],
  ] as const)('writes %s messages to stderr', (method, message, expected) => {
    log[method](message);
    expect(stderrSpy).toHaveBeenCalledWith(expected);
  });

  it('suppresses verbose output by default', () => {
    log.verbose('hidden');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', 'debug'])('emits verbose output when WEBCMD_VERBOSE=%s', (value) => {
    process.env.WEBCMD_VERBOSE = value;
    log.verbose('shown');
    expect(stderrSpy).toHaveBeenCalledWith('[verbose] shown\n');
  });

  it.each(['', '0', 'false', 'FALSE', 'no', 'off'])('suppresses verbose output when WEBCMD_VERBOSE=%s', (value) => {
    process.env.WEBCMD_VERBOSE = value;
    log.verbose('hidden');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('routes debug through verbose gating', () => {
    process.env.WEBCMD_VERBOSE = '1';
    log.debug('debug message');
    expect(stderrSpy).toHaveBeenCalledWith('[verbose] debug message\n');
  });

  it('writes step progress and result summaries', () => {
    log.step(2, 5, 'fetch', ' -> example');
    log.stepResult('3 items');

    expect(stderrSpy.mock.calls).toEqual([
      ['  [2/5] fetch -> example\n'],
      ['       → 3 items\n'],
    ]);
  });
});
