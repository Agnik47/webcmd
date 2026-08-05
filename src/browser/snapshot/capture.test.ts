import { describe, expect, it } from 'vitest';
import { findSnapshotNodeByRef, scopeSnapshotToRef } from './capture.js';
import type { AiSnapshot } from './types.js';

function snapshot(): AiSnapshot {
  return {
    title: 'Demo',
    url: 'https://example.test/',
    frames: [{
      status: 'ok',
      id: 'main',
      index: 0,
      url: 'https://example.test/',
      name: null,
      parentId: null,
      roots: [{
        nodeId: '1',
        ignored: false,
        role: 'document',
        name: null,
        value: null,
        description: null,
        properties: {},
        attributes: {},
        ref: 'l1',
        subtreeSize: 2,
        children: [{
          nodeId: '2',
          ignored: false,
          role: 'button',
          name: 'Save',
          value: null,
          description: null,
          properties: {},
          attributes: {},
          ref: 'l2',
          subtreeSize: 1,
          children: [],
        }],
      }],
    }],
  };
}

describe('snapshot ref helpers', () => {
  it('finds refs exactly', () => {
    expect(findSnapshotNodeByRef(snapshot(), 'l2').name).toBe('Save');
  });

  it('finds refs by numeric suffix fallback', () => {
    expect(findSnapshotNodeByRef(snapshot(), 'e2').name).toBe('Save');
  });

  it('scopes a snapshot to the frame containing the ref', () => {
    const scoped = scopeSnapshotToRef(snapshot(), 'l2');
    expect(scoped.frames).toHaveLength(1);
    expect(scoped.frames[0]).toMatchObject({ status: 'ok' });
    if (scoped.frames[0]?.status !== 'ok') throw new Error('expected ok frame');
    expect(scoped.frames[0].roots[0]?.name).toBe('Save');
  });
});
