const MAX_CHANGED_CHILDREN = 4;
const MAX_LABEL_CHARS = 140;

type SnapshotNode = {
  label: string;
  indent: number;
  children: SnapshotNode[];
};

type NodeDiff =
  | { type: 'added'; node: SnapshotNode }
  | { type: 'removed'; node: SnapshotNode }
  | { type: 'modified'; before: SnapshotNode; after: SnapshotNode; children: NodeDiff[] }
  | { type: 'context'; node: SnapshotNode; children: NodeDiff[] };

export function diffSnapshots(before: string, after: string, maxChars = Number.POSITIVE_INFINITY): string {
  const changes = diffChildren(parseSnapshot(before), parseSnapshot(after));
  const lines: string[] = [];
  renderDiffs(changes, lines);
  return lines.join('\n').slice(0, Math.max(0, maxChars));
}

export function boundSnapshotDiff(before: string, after: string, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  const value = diffSnapshots(before, after);
  return {
    value: value.slice(0, maxChars),
    truncated: value.length > maxChars,
  };
}

function parseSnapshot(snapshot: string): SnapshotNode[] {
  const firstDivider = snapshot.indexOf('\n---\n');
  const body = firstDivider === -1 ? snapshot : snapshot.slice(firstDivider + 5).split('\n---\n', 1)[0]!;
  const roots: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];

  for (const rawLine of body.split('\n')) {
    const label = rawLine.trim();
    if (!label || label.startsWith('</')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const node: SnapshotNode = { label, indent, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function diffChildren(before: SnapshotNode[], after: SnapshotNode[]): NodeDiff[] {
  const changes: NodeDiff[] = [];
  const used = new Set<number>();

  for (let afterIndex = 0; afterIndex < after.length; afterIndex += 1) {
    const afterNode = after[afterIndex]!;
    const sameIndex = before[afterIndex];
    let beforeIndex = sameIndex && !used.has(afterIndex) && similar(sameIndex, afterNode)
      ? afterIndex
      : before.findIndex((node, index) => !used.has(index) && comparable(node) === comparable(afterNode));
    if (beforeIndex === -1) {
      beforeIndex = before.findIndex((node, index) => !used.has(index) && similar(node, afterNode));
    }
    if (beforeIndex === -1) {
      changes.push({ type: 'added', node: afterNode });
      continue;
    }
    used.add(beforeIndex);
    const beforeNode = before[beforeIndex]!;
    const children = diffChildren(beforeNode.children, afterNode.children);
    if (comparable(beforeNode) !== comparable(afterNode)) {
      changes.push({ type: 'modified', before: beforeNode, after: afterNode, children });
    } else if (children.length > 0) {
      changes.push({ type: 'context', node: afterNode, children });
    }
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!used.has(index)) changes.push({ type: 'removed', node: before[index]! });
  }
  return changes;
}

function comparable(node: SnapshotNode): string {
  return node.label
    .replace(/^\[\d+\]/, '')
    .replace(/href=("[^"]*"|'[^']*'|[^\s>]+)/g, (_match, href: string) => `href=${normalizeHref(href)}`)
    .replace(/\]\(([^)\s]+)\)/g, (_match, href: string) => `](${normalizeHref(href)})`);
}

function normalizeHref(rawHref: string): string {
  const href = rawHref.replace(/^['"]|['"]$/g, '');
  try {
    const url = new URL(href);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return href.split(/[?#]/, 1)[0] ?? href;
  }
}

function similar(before: SnapshotNode, after: SnapshotNode): boolean {
  const role = (node: SnapshotNode) => node.label.match(/<([\w-]+)/)?.[1] ?? '#text';
  return role(before) === role(after);
}

function renderDiffs(diffs: NodeDiff[], lines: string[]): void {
  for (const diff of diffs.slice(0, MAX_CHANGED_CHILDREN)) renderDiff(diff, lines);
  if (diffs.length > MAX_CHANGED_CHILDREN) {
    lines.push(truncationNotice(diffs.length - MAX_CHANGED_CHILDREN));
  }
}

function renderDiff(diff: NodeDiff, lines: string[]): void {
  if (diff.type === 'added') {
    renderNode(diff.node, '+ ', lines);
  } else if (diff.type === 'removed') {
    renderNode(diff.node, '- ', lines);
  } else if (diff.type === 'modified') {
    lines.push(`~ ${label(diff.after)}`);
    renderDiffs(diff.children, lines);
  } else {
    lines.push(label(diff.node));
    renderDiffs(diff.children, lines);
    lines.push(`</${diff.node.label.match(/<([\w-]+)/)?.[1] ?? 'context'}>`);
  }
}

function renderNode(node: SnapshotNode, prefix: '+ ' | '- ', lines: string[]): void {
  lines.push(`${prefix}${label(node)}`);
  for (const child of node.children.slice(0, MAX_CHANGED_CHILDREN)) {
    renderNode(child, prefix, lines);
  }
  if (node.children.length > MAX_CHANGED_CHILDREN) {
    lines.push(`${prefix}${' '.repeat(node.indent + 2)}${truncationNotice(node.children.length - MAX_CHANGED_CHILDREN)}`);
  }
}

function label(node: SnapshotNode): string {
  const match = node.label.match(/^(.*?>)(.*?)(<\/[^>]+>)$/);
  const value = match
    ? `${match[1]}${truncate(match[2]!)}${match[3]}`
    : truncate(node.label);
  return `${' '.repeat(node.indent)}${value}`;
}

function truncate(value: string): string {
  return value.length > MAX_LABEL_CHARS
    ? `${value.slice(0, MAX_LABEL_CHARS - 1)}…`
    : value;
}

function truncationNotice(count: number): string {
  return `[Truncated ${count} more ${count === 1 ? 'element' : 'elements'}]`;
}
