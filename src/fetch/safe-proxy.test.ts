import { describe, expect, it } from 'vitest';
import { isSafeAddress } from './safe-proxy.js';

describe('isSafeAddress', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', '::ffff:127.0.0.1'])('rejects private address %s', address => {
    expect(isSafeAddress(address)).toBe(false);
  });
  it('allows public IPv4 addresses', () => expect(isSafeAddress('93.184.216.34')).toBe(true));
});
