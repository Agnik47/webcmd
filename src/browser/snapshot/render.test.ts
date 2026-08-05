import { describe, expect, it } from "vitest";
import {
  boundSnapshotText,
  renderSnapshot,
  renderSnapshotFrames,
} from "./render.js";
import type { AiSnapshot, AiSnapshotNode } from "./types.js";

function node(
  input: Partial<AiSnapshotNode> & { role: string },
): AiSnapshotNode {
  return {
    nodeId: input.nodeId ?? input.role,
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

function snap(roots: AiSnapshotNode[]): AiSnapshot {
  return {
    title: "Snapshot Demo",
    url: "https://example.test/path",
    frames: [
      {
        status: "ok",
        scope: "document",
        id: "main",
        index: 0,
        url: "https://example.test/path",
        name: null,
        parentId: null,
        roots,
      },
    ],
  };
}

describe("renderSnapshot", () => {
  it("summarizes critical state, actions, records, and text during rendering", () => {
    const frames = renderSnapshotFrames(snap([node({
      role: "list", ref: "l10", children: [
        node({ role: "listitem", name: "Alpha", children: [
          node({ role: "button", name: "Open", ref: "l11", properties: { focused: true } }),
        ] }),
      ],
    })]), "tree");
    const list = frames[0]!.status === "ok" ? frames[0]!.roots[0]! : null;
    expect(list?.summary).toMatchObject({ actions: 1, records: 1, critical: 1 });
    expect(list?.scopeRef).toBe("l10");
  });

  it("marks repeated actionable frame roots as records with compact identities", () => {
    const frames = renderSnapshotFrames(snap([
      node({ role: "region", name: "Alpha", properties: { selected: true }, children: [node({ role: "button", name: "Edit Alpha" })] }),
      node({ role: "region", name: "Beta", properties: { selected: true }, children: [node({ role: "button", name: "Edit Beta" })] }),
      node({ role: "region", name: "Gamma", properties: { selected: true }, children: [node({ role: "button", name: "Edit Gamma" })] }),
    ]), "tree");
    const roots = frames[0]!.status === "ok" ? frames[0]!.roots : [];
    expect(roots.map((root) => root.record)).toEqual([true, true, true]);
    expect(roots[0]?.recordIdentity).toEqual({
      name: "Alpha",
      action: "Edit Alpha",
      states: [["selected", "true"]],
    });
  });

  it("renders compact action structure in act mode", () => {
    const text = renderSnapshot(
      snap([
        node({
          role: "RootWebArea",
          ref: "l1",
          children: [
            node({
              role: "main",
              ref: "l2",
              children: [
                node({
                  role: "heading",
                  name: "Welcome",
                  properties: { level: 1 },
                  ref: "l3",
                }),
                node({ role: "button", name: "Save", ref: "l4" }),
                node({
                  role: "textbox",
                  name: "Search",
                  ref: "l5",
                  properties: { value: "query" },
                  attributes: { placeholder: "Search docs" },
                }),
              ],
            }),
          ],
        }),
      ]),
      { mode: "act" },
    );

    expect(text).toContain(
      '<page title="Snapshot Demo" url="https://example.test/path">',
    );
    expect(text).toContain("# Welcome");
    expect(text).toContain('<button ref="l4">Save</button>');
    expect(text).toContain(
      '<textbox ref="l5" value="query" placeholder="Search docs">Search</textbox>',
    );
  });

  it("keeps paragraph text in tree mode but not act mode", () => {
    const page = snap([
      node({
        role: "RootWebArea",
        children: [
          node({
            role: "main",
            ref: "l1",
            children: [
              node({
                role: "paragraph",
                name: "Long useful paragraph for extraction.",
              }),
              node({ role: "button", name: "Continue", ref: "l2" }),
            ],
          }),
        ],
      }),
    ]);

    expect(renderSnapshot(page, { mode: "act" })).not.toContain(
      "Long useful paragraph",
    );
    expect(renderSnapshot(page, { mode: "tree" })).toContain(
      "Long useful paragraph",
    );
    expect(renderSnapshot(page, { mode: "tree" })).toContain(
      '<button ref="l2">Continue</button>',
    );
  });

  it("includes its truncation marker within the requested bound", () => {
    const bounded = boundSnapshotText("x".repeat(100), 40);
    expect(bounded.value.length).toBeLessThanOrEqual(40);
    expect(bounded.value).toMatch(/\n\.\.\.\[truncated, \d+ chars omitted\]$/);
    expect(bounded.truncated).toBe(true);
  });
});
