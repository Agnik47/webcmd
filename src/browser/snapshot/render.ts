/*
 * Derived from libretto-browser-tools.
 * MIT License, Copyright (c) 2026 Libretto contributors.
 */

import { scopeSnapshotToRef } from "./capture.js";
import type {
  AiSnapshot,
  AiSnapshotFrame,
  AiSnapshotNode,
  BoundedSnapshotText,
  RenderedSnapshotChild,
  RenderedSnapshotFrame,
  RenderedSnapshotNode,
  SnapshotMode,
  SnapshotPrimitive,
  SnapshotTextNode,
} from "./types.js";

const MAX_CHILDREN_PER_PARENT = 4;
const MAX_LABEL_CHARS = 140;
const MAX_SUMMARY_TEXT_CHARS = 80;
const MAX_HREF_CHARS = 96;
const MAX_ACTIONS_IN_SUMMARY = 3;
const MAX_ACTION_LABEL_CHARS = 80;
const READ_MAX_SUMMARY_TEXT_CHARS = 240;
const READ_EXTRA_ROLES = new Set(["paragraph", "article", "section", "region"]);

const PRESERVE_CHILDREN_BY_ROLE = new Set([
  "document",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "form",
  "search",
  "list",
  "table",
  "tabpanel",
]);
const FLATTEN_ROLES = new Set([
  "none",
  "presentation",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);
const SKIP_ROLES = new Set(["InlineTextBox", "ListMarker"]);
const ACTION_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "menuitem",
  "tab",
  "slider",
]);
const ACTION_STATE_ATTRS = new Set([
  "checked",
  "disabled",
  "expanded",
  "pressed",
  "selected",
  "value",
  "placeholder",
]);
const TEXT_ACTION_ROLES = new Set(["button", "link", "menuitem", "tab"]);
const KEEP_ROLES = new Set([
  "document",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "form",
  "search",
  "list",
  "listitem",
  "button",
  "link",
  "image",
  "textbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "menu",
  "menuitem",
  "option",
  "tab",
  "slider",
]);
const BLOCK_FLATTEN_ROLES = new Set([
  "paragraph",
  "section",
  "article",
  "region",
  "group",
  "figure",
]);
const RENDERED_STATE_PROPERTIES = [
  "disabled",
  "checked",
  "expanded",
  "selected",
  "pressed",
  "required",
  "invalid",
  "readonly",
  "multiline",
  "autocomplete",
  "haspopup",
  "value",
];

export interface RenderSnapshotOptions {
  mode?: SnapshotMode;
  ref?: string;
  maxChars?: number;
}

export function renderSnapshot(
  snapshot: AiSnapshot,
  options: RenderSnapshotOptions = {},
): string {
  const mode = options.mode ?? "act";
  const scoped = options.ref
    ? scopeSnapshotToRef(snapshot, options.ref)
    : snapshot;
  const lines = [renderPageOpen(scoped, "")];
  for (const frame of renderSnapshotFrames(scoped, mode))
    renderFrame(frame, 1, lines);
  lines.push("</page>");
  const value = lines.join("\n");
  return Number.isFinite(options.maxChars)
    ? boundSnapshotText(value, options.maxChars!).value
    : value;
}

export function renderSnapshotFrames(
  snapshot: AiSnapshot,
  mode: SnapshotMode = "act",
): RenderedSnapshotFrame[] {
  return snapshot.frames
    .map((frame) => toRenderedFrame(frame, mode))
    .filter(hasRenderedFrameContent);
}

export function boundSnapshotText(
  value: string,
  maxChars: number,
): BoundedSnapshotText {
  const limit = Math.max(0, Math.floor(maxChars));
  if (value.length <= limit) return { value, truncated: false };
  return {
    value: `${value.slice(0, limit)}\n...[truncated, ${value.length - limit} chars omitted]`,
    truncated: true,
  };
}

function renderPageOpen(
  snapshot: Pick<AiSnapshot, "title" | "url">,
  prefix: string,
  selfClosing = false,
): string {
  return `${prefix}${formatTag(
    "page",
    [
      ["title", firstNonEmpty(snapshot.title, snapshot.url) ?? ""],
      ["url", snapshot.url],
    ],
    !selfClosing,
  )}`;
}

function renderFrameLine(
  frame: RenderedSnapshotFrame,
  depth: number,
  prefix: string,
  selfClosing: boolean,
): string {
  const attrs: Array<[string, string]> = [
    ["index", String(frame.index)],
    ["url", normalizeText(frame.url, MAX_LABEL_CHARS)],
  ];
  if (frame.name)
    attrs.push(["name", normalizeText(frame.name, MAX_LABEL_CHARS)]);
  if (frame.parentId) attrs.push(["parent", frame.parentId]);
  if (frame.status === "unavailable")
    attrs.push(["error", normalizeText(frame.error, 180)]);
  return `${prefix}${indent(depth)}${formatTag("frame", attrs, !selfClosing)}`;
}

function indent(depth: number): string {
  return "\t".repeat(depth);
}
function formatTag(
  tagName: string,
  attributes: Array<[string, string]>,
  hasChildren: boolean,
): string {
  const attrs = attributes
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return hasChildren ? `<${tagName}${attrs}>` : `<${tagName}${attrs} />`;
}

export function renderChildrenTruncationNotice(
  children: RenderedSnapshotChild[],
  mode: SnapshotMode = "act",
): string {
  const count = children.length;
  const summaryActions = actionSummariesForChildren(children);
  const textSnippet = previewForChildren(
    children,
    summaryActions.labels,
    mode === "read" ? READ_MAX_SUMMARY_TEXT_CHARS : MAX_SUMMARY_TEXT_CHARS,
  );
  const elementLabel = count === 1 ? "element" : "elements";
  const textSnippetPart = textSnippet
    ? `. Text snippet: ${JSON.stringify(textSnippet)}`
    : "";
  const interactiveText = summaryActions.actions.length
    ? `. Interactive elements: ${summaryActions.actions.map((action) => action.markup).join(", ")}${summaryActions.hasMore ? ", ..." : ""}`
    : "";
  return `[Truncated ${count} more ${elementLabel}${textSnippetPart}${interactiveText}]`;
}

function toRenderedFrame(
  frame: AiSnapshotFrame,
  mode: SnapshotMode,
): RenderedSnapshotFrame {
  if (frame.status === "unavailable") return frame;
  return {
    ...frame,
    roots: frame.roots.flatMap((root) => toRenderedNodes(root, null, mode)),
  };
}
function hasRenderedFrameContent(frame: RenderedSnapshotFrame): boolean {
  return frame.status === "unavailable" || frame.roots.length > 0;
}
function toRenderedNodes(
  node: AiSnapshotNode,
  parent: AiSnapshotNode | null,
  mode: SnapshotMode,
): RenderedSnapshotNode[] {
  return toRenderedChildren(node, parent, mode).filter(isRenderedNode);
}

function toRenderedChildren(
  node: AiSnapshotNode,
  parent: AiSnapshotNode | null,
  mode: SnapshotMode,
): RenderedSnapshotChild[] {
  if (shouldSkipNode(node, parent)) return [];
  if (isTextRole(node.role)) {
    const text = firstNonEmpty(
      node.name,
      node.description,
      primitiveToString(node.value),
    );
    return text && text !== parent?.name && text !== nodeTextValue(parent)
      ? [{ kind: "text", text }]
      : [];
  }
  const children = renderableChildren(node, mode);
  const role = tagNameForRole(node.role);
  if (role === "heading") return renderHeading(node, children);
  const compactRole = roleForNode(node, role, children);
  if (compactRole === "image" && !hasNonEmptyAttribute(node, "src")) return [];
  if (compactRole === "link" && !hasNonEmptyAttribute(node, "href"))
    return flattenedChildren(node, children, mode).filter(
      hasVisibleTextOrInteractive,
    );
  if (mode === "act" && READ_EXTRA_ROLES.has(compactRole)) {
    return children.some(hasInteractiveNode)
      ? flattenedChildren(node, children, mode).filter(
          hasVisibleTextOrInteractive,
        )
      : [];
  }
  if (
    node.ignored ||
    FLATTEN_ROLES.has(node.role) ||
    (!KEEP_ROLES.has(compactRole) &&
      !(mode === "read" && READ_EXTRA_ROLES.has(compactRole)))
  ) {
    return flattenedChildren(node, children, mode).filter(
      hasVisibleTextOrInteractive,
    );
  }
  const text = normalizedText(children);
  const suppressName = text.includes(normalizeRawText(node.name ?? ""))
    ? node.name
    : null;
  const content = nameAttributeAsContent(
    nodeAttributes(node, suppressName),
    children,
  );
  const renderedChildren = removeDuplicateNestedActions(
    compactRole,
    content.attrs,
    content.children,
  ).filter(hasVisibleTextOrInteractive);
  if (
    !ACTION_ROLES.has(compactRole) &&
    !renderedChildren.some(hasVisibleTextOrInteractive)
  )
    return [];
  return [
    {
      kind: "node",
      key:
        node.nodeId ||
        node.ref ||
        `${compactRole}:${content.attrs.map(([name, value]) => `${name}=${value}`).join(";")}`,
      role: compactRole,
      attrs: content.attrs,
      children: renderedChildren,
    },
  ];
}

function renderableChildren(
  node: AiSnapshotNode,
  mode: SnapshotMode,
): RenderedSnapshotChild[] {
  return mergeAdjacentText(
    node.children.flatMap((child) => toRenderedChildren(child, node, mode)),
  ).filter(hasVisibleTextOrInteractive);
}
function renderHeading(
  node: AiSnapshotNode,
  children: RenderedSnapshotChild[],
): RenderedSnapshotChild[] {
  const text = firstNonEmpty(node.name, normalizedText(children));
  return text
    ? [
        {
          kind: "text",
          text: `${"#".repeat(headingLevel(node))} ${text}`,
          block: true,
        },
      ]
    : [];
}
function headingLevel(node: AiSnapshotNode): number {
  const level =
    typeof node.properties.level === "number"
      ? node.properties.level
      : Number(node.properties.level);
  return Number.isFinite(level)
    ? Math.min(6, Math.max(1, Math.round(level)))
    : 2;
}
function roleForNode(
  node: AiSnapshotNode,
  role: string,
  children: RenderedSnapshotChild[],
): string {
  return isPointerButtonCandidate(node, role, children) ? "button" : role;
}
function isPointerButtonCandidate(
  node: AiSnapshotNode,
  role: string,
  children: RenderedSnapshotChild[],
): boolean {
  return (
    !KEEP_ROLES.has(role) &&
    !children.some(hasInteractiveNode) &&
    hasClickableHint(node) &&
    Boolean(firstNonEmpty(node.name, normalizedText(children)))
  );
}
function hasClickableHint(node: AiSnapshotNode): boolean {
  return (
    node.attributes.cursor === "pointer" ||
    Object.hasOwn(node.attributes, "onclick") ||
    (node.attributes.tabindex !== undefined &&
      Number(node.attributes.tabindex) >= 0)
  );
}
function hasInteractiveNode(child: RenderedSnapshotChild): boolean {
  return (
    child.kind === "node" &&
    (ACTION_ROLES.has(child.role) || child.children.some(hasInteractiveNode))
  );
}
function flattenedChildren(
  node: AiSnapshotNode,
  children: RenderedSnapshotChild[],
  mode: SnapshotMode,
): RenderedSnapshotChild[] {
  const fallbackText = fallbackTextForFlattenedNode(node);
  const flattened =
    children.length || !fallbackText
      ? children
      : [{ kind: "text" as const, text: fallbackText }];
  return BLOCK_FLATTEN_ROLES.has(tagNameForRole(node.role)) ||
    (mode === "read" && READ_EXTRA_ROLES.has(tagNameForRole(node.role)))
    ? flattened.map((child) =>
        child.kind === "text" ? { ...child, block: true } : child,
      )
    : flattened;
}
function fallbackTextForFlattenedNode(node: AiSnapshotNode): string | null {
  const name = firstNonEmpty(node.name, primitiveToString(node.value));
  return !name ||
    attributeMatchesName(node, "aria-label", name) ||
    attributeMatchesName(node, "title", name) ||
    attributeMatchesName(node, "alt", name)
    ? null
    : name;
}
function attributeMatchesName(
  node: AiSnapshotNode,
  attributeName: string,
  name: string,
): boolean {
  return normalizeRawText(node.attributes[attributeName] ?? "") === name;
}
function hasNonEmptyAttribute(
  node: AiSnapshotNode,
  attributeName: string,
): boolean {
  return normalizeRawText(node.attributes[attributeName] ?? "") !== "";
}
function removeDuplicateNestedActions(
  role: string,
  attrs: Array<[string, string]>,
  children: RenderedSnapshotChild[],
): RenderedSnapshotChild[] {
  const label = ACTION_ROLES.has(role)
    ? firstNonEmpty(attrFromAttrs(attrs, "name"), normalizedText(children))
    : null;
  return !label
    ? children
    : children.flatMap((child) => {
        if (child.kind === "text" || !ACTION_ROLES.has(child.role))
          return [child];
        const childLabel = firstNonEmpty(
          attrValue(child, "name"),
          singleTextChild(child),
          normalizedText(child.children),
        );
        return childLabel === label ? child.children : [child];
      });
}
function nameAttributeAsContent(
  attrs: Array<[string, string]>,
  children: RenderedSnapshotChild[],
): { attrs: Array<[string, string]>; children: RenderedSnapshotChild[] } {
  const name = attrFromAttrs(attrs, "name");
  if (!name) return { attrs, children };
  const attrsWithoutName = attrs.filter(([attr]) => attr !== "name");
  return normalizedText(children).includes(normalizeRawText(name))
    ? { attrs: attrsWithoutName, children }
    : {
        attrs: attrsWithoutName,
        children: [{ kind: "text", text: name }, ...children],
      };
}

export function renderFrame(
  frame: RenderedSnapshotFrame,
  depth: number,
  lines: string[],
  prefix = "",
): void {
  if (frame.status === "unavailable") {
    lines.push(renderFrameLine(frame, depth, prefix, true));
    return;
  }
  lines.push(renderFrameLine(frame, depth, prefix, false));
  for (const root of frame.roots) renderNode(root, depth + 1, lines, prefix);
  lines.push(`${prefix}${indent(depth)}</frame>`);
}
export function renderNode(
  node: RenderedSnapshotNode,
  depth: number,
  lines: string[],
  prefix = "",
): void {
  if (renderFoldedSingleChildChain(node, depth, lines, prefix)) return;
  if (!node.children.length) {
    lines.push(
      `${prefix}${indent(depth)}${formatTag(node.role, node.attrs, false)}`,
    );
    return;
  }
  const singleText = singleTextChild(node);
  if (singleText !== null) {
    if (shouldRenderBareText(node)) {
      lines.push(`${prefix}${indent(depth)}${escapeText(singleText)}`);
      return;
    }
    lines.push(
      `${prefix}${indent(depth)}${formatTag(node.role, node.attrs, true)}${escapeText(singleText)}</${node.role}>`,
    );
    return;
  }
  lines.push(
    `${prefix}${indent(depth)}${formatTag(node.role, node.attrs, true)}`,
  );
  renderChildren(node.children, depth + 1, lines, prefix);
  lines.push(`${prefix}${indent(depth)}</${node.role}>`);
}
function renderChildren(
  children: RenderedSnapshotChild[],
  depth: number,
  lines: string[],
  prefix: string,
): void {
  for (const child of children.slice(0, MAX_CHILDREN_PER_PARENT))
    child.kind === "text"
      ? lines.push(`${prefix}${indent(depth)}${escapeText(child.text)}`)
      : renderNode(child, depth, lines, prefix);
  if (children.length > MAX_CHILDREN_PER_PARENT)
    lines.push(
      `${prefix}${indent(depth)}${renderChildrenTruncationNotice(children.slice(MAX_CHILDREN_PER_PARENT))}`,
    );
}
function renderFoldedSingleChildChain(
  node: RenderedSnapshotNode,
  depth: number,
  lines: string[],
  prefix: string,
): boolean {
  const chain = singleChildChain(node);
  if (chain.length <= 1) return false;
  const keptIndexes = chain
    .map((chainNode, index) => ({ chainNode, index }))
    .filter(({ chainNode, index }) => index === 0 || chainNode.role === "list")
    .map(({ index }) => index);
  if (keptIndexes.length === chain.length) return false;
  renderFoldedChainNode(chain, keptIndexes, 0, depth, lines, prefix);
  return true;
}
function renderFoldedChainNode(
  chain: RenderedSnapshotNode[],
  keptIndexes: number[],
  keptIndexPosition: number,
  depth: number,
  lines: string[],
  prefix: string,
): void {
  const currentIndex = keptIndexes[keptIndexPosition]!;
  const current = chain[currentIndex]!;
  lines.push(
    `${prefix}${indent(depth)}${formatTag(current.role, current.attrs, true)}`,
  );
  for (const child of current.children)
    if (child.kind === "text")
      lines.push(`${prefix}${indent(depth + 1)}${escapeText(child.text)}`);
  const nextKeptIndex = keptIndexes[keptIndexPosition + 1];
  if (nextKeptIndex !== undefined) {
    if (nextKeptIndex > currentIndex + 1)
      lines.push(`${prefix}${indent(depth + 1)}...`);
    renderFoldedChainNode(
      chain,
      keptIndexes,
      keptIndexPosition + 1,
      depth + 1,
      lines,
      prefix,
    );
  } else {
    const terminal = chain[chain.length - 1]!;
    if (chain.length - 1 > currentIndex)
      lines.push(`${prefix}${indent(depth + 1)}...`);
    renderChildren(terminal.children, depth + 1, lines, prefix);
  }
  lines.push(`${prefix}${indent(depth)}</${current.role}>`);
}
function singleChildChain(node: RenderedSnapshotNode): RenderedSnapshotNode[] {
  const chain = [node];
  let current = node;
  while (isDeprioritizedSingleChildParent(current)) {
    const child = singleElementChild(current);
    if (!child || ACTION_ROLES.has(child.role)) break;
    chain.push(child);
    current = child;
  }
  return chain;
}
function isDeprioritizedSingleChildParent(node: RenderedSnapshotNode): boolean {
  return (
    node.role !== "document" &&
    !ACTION_ROLES.has(node.role) &&
    singleElementChild(node) !== null
  );
}
function singleElementChild(
  node: RenderedSnapshotNode,
): RenderedSnapshotNode | null {
  let result: RenderedSnapshotNode | null = null;
  for (const child of node.children)
    if (child.kind === "node") {
      if (result) return null;
      result = child;
    }
  return result;
}
function shouldRenderBareText(node: RenderedSnapshotNode): boolean {
  return (
    !ACTION_ROLES.has(node.role) &&
    !attrValue(node, "ref") &&
    !PRESERVE_CHILDREN_BY_ROLE.has(node.role)
  );
}
function nodeAttributes(
  node: AiSnapshotNode,
  suppressName: string | null,
): Array<[string, string]> {
  const attributes: Array<[string, string]> = [];
  const usedNames = new Set<string>();
  const push = (name: string, value: SnapshotPrimitive | undefined): void => {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      value === false ||
      value === "false"
    )
      return;
    const normalizedName = uniqueAttributeName(
      sanitizeAttributeName(name),
      usedNames,
    );
    attributes.push([
      normalizedName,
      normalizeAttributeValue(normalizedName, value),
    ]);
    usedNames.add(normalizedName);
  };
  push("ref", node.ref);
  if (node.name !== suppressName) push("name", node.name);
  const hasStateValue =
    node.properties.value !== undefined &&
    node.properties.value !== null &&
    node.properties.value !== "";
  for (const name of RENDERED_STATE_PROPERTIES) {
    const value = node.properties[name];
    if (value === true) push(name, "true");
    else push(name, value);
  }
  if (!hasStateValue) push("value", node.value);
  push("href", node.attributes.href);
  push("placeholder", node.attributes.placeholder);
  return attributes;
}
function normalizeAttributeValue(
  name: string,
  value: SnapshotPrimitive,
): string {
  const normalized = normalizeRawText(String(value));
  return name === "href" ? truncate(normalized, MAX_HREF_CHARS) : normalized;
}
function singleTextChild(node: RenderedSnapshotNode): string | null {
  return node.children.length === 1 &&
    node.children[0]!.kind === "text" &&
    !node.children[0]!.block
    ? node.children[0]!.text
    : null;
}
function mergeAdjacentText(
  children: RenderedSnapshotChild[],
): RenderedSnapshotChild[] {
  const result: RenderedSnapshotChild[] = [];
  for (const child of children) {
    const previous = result.at(-1);
    if (
      child.kind === "text" &&
      previous?.kind === "text" &&
      !child.block &&
      !previous.block
    )
      previous.text = normalizeRawText(`${previous.text} ${child.text}`);
    else result.push(child);
  }
  return result;
}
function normalizedText(children: RenderedSnapshotChild[]): string {
  return children
    .map((child) =>
      child.kind === "text" ? child.text : normalizedText(child.children),
    )
    .join(" ");
}
function previewForChildren(
  children: RenderedSnapshotChild[],
  excludedText: Set<string>,
  maxChars: number,
): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  const pushLabel = (value: string | null): void => {
    const normalized = normalizeRawText(value ?? "");
    if (
      !normalized ||
      normalized === "no visible text" ||
      seen.has(normalized) ||
      excludedText.has(normalized)
    )
      return;
    seen.add(normalized);
    labels.push(normalized);
  };
  const visit = (
    child: RenderedSnapshotChild,
    insideInteractive: boolean,
  ): void => {
    if (child.kind === "text") {
      if (!insideInteractive) pushLabel(child.text);
      return;
    }
    const nextInsideInteractive =
      insideInteractive || ACTION_ROLES.has(child.role);
    if (labels.join(" · ").length > maxChars) return;
    for (const grandchild of child.children)
      visit(grandchild, nextInsideInteractive);
  };
  for (const child of children) visit(child, false);
  const preview = labels.join(" · ");
  return preview ? truncate(preview, maxChars) : "";
}
function actionSummariesForChildren(children: RenderedSnapshotChild[]): {
  actions: Array<{ markup: string; label: string | null }>;
  labels: Set<string>;
  hasMore: boolean;
} {
  const actions: Array<{ markup: string; label: string | null }> = [];
  const labels = new Set<string>();
  const seenRefs = new Set<string>();
  let hasMore = false;
  const visit = (child: RenderedSnapshotChild): void => {
    if (child.kind === "text") return;
    const ref = attrValue(child, "ref");
    if (ref && ACTION_ROLES.has(child.role) && !seenRefs.has(ref)) {
      seenRefs.add(ref);
      const label = actionLabel(child);
      if (label) labels.add(label);
      if (actions.length < MAX_ACTIONS_IN_SUMMARY)
        actions.push({ markup: renderActionSummary(child, ref), label });
      else hasMore = true;
    }
    for (const grandchild of child.children) visit(grandchild);
  };
  for (const child of children) visit(child);
  return { actions, labels, hasMore };
}
function renderActionSummary(node: RenderedSnapshotNode, ref: string): string {
  const label = actionLabel(node);
  const attrs: Array<[string, string]> = [["ref", ref]];
  for (const [name, value] of node.attrs)
    if (name !== "ref" && ACTION_STATE_ATTRS.has(name))
      attrs.push([name, normalizeText(value, MAX_ACTION_LABEL_CHARS)]);
  if (!label || !TEXT_ACTION_ROLES.has(node.role)) {
    const name = attrValue(node, "name");
    if (name) attrs.push(["name", normalizeText(name, MAX_ACTION_LABEL_CHARS)]);
    return formatTag(node.role, attrs, false);
  }
  return `${formatTag(node.role, attrs, true)}${escapeText(normalizeText(label, MAX_ACTION_LABEL_CHARS))}</${node.role}>`;
}
function actionLabel(node: RenderedSnapshotNode): string | null {
  return firstNonEmpty(
    singleTextChild(node),
    attrValue(node, "name"),
    attrValue(node, "value"),
    attrValue(node, "placeholder"),
  );
}
function attrValue(node: RenderedSnapshotNode, name: string): string | null {
  return node.attrs.find(([attr]) => attr === name)?.[1] ?? null;
}
function attrFromAttrs(
  attrs: Array<[string, string]>,
  name: string,
): string | null {
  return attrs.find(([attr]) => attr === name)?.[1] ?? null;
}
function shouldSkipNode(
  node: AiSnapshotNode,
  parent: AiSnapshotNode | null,
): boolean {
  return (
    SKIP_ROLES.has(node.role) ||
    (node.role === "StaticText" &&
      Boolean(parent?.name && node.name && parent.name === node.name))
  );
}
function isTextRole(role: string): boolean {
  return role === "StaticText" || role === "InlineTextBox";
}
function isRenderedNode(
  child: RenderedSnapshotChild,
): child is RenderedSnapshotNode {
  return child.kind === "node";
}
function hasVisibleTextOrInteractive(child: RenderedSnapshotChild): boolean {
  return child.kind === "text"
    ? normalizeRawText(child.text) !== ""
    : ACTION_ROLES.has(child.role) ||
        child.children.some(hasVisibleTextOrInteractive);
}
function tagNameForRole(role: string): string {
  const normalized = normalizeRole(role).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return /^[a-zA-Z_:]/.test(normalized) ? normalized : "node";
}
function normalizeRole(role: string): string {
  return role === "RootWebArea"
    ? "document"
    : role === "textField"
      ? "textbox"
      : role || "node";
}
function primitiveToString(value: SnapshotPrimitive): string | null {
  return value === null ? null : String(value);
}
function nodeTextValue(node: AiSnapshotNode | null): string | null {
  if (!node) return null;
  const value = primitiveToString(node.properties.value ?? node.value);
  return value ? normalizeRawText(value) : null;
}
function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = normalizeRawText(value ?? "");
    if (normalized) return truncate(normalized, MAX_LABEL_CHARS);
  }
  return null;
}
function normalizeText(value: string, maxChars: number): string {
  return truncate(value.replace(/\s+/g, " ").trim(), maxChars);
}
function normalizeRawText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}
function uniqueAttributeName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) return name;
  let index = 2;
  while (usedNames.has(`${name}-${index}`)) index += 1;
  return `${name}-${index}`;
}
function sanitizeAttributeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `attr-${sanitized}`;
}
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
