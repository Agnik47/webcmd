import { describe, expect, it } from 'vitest';
import { diffSnapshots, renderSnapshotDiff } from './diff.js';
import type { AiSnapshot, AiSnapshotNode } from './types.js';

function node(input: Partial<AiSnapshotNode> & { role: string }): AiSnapshotNode {
  return {
    nodeId: input.nodeId ?? input.ref ?? input.role,
    ignored: input.ignored ?? false,
    role: input.role,
    name: input.name ?? null,
    value: input.value ?? null,
    description: input.description ?? null,
    properties: input.properties ?? {},
    attributes: input.attributes ?? {},
    ref: input.ref ?? null,
    subtreeSize: input.subtreeSize ?? 1,
    children: input.children ?? [],
  };
}

function snap(children: AiSnapshotNode[], url = 'https://example.test/docs?utm=old#top'): AiSnapshot {
  return {
    title: 'Demo',
    url,
    frames: [{
      status: 'ok',
      id: 'main',
      index: 0,
      url,
      name: null,
      parentId: null,
      roots: [node({ role: 'RootWebArea', ref: 'l1', children: [
        node({ role: 'main', ref: 'l2', children }),
      ] })],
    }],
  };
}

describe('snapshot diff', () => {
  it('renders same-ref text modifications compactly', () => {
    const before = snap([node({ role: 'button', name: 'Save', ref: 'l3' })]);
    const after = snap([node({ role: 'button', name: 'Saved', ref: 'l3' })]);

    const rendered = renderSnapshotDiff(diffSnapshots(before, after)).value;

    expect(rendered).toContain('<page');
    expect(rendered).toContain('~ ');
    expect(rendered).toContain('<button ref="l3">Saved</button>');
  });

  it('suppresses ref-only changes', () => {
    const before = snap([node({ role: 'link', name: 'Docs', ref: 'l3', attributes: { href: 'https://example.test/docs' } })]);
    const after = snap([node({ role: 'link', name: 'Docs', ref: 'l99', attributes: { href: 'https://example.test/docs' } })]);

    expect(renderSnapshotDiff(diffSnapshots(before, after)).value).toBe('');
  });

  it('suppresses href query and fragment changes', () => {
    const before = snap([node({ role: 'link', name: 'Docs', ref: 'l3', attributes: { href: 'https://example.test/docs?utm=old#top' } })]);
    const after = snap([node({ role: 'link', name: 'Docs', ref: 'l3', attributes: { href: 'https://example.test/docs?utm=new#api' } })]);

    expect(renderSnapshotDiff(diffSnapshots(before, after)).value).toBe('');
  });

  it('bounds rendered diff text', () => {
    const before = snap([node({ role: 'button', name: 'Save', ref: 'l3' })]);
    const after = snap([node({ role: 'button', name: 'Saved', ref: 'l3' })]);

    const bounded = renderSnapshotDiff(diffSnapshots(before, after), 10);

    expect(bounded.value.length).toBeGreaterThan(10);
    expect(bounded.truncated).toBe(true);
  });
});
