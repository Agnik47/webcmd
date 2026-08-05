import type {
  RenderedSnapshotChild,
  RenderedSnapshotFrame,
  RenderedSnapshotNode,
  SnapshotSubtreeSummary,
} from "./types.js";

export type SnapshotRepresentation = "identity" | "full";

export interface SnapshotAllocation {
  selected: Map<RenderedSnapshotNode, SnapshotRepresentation>;
  omittedByScope: Map<string, SnapshotSubtreeSummary>;
  criticalOmitted: number;
  truncated: boolean;
}

type Candidate = {
  node: RenderedSnapshotNode;
  ancestors: RenderedSnapshotNode[];
};

type AllocationState = {
  spent: number;
  scopeByNode: Map<RenderedSnapshotNode, string>;
};

const allocationStates = new WeakMap<SnapshotAllocation, AllocationState>();
const representationCosts = new WeakMap<
  RenderedSnapshotNode,
  Record<SnapshotRepresentation, number>
>();
const STATE_ATTRS = new Set([
  "ref",
  "checked",
  "disabled",
  "expanded",
  "invalid",
  "placeholder",
  "pressed",
  "readonly",
  "required",
  "selected",
  "value",
]);

export function allocateSnapshot(
  frames: RenderedSnapshotFrame[],
  maxChars: number,
  envelopeChars: number,
): SnapshotAllocation {
  const buckets: Candidate[][] = [[], [], [], [], []];
  collectCandidates(frames, buckets);
  breadthFirstRecordsWithinP2(buckets[2]!);
  const allocation = reserveEnvelopeAndMarkers(frames, maxChars, envelopeChars);
  for (let priority = 0; priority < buckets.length; priority += 1)
    for (const candidate of buckets[priority]!)
      trySelect(
        candidate,
        priority <= 2 ? "identity" : "full",
        allocation,
        maxChars,
      );
  allocation.criticalOmitted = totalOmitted(allocation, "critical");
  allocation.truncated = totalOmitted(allocation, "nodes") > 0 ||
    totalOmitted(allocation, "textChars") > 0;
  return allocation;
}

function collectCandidates(
  frames: RenderedSnapshotFrame[],
  buckets: Candidate[][],
): void {
  const visit = (
    node: RenderedSnapshotNode,
    ancestors: RenderedSnapshotNode[],
  ): void => {
    const depth = ancestors.length + 2;
    representationCosts.set(node, {
      identity: representationCost(node, "identity", depth),
      full: representationCost(node, "full", depth),
    });
    buckets[node.priority]!.push({ node, ancestors });
    const nextAncestors = [...ancestors, node];
    for (const child of node.children)
      if (child.kind === "node") visit(child, nextAncestors);
  };
  for (const frame of frames)
    if (frame.status === "ok")
      for (const root of frame.roots) visit(root, []);
}

function breadthFirstRecordsWithinP2(candidates: Candidate[]): void {
  const groups = new Map<RenderedSnapshotNode | null, Candidate[]>();
  for (const candidate of candidates) {
    const container = candidate.ancestors.at(-1) ?? null;
    const group = groups.get(container);
    if (group) group.push(candidate);
    else groups.set(container, [candidate]);
  }
  candidates.length = 0;
  for (let index = 0; ; index += 1) {
    let found = false;
    for (const group of groups.values()) {
      const candidate = group[index];
      if (candidate) {
        candidates.push(candidate);
        found = true;
      }
    }
    if (!found) return;
  }
}

function reserveEnvelopeAndMarkers(
  frames: RenderedSnapshotFrame[],
  _maxChars: number,
  envelopeChars: number,
): SnapshotAllocation {
  const omittedByScope = new Map<string, SnapshotSubtreeSummary>();
  const scopeByNode = new Map<RenderedSnapshotNode, string>();
  const visit = (node: RenderedSnapshotNode, scope: string): void => {
    scopeByNode.set(node, scope);
    for (const child of node.children)
      if (child.kind === "node") visit(child, scope);
  };
  for (const frame of frames)
    if (frame.status === "ok")
      for (const root of frame.roots) {
        const scope = root.scopeRef ?? firstScopeRef(root);
        if (!scope) continue;
        addSummary(omittedByScope, scope, root.summary);
        visit(root, scope);
      }
  const allocation: SnapshotAllocation = {
    selected: new Map(),
    omittedByScope,
    criticalOmitted: totalSummary(omittedByScope, "critical"),
    truncated: omittedByScope.size > 0,
  };
  allocationStates.set(allocation, {
    spent: envelopeChars + [...omittedByScope].reduce(
      (total, [ref, summary]) => total + markerCost(ref, summary),
      0,
    ),
    scopeByNode,
  });
  return allocation;
}

function trySelect(
  candidate: Candidate,
  representation: SnapshotRepresentation,
  allocation: SnapshotAllocation,
  maxChars: number,
): void {
  const state = allocationStates.get(allocation);
  if (!state) return;
  const current = allocation.selected.get(candidate.node);
  if (current) {
    if (current === "identity" && representation === "full")
      tryUpgrade(candidate, allocation, state, maxChars);
    return;
  }
  const missing = candidate.ancestors.filter(
    (ancestor) => !allocation.selected.has(ancestor),
  );
  const missingSet = new Set(missing);
  const cost = candidate.ancestors.reduce(
    (total, ancestor, index) => total + (
      missingSet.has(ancestor)
        ? representationCostFor(ancestor, "identity", index + 2)
        : 0
    ),
    0,
  ) + representationCostFor(
    candidate.node,
    representation,
    candidate.ancestors.length + 2,
  );
  if (state.spent + cost > maxChars) return;
  state.spent += cost;
  for (const ancestor of missing) select(ancestor, "identity", allocation, state);
  select(candidate.node, representation, allocation, state);
}

function tryUpgrade(
  candidate: Candidate,
  allocation: SnapshotAllocation,
  state: AllocationState,
  maxChars: number,
): void {
  const depth = candidate.ancestors.length + 2;
  const cost = representationCostFor(candidate.node, "full", depth) -
    representationCostFor(candidate.node, "identity", depth);
  if (state.spent + cost > maxChars) return;
  state.spent += cost;
  allocation.selected.set(candidate.node, "full");
  const scope = state.scopeByNode.get(candidate.node);
  const omitted = scope ? allocation.omittedByScope.get(scope) : undefined;
  if (omitted)
    omitted.textChars = Math.max(
      0,
      omitted.textChars - (
        directTextChars(candidate.node.children) -
        representedTextChars(candidate.node, "identity")
      ),
    );
}

function select(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
  allocation: SnapshotAllocation,
  state: AllocationState,
): void {
  allocation.selected.set(node, representation);
  const scope = state.scopeByNode.get(node);
  const omitted = scope ? allocation.omittedByScope.get(scope) : undefined;
  if (!omitted) return;
  const own = ownSummary(node, representation);
  for (const key of summaryKeys) omitted[key] = Math.max(0, omitted[key] - own[key]);
}

function ownSummary(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
): SnapshotSubtreeSummary {
  const childSummary = emptySummary();
  for (const child of node.children)
    if (child.kind === "node") addToSummary(childSummary, child.summary);
  return {
    nodes: 1,
    actions: Math.max(0, node.summary.actions - childSummary.actions),
    records: node.record ? 1 : 0,
    textChars: representedTextChars(node, representation),
    changed: Math.max(0, node.summary.changed - childSummary.changed),
    critical: node.priority === 0 ? 1 : 0,
  };
}

function representedTextChars(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
): number {
  const direct = directTextChars(node.children);
  if (representation === "full") return direct;
  const label = identityLabel(node);
  return label ? Math.min(direct, label.length) : 0;
}

function representationCost(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
  depth: number,
): number {
  const attrs = representation === "identity"
    ? identityAttrs(node)
    : renderAttrs(node.attrs);
  const prefix = "\t".repeat(depth);
  const label = representation === "identity" ? identityLabel(node) : null;
  if (label && !node.record)
    return `${prefix}<${node.role}${attrs}>${escapeText(label)}</${node.role}>\n`.length;
  let cost = `${prefix}<${node.role}${attrs}>\n${prefix}</${node.role}>\n`.length;
  if (label) cost += `${prefix}\t${escapeText(label)}\n`.length;
  if (representation === "full")
    for (const child of node.children)
      if (child.kind === "text") cost += `${prefix}\t${escapeText(child.text)}\n`.length;
  return cost;
}

function representationCostFor(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
  depth: number,
): number {
  return representationCosts.get(node)?.[representation] ??
    representationCost(node, representation, depth);
}

export function snapshotIdentityAttrs(node: RenderedSnapshotNode): Array<[string, string]> {
  return node.attrs.filter(([name, value]) => STATE_ATTRS.has(name) && value !== "");
}

export function snapshotIdentityLabel(node: RenderedSnapshotNode): string | null {
  return identityLabel(node);
}

function identityAttrs(node: RenderedSnapshotNode): string {
  return renderAttrs(snapshotIdentityAttrs(node));
}

function renderAttrs(attrs: Array<[string, string]>): string {
  return attrs
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function identityLabel(node: RenderedSnapshotNode): string | null {
  return node.record
    ? node.recordIdentity.name ?? node.recordIdentity.action
    : ownActions(node) > 0 ? node.recordIdentity.action : null;
}

function ownActions(node: RenderedSnapshotNode): number {
  let childActions = 0;
  for (const child of node.children)
    if (child.kind === "node") childActions += child.summary.actions;
  return Math.max(0, node.summary.actions - childActions);
}

function firstScopeRef(node: RenderedSnapshotNode): string | null {
  if (node.scopeRef) return node.scopeRef;
  for (const child of node.children)
    if (child.kind === "node") {
      const ref = firstScopeRef(child);
      if (ref) return ref;
    }
  return null;
}

function markerCost(ref: string, summary: SnapshotSubtreeSummary): number {
  return `\t\t${renderSnapshotMarker(ref, summary)}\n`.length;
}

export function renderSnapshotMarker(
  ref: string,
  summary: SnapshotSubtreeSummary,
): string {
  const fields: Array<[string, number]> = [
    ["nodes", summary.nodes],
    ["actions", summary.actions],
    ["records", summary.records],
    ["textChars", summary.textChars],
    ["changed", summary.changed],
    ["criticalOmitted", summary.critical],
  ];
  return `[more ref=${ref}${fields
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ` ${name}=${value}`)
    .join("")}]`;
}

function addSummary(
  summaries: Map<string, SnapshotSubtreeSummary>,
  ref: string,
  summary: SnapshotSubtreeSummary,
): void {
  const current = summaries.get(ref) ?? emptySummary();
  addToSummary(current, summary);
  summaries.set(ref, current);
}

const summaryKeys = [
  "nodes",
  "actions",
  "records",
  "textChars",
  "changed",
  "critical",
] as const;

function emptySummary(): SnapshotSubtreeSummary {
  return { nodes: 0, actions: 0, records: 0, textChars: 0, changed: 0, critical: 0 };
}

function addToSummary(
  target: SnapshotSubtreeSummary,
  source: SnapshotSubtreeSummary,
): void {
  for (const key of summaryKeys) target[key] += source[key];
}

function totalSummary(
  summaries: Map<string, SnapshotSubtreeSummary>,
  key: keyof SnapshotSubtreeSummary,
): number {
  let total = 0;
  for (const summary of summaries.values()) total += summary[key];
  return total;
}

function totalOmitted(
  allocation: SnapshotAllocation,
  key: keyof SnapshotSubtreeSummary,
): number {
  return totalSummary(allocation.omittedByScope, key);
}

function directTextChars(children: RenderedSnapshotChild[]): number {
  let total = 0;
  for (const child of children) if (child.kind === "text") total += child.text.length;
  return total;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
