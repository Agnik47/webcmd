/*
 * Portions of the snapshot model are derived from libretto-browser-tools.
 * MIT License, Copyright (c) 2026 Libretto contributors.
 */

export type SnapshotMode = 'act' | 'read';

export type SnapshotPrimitive = string | number | boolean | null;

export interface AiSnapshot {
  title: string;
  url: string;
  frames: AiSnapshotFrame[];
}

export type AiSnapshotFrame = AiSnapshotAvailableFrame | AiSnapshotUnavailableFrame;

export interface AiSnapshotAvailableFrame {
  status: 'ok';
  id: string;
  index: number;
  url: string;
  name: string | null;
  parentId: string | null;
  roots: AiSnapshotNode[];
}

export interface AiSnapshotUnavailableFrame {
  status: 'unavailable';
  id: string;
  index: number;
  url: string;
  name: string | null;
  parentId: string | null;
  error: string;
}

export interface AiSnapshotNode {
  nodeId: string;
  ignored: boolean;
  role: string;
  name: string | null;
  value: SnapshotPrimitive;
  description: string | null;
  properties: Record<string, SnapshotPrimitive>;
  attributes: Record<string, string>;
  children: AiSnapshotNode[];
  ref: string | null;
  subtreeSize: number;
}

export interface SnapshotTextNode {
  kind: 'text';
  text: string;
  block?: boolean;
}

export interface RenderedSnapshotNode {
  kind: 'node';
  key: string;
  role: string;
  attrs: Array<[string, string]>;
  children: RenderedSnapshotChild[];
}

export type RenderedSnapshotChild = RenderedSnapshotNode | SnapshotTextNode;

export type RenderedSnapshotFrame =
  | {
      status: 'ok';
      id: string;
      index: number;
      url: string;
      name: string | null;
      parentId: string | null;
      roots: RenderedSnapshotNode[];
    }
  | {
      status: 'unavailable';
      id: string;
      index: number;
      url: string;
      name: string | null;
      parentId: string | null;
      error: string;
    };

export interface BoundedSnapshotText {
  value: string;
  truncated: boolean;
}
