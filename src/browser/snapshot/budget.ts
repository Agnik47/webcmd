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
  parent: Candidate | null;
  depth: number;
  missingCostGeneration: number;
  missingIdentityCost: number;
};

type AllocationState = {
  contentChars: number;
  markerChars: number;
  scopeByNode: Map<RenderedSnapshotNode, string>;
  markerDepthByScope: Map<string, number>;
  selectionGeneration: number;
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
  if (envelopeChars > maxChars) return finish(allocation);
  const candidates = buckets.flat();
  if (trySelectComplete(candidates, allocation, maxChars)) return finish(allocation);
  for (let priority = 0; priority < buckets.length; priority += 1)
    for (const candidate of buckets[priority]!)
      trySelect(
        candidate,
        priority <= 2 ? "identity" : "full",
        allocation,
        maxChars,
      );
  return finish(allocation);
}

function finish(allocation: SnapshotAllocation): SnapshotAllocation {
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
    parent: Candidate | null,
    depth: number,
  ): void => {
    const candidate = {
      node,
      parent,
      depth,
      missingCostGeneration: -1,
      missingIdentityCost: 0,
    };
    representationCosts.set(node, {
      identity: representationCost(node, "identity", depth),
      full: representationCost(node, "full", depth),
    });
    buckets[node.priority]!.push(candidate);
    for (const child of node.children)
      if (child.kind === "node") visit(child, candidate, depth + 1);
  };
  for (const frame of frames)
    if (frame.status === "ok")
      for (const root of frame.roots) visit(root, null, 2);
}

function breadthFirstRecordsWithinP2(candidates: Candidate[]): void {
  const groups = new Map<RenderedSnapshotNode | null, Candidate[]>();
  for (const candidate of candidates) {
    const container = candidate.parent?.node ?? null;
    const group = groups.get(container);
    if (group) group.push(candidate);
    else groups.set(container, [candidate]);
  }
  candidates.length = 0;
  let active = [...groups.values()].map((group) => ({ group, index: 0 }));
  while (active.length) {
    const next = [] as typeof active;
    for (const entry of active) {
      candidates.push(entry.group[entry.index]!);
      entry.index += 1;
      if (entry.index < entry.group.length) next.push(entry);
    }
    active = next;
  }
}

function reserveEnvelopeAndMarkers(
  frames: RenderedSnapshotFrame[],
  maxChars: number,
  envelopeChars: number,
): SnapshotAllocation {
  const omittedByScope = new Map<string, SnapshotSubtreeSummary>();
  const scopeByNode = new Map<RenderedSnapshotNode, string>();
  const markerDepthByScope = new Map<string, number>();
  const visit = (
    node: RenderedSnapshotNode,
    scope: string,
    depth: number,
  ): void => {
    scopeByNode.set(node, scope);
    addSummary(omittedByScope, scope, ownSummary(node, "full"));
    const childScope = node.scopeRef ?? scope;
    if (node.scopeRef) markerDepthByScope.set(node.scopeRef, depth + 1);
    for (const child of node.children)
      if (child.kind === "node") visit(child, childScope, depth + 1);
  };
  for (const frame of frames)
    if (frame.status === "ok")
      for (const root of frame.roots) {
        const scope = root.scopeRef ?? firstScopeRef(root);
        if (!scope) continue;
        markerDepthByScope.set(scope, 3);
        visit(root, scope, 2);
      }
  const allocation: SnapshotAllocation = {
    selected: new Map(),
    omittedByScope,
    criticalOmitted: totalSummary(omittedByScope, "critical"),
    truncated: omittedByScope.size > 0,
  };
  const markerChars = envelopeChars > maxChars ? 0 : [...omittedByScope].reduce(
    (total, [ref, summary]) => total + markerCost(
      ref,
      summary,
      markerDepthByScope.get(ref) ?? 2,
    ),
    0,
  );
  allocationStates.set(allocation, {
    contentChars: envelopeChars,
    markerChars,
    scopeByNode,
    markerDepthByScope,
    selectionGeneration: 0,
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
  const candidateCost = representationCostFor(
    candidate.node,
    representation,
    candidate.depth,
  );
  const ancestorCost = missingAncestorIdentityCost(candidate, allocation, state);
  if (state.contentChars + ancestorCost + candidateCost > maxChars) return;
  const missing: Candidate[] = [];
  for (
    let ancestor = candidate.parent;
    ancestor && !allocation.selected.has(ancestor.node);
    ancestor = ancestor.parent
  ) missing.push(ancestor);
  missing.reverse();
  const selections: Array<[Candidate, SnapshotRepresentation]> = [
    ...missing.map(
      (ancestor): [Candidate, SnapshotRepresentation] => [ancestor, "identity"],
    ),
    [candidate, representation],
  ];
  const cost = missing.reduce(
    (total, ancestor) => total + representationCostFor(
      ancestor.node,
      "identity",
      ancestor.depth,
    ),
    0,
  ) + candidateCost;
  if (
    state.contentChars + cost + projectedMarkerChars(selections, allocation, state) >
    maxChars
  ) return;
  state.contentChars += cost;
  for (const ancestor of missing)
    select(ancestor.node, "identity", allocation, state);
  select(candidate.node, representation, allocation, state);
  state.selectionGeneration += 1;
}

function missingAncestorIdentityCost(
  candidate: Candidate,
  allocation: SnapshotAllocation,
  state: AllocationState,
): number {
  if (candidate.missingCostGeneration === state.selectionGeneration)
    return candidate.missingIdentityCost;
  const parent = candidate.parent;
  const cost = !parent || allocation.selected.has(parent.node)
    ? 0
    : representationCostFor(parent.node, "identity", parent.depth) +
      missingAncestorIdentityCost(parent, allocation, state);
  candidate.missingCostGeneration = state.selectionGeneration;
  candidate.missingIdentityCost = cost;
  return cost;
}

function tryUpgrade(
  candidate: Candidate,
  allocation: SnapshotAllocation,
  state: AllocationState,
  maxChars: number,
): void {
  const depth = candidate.depth;
  const cost = representationCostFor(candidate.node, "full", depth) -
    representationCostFor(candidate.node, "identity", depth);
  if (
    state.contentChars + cost + projectedMarkerChars(
      [[candidate, "full"]],
      allocation,
      state,
      true,
    ) > maxChars
  ) return;
  state.contentChars += cost;
  allocation.selected.set(candidate.node, "full");
  subtractOmitted(
    candidate.node,
    {
      ...emptySummary(),
      textChars: directTextChars(candidate.node.children) -
        representedTextChars(candidate.node, "identity"),
    },
    allocation,
    state,
  );
  state.selectionGeneration += 1;
}

function select(
  node: RenderedSnapshotNode,
  representation: SnapshotRepresentation,
  allocation: SnapshotAllocation,
  state: AllocationState,
): void {
  allocation.selected.set(node, representation);
  subtractOmitted(node, ownSummary(node, representation), allocation, state);
}

function subtractOmitted(
  node: RenderedSnapshotNode,
  represented: SnapshotSubtreeSummary,
  allocation: SnapshotAllocation,
  state: AllocationState,
): void {
  const scope = state.scopeByNode.get(node);
  const omitted = scope ? allocation.omittedByScope.get(scope) : undefined;
  if (!scope || !omitted) return;
  const oldCost = markerCostForScope(scope, omitted, state);
  subtractSummary(omitted, represented);
  state.markerChars += markerCostForScope(scope, omitted, state) - oldCost;
}

function trySelectComplete(
  candidates: Candidate[],
  allocation: SnapshotAllocation,
  maxChars: number,
): boolean {
  const state = allocationStates.get(allocation);
  if (!state) return false;
  const projected = cloneSummaries(allocation.omittedByScope);
  let contentChars = state.contentChars;
  for (const candidate of candidates) {
    const representation = candidate.node.priority <= 2 ? "identity" : "full";
    contentChars += representationCostFor(candidate.node, representation, candidate.depth);
    const scope = state.scopeByNode.get(candidate.node);
    const summary = scope ? projected.get(scope) : undefined;
    if (summary) subtractSummary(summary, ownSummary(candidate.node, representation));
  }
  const markerChars = [...projected].reduce(
    (total, [scope, summary]) => total + markerCostForScope(scope, summary, state),
    0,
  );
  if (contentChars + markerChars > maxChars) return false;
  for (const candidate of candidates)
    select(
      candidate.node,
      candidate.node.priority <= 2 ? "identity" : "full",
      allocation,
      state,
    );
  state.contentChars = contentChars;
  return true;
}

function projectedMarkerChars(
  selections: Array<[Candidate, SnapshotRepresentation]>,
  allocation: SnapshotAllocation,
  state: AllocationState,
  upgrade = false,
): number {
  const projected = new Map<string, SnapshotSubtreeSummary>();
  for (const [candidate, representation] of selections) {
    const scope = state.scopeByNode.get(candidate.node);
    const current = scope ? allocation.omittedByScope.get(scope) : undefined;
    if (!scope || !current) continue;
    const summary = projected.get(scope) ?? { ...current };
    const represented = upgrade
      ? {
          ...emptySummary(),
          textChars: directTextChars(candidate.node.children) -
            representedTextChars(candidate.node, "identity"),
        }
      : ownSummary(candidate.node, representation);
    subtractSummary(summary, represented);
    projected.set(scope, summary);
  }
  let markerChars = state.markerChars;
  for (const [scope, summary] of projected) {
    const current = allocation.omittedByScope.get(scope)!;
    markerChars += markerCostForScope(scope, summary, state) -
      markerCostForScope(scope, current, state);
  }
  return markerChars;
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

function markerCost(
  ref: string,
  summary: SnapshotSubtreeSummary,
  depth: number,
): number {
  return hasOmittedSummary(summary)
    ? `${"\t".repeat(depth)}${renderSnapshotMarker(ref, summary)}\n`.length
    : 0;
}

function markerCostForScope(
  scope: string,
  summary: SnapshotSubtreeSummary,
  state: AllocationState,
): number {
  return markerCost(
    scope,
    summary,
    state.markerDepthByScope.get(scope) ?? 2,
  );
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

function subtractSummary(
  target: SnapshotSubtreeSummary,
  represented: SnapshotSubtreeSummary,
): void {
  for (const key of summaryKeys)
    target[key] = Math.max(0, target[key] - represented[key]);
}

function cloneSummaries(
  summaries: Map<string, SnapshotSubtreeSummary>,
): Map<string, SnapshotSubtreeSummary> {
  return new Map([...summaries].map(([scope, summary]) => [scope, { ...summary }]));
}

function hasOmittedSummary(summary: SnapshotSubtreeSummary): boolean {
  return summaryKeys.some((key) => summary[key] > 0);
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
