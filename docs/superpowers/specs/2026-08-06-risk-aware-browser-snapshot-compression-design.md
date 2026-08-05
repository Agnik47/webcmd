# Risk-Aware Browser Snapshot Compression Design

**Status:** Approved

**Date:** 2026-08-06

## Goal

Increase completed browser tasks under a fixed total agent-token budget without increasing median default `act` snapshot tokens above Libretto. Webcmd will replace positional four-child pruning with deterministic priority preservation, global budget allocation, compact omission metadata, and targeted recovery.

The primary metric is task completion under an identical total token budget. Snapshot size and latency are hard guardrails.

## Context

Webcmd now has three explicit snapshot modes:

- `act` returns actionable controls and compact navigation/form structure;
- `tree` returns a fuller accessibility tree with readable structural roles;
- `read` extracts article/content text and converts it to Markdown.

`browser run --snapshot-mode` accepts only `act|tree`. `browser snapshot --snapshot-mode` accepts `act|tree|read`. Automatic run diffs remain structural, and `read` is intentionally not diffable.

The current Libretto-derived renderer constructs the complete rendered tree and then retains only the first four children under every parent. It replaces the rest with an 80-character text preview and up to three action previews. This is compact but positionally biased: navigation or the first few records can hide later search results, products, alerts, or changed state. Rendering a scoped ref applies the same child cap again, so the explicit recovery path can repeat the original loss.

Hosted `act` currently delegates to Browser Use's interactive-only AX serialization, while local `act` uses Webcmd's renderer. This prevents Webcmd from applying one compression policy consistently and can discard information before hosted risk analysis is possible.

## Non-Goals

- No LLM, embedding, classifier, or model call in snapshot rendering.
- No site-specific, language-specific, or e-commerce regex pruning.
- No task-context or `--focus` option in the first implementation.
- No automatic `act` to `read` mode switch.
- No additional browser round trip for automatic expansion.
- No changes to the deterministic adapter command surface.
- No `read` snapshot diffing.

## Design Decisions

### 1. Capture complete structure before compression

`act` and `tree` begin from the same normalized full accessibility snapshot. Compression happens after capture. This lets the renderer account for omitted actions, records, state, and text instead of accepting an already-destructive interactive-only serialization.

`read` remains a separate content-extraction path and does not enter the structural renderer.

### 2. Extend the existing render traversal

The current renderer already visits every captured node before applying the four-child output cap. It will calculate subtree metadata during that traversal rather than adding a second independent tree walk.

Each rendered structural node carries an internal summary:

```ts
interface SnapshotSubtreeSummary {
  nodes: number;
  actions: number;
  records: number;
  textChars: number;
  changed: number;
  critical: number;
}
```

The summary is internal. Only omitted, nonzero counts appear in agent output.

`critical` includes focused or invalid controls and alert, alertdialog, dialog, or status nodes. During before/after rendering, state modifications and added or removed critical nodes also count as critical. `changed` is populated only when diff context exists.

### 3. Use deterministic priority tiers

Candidates are assigned to five stable buckets. No global sort or heap is required.

1. **P0: critical and changed state** — focused or invalid controls, alerts, dialogs, status, and nodes changed by the current run, plus the ancestor context required to understand them.
2. **P1: actionable identity** — buttons, inputs, selected options, primary links, control labels, and actionable state such as checked, selected, expanded, disabled, pressed, and value.
3. **P2: repeated-record identity** — one compact identity for each semantic record before verbose details are added to any record.
4. **P3: supporting information** — secondary actions, headings, short descriptive text, and other structural detail.
5. **P4: low-signal structure** — duplicate navigation, unnamed wrappers, decorative content, and unchanged chrome.

DOM order breaks ties within a bucket.

A semantic record is a listitem, row, treeitem, or article under a list, table, grid, tree, or feed. A sibling group is also treated as repeated records when at least three siblings share the same role and each contains an actionable descendant. Record identity consists of the record's accessible name, its first labeled actionable descendant, and compact state attributes. It does not use content keywords.

### 4. Replace per-parent caps with one global output budget

The renderer removes `MAX_CHILDREN_PER_PARENT`. It uses one hard character ceiling for the complete output, including the page/frame envelope and omission markers.

When the user supplies `--max-output`, that value is the ceiling. When omitted, the default `act` ceiling is calibrated from the competitor benchmark corpus before merge: choose the largest character ceiling for which Webcmd's measured median and P95 snapshot-token counts do not exceed Libretto's corresponding measurements. The selected constant and benchmark evidence are committed with the implementation. `tree` retains a separate larger bounded default. `read` keeps its existing bounding behavior.

The renderer reserves marker space before allocating optional content. It emits candidates in priority order while preserving required ancestor context. P2 allocation is round-robin across repeated containers and their records, so breadth is represented before record detail. Candidates that do not fit are condensed to their identity representation when possible; otherwise their summary contributes to the nearest omission marker.

The absolute ceiling always wins. P0 nodes are rendered in their smallest state-preserving form first. If even all compact P0 identities cannot fit, the output includes `criticalOmitted`, sets the truncation limit, and returns a warning. Critical information is never discarded silently.

### 5. Expand high-risk content inside the same render pass

Automatic expansion means spending unused output budget on omitted candidates, not issuing another capture request.

The renderer first emits the compact structural skeleton and P0 state. It then consumes the remaining budget from P1 through P4. A repeated container receives one compact identity per record before any record receives secondary details. A subtree containing changed or critical state is expanded ahead of unchanged navigation or prose.

This preserves the existing single-snapshot latency model while allocating the same output allowance to more useful information.

### 6. Make omission explicit and recoverable

Omitted content produces one compact marker at the nearest structural scope ref:

```text
[more ref=l12 nodes=390 actions=87 records=280 changed=2]
```

Only nonzero fields are emitted. If critical identities could not fit:

```text
[more ref=l12 criticalOmitted=3 actions=87 records=280]
```

Every structural container that can own an omission marker receives a snapshot-scope ref during capture. Scope refs are not treated as actionable refs. The marker is included inside the hard output ceiling.

The response continues using the existing `warnings` and `limits` fields. Any omission sets `limits.snapshotTruncated = true`. A nonzero `criticalOmitted` also appends a warning explaining that the caller should inspect the marker's ref.

### 7. Make scoped tree inspection a real recovery path

The existing command remains the explicit fallback:

```bash
webcmd browser <session> snapshot \
  --snapshot-mode tree \
  --ref l12 \
  --max-output 12000
```

A scoped render uses its entire requested global budget and does not reapply a per-parent child cap. If the target subtree still exceeds the ceiling, it emits another structured omission marker.

If a recaptured page no longer contains the requested ref, Webcmd returns the existing ref-not-found error with guidance to capture a fresh `act` or `tree` snapshot. It does not guess another target.

## Mode Behavior

### `act`

- Full AX capture followed by deterministic priority rendering.
- P0/P1 state and actions precede supporting text.
- Repeated records receive breadth-first compact identities.
- Omitted content receives structured markers.

### `tree`

- Full AX capture with the fuller existing structural role set.
- Uses a larger global budget but the same critical-state priority, record breadth, and omission-marker contract.
- Scoped `tree --ref` is the structural recovery mechanism.

### `read`

- Continues to use `extractArticle(...)` and `articleHtmlToMarkdown(...)` locally.
- Cloud switches from its minimal DOM extractor to the released OpenCLI extractor when the package dependency is bumped.
- Does not participate in structural scoring or diffs.

### Automatic run diffs

- Before and after snapshots remain structural and accept only `act|tree`.
- Added, removed, or modified nodes and their required ancestors receive P0 priority.
- Unchanged context is the first content removed when the diff approaches its budget.
- `--no-snapshot-diff` remains unchanged.

## Hosted and Local Parity

OpenCLI is the source of truth for normalized AX capture, rendering, omission summaries, and diff behavior. The release that exposes the full `read` extractor to cloud also exposes the pure browser snapshot capture/render surface needed by `webcmd-cloud`.

After publishing that release, cloud bumps its pinned `@agentrhq/webcmd` dependency once and reuses both capabilities. Hosted `act` no longer asks Browser Use to discard noninteractive AX nodes before Webcmd rendering. Browser Use continues to provide browser infrastructure, proxying, streaming, and CDP connectivity; Webcmd owns the agent-facing snapshot policy.

The OpenCLI-compatible hosted response remains:

- `ok`;
- `tree`;
- `page`;
- `warnings`;
- `limits`;
- optional `article` for `read`.

The legacy internal cloud `args.source: "ax" | "dom"` response remains unchanged. Only calls using the public `snapshotMode` contract enter the shared renderer.

## Performance

The renderer remains linear in captured nodes plus emitted output. Five fixed priority buckets avoid `O(n log n)` sorting. Record sibling checks use one local set per repeated container and do not union descendant sets.

Synthetic measurements of the current renderer on the development machine were:

| AX nodes | Median render | P95 render |
| ---: | ---: | ---: |
| 1,000 | 1.7 ms | 2.6 ms |
| 10,000 | 17.0 ms | 20.3 ms |
| 50,000 | 92.0 ms | 125.0 ms |

A standalone metadata traversal measured 0.03 ms median at 1,000 nodes, 0.4 ms at 10,000 nodes, and 2.8 ms at 50,000 nodes. The implementation folds those counters into the existing render traversal.

The main hosted latency risk is obtaining full AX structure instead of accepting Browser Use's interactive-only string. Capture latency is measured separately from render latency.

Performance acceptance gates:

- total render P95 below 30 ms for the 10,000-node synthetic fixture;
- incremental prioritization P95 below 5 ms for that fixture;
- no additional browser round trip for automatic expansion;
- no more than 10% P95 regression in end-to-end snapshot latency on the live benchmark corpus.

## Token and Quality Acceptance Gates

All competitors run with the same model, task set, authentication state, and total agent-token allowance.

- Median default `act` snapshot tokens do not exceed Libretto.
- P95 default `act` snapshot size is hard-capped.
- Webcmd improves completed tasks under the identical total token budget.
- Webcmd improves or matches tokens per successful task.
- P0 state recall is 100% unless `criticalOmitted` is explicitly reported.
- Action and answer-evidence recall are measured against an evaluation-only normalized full AX capture taken before rendering and output bounding.
- `tree` and `read` output are excluded from default snapshot-size comparisons unless the agent invokes them.
- Median automatic-diff tokens do not exceed 50% of the median corresponding full `act` snapshot tokens on the benchmark corpus.

The implementation is rejected if it only reduces snapshot size while lowering task completion.

## Testing

### Unit tests

- critical state displaces unchanged low-priority nodes under a tight budget;
- changed diff nodes and required ancestors are retained;
- repeated records are represented breadth-first rather than first-child-first;
- output never exceeds the requested ceiling;
- omission markers contain only nonzero counts and a recoverable scope ref;
- `criticalOmitted` sets both the limit and warning;
- scoped tree rendering does not apply a per-parent child cap;
- `read` remains outside structural rendering and diffing.

### Parity tests

- the same normalized fixture produces identical local and hosted `act`/`tree` output;
- hosted public `snapshotMode` uses the shared renderer;
- hosted legacy `args.source` keeps its current response shape;
- cloud `read` matches OpenCLI after the dependency bump.

### Benchmark tests

- public pages with deep navigation, long result lists, product grids, forms, alerts, iframes, and article content;
- current Webcmd, risk-aware Webcmd, Libretto, dev-browser, BareBrowse, and ego-lite where its public interface permits measurement;
- task completion, total tokens, tokens per success, snapshot calls, latency, action recall, and answer-evidence recall;
- identical-model repeated runs with medians and P95 values recorded as release evidence.

## Rollout

1. Add the benchmark fixtures and baseline results before changing the renderer.
2. Implement the shared summary, priority buckets, global budget, markers, and scoped recovery in OpenCLI.
3. Calibrate the default budgets against the accepted competitor gates.
4. Publish OpenCLI with the shared snapshot and article-extraction exports.
5. Bump cloud once, replace interactive-only public snapshot rendering, and remove the temporary minimal `read` extractor.
6. Run local/cloud parity, performance, and fixed-token task benchmarks.
7. Replace the positional renderer only if every acceptance gate passes; otherwise retain the current renderer and keep the benchmark evidence.

No permanent runtime feature flag or second compression implementation is introduced.
