import { describe, expect, it } from "vitest";
import { boundSnapshotText, renderSnapshot } from "./render.js";
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
