import assert from 'node:assert/strict';
import test from 'node:test';
import { PerUserQueue } from '../src/user-queue.js';

test('serializes one user while allowing different users to overlap', async () => {
  const queue = new PerUserQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const first = queue.run('alice', async () => {
    events.push('a1-start');
    await gate;
    events.push('a1-end');
  });
  const second = queue.run('alice', async () => {
    events.push('a2');
  });
  const bob = queue.run('bob', async () => {
    events.push('b1');
  });

  await bob;
  assert.deepEqual(events, ['a1-start', 'b1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
  assert.equal(queue.size, 0);
});

test('continues the queue after a failed turn', async () => {
  const queue = new PerUserQueue();
  const first = queue.run('alice', async () => {
    throw new Error('turn failed');
  });
  const second = queue.run('alice', async () => 'next turn');
  await assert.rejects(first, /turn failed/);
  assert.equal(await second, 'next turn');
});
