---
name: smart-search
description: Use when a request needs Webcmd search-command discovery, marketplace inspection, source research, or evidence fetching.
---

# Smart Search

Use live command metadata and live help. Do not infer command arguments from this skill, maintain a routing table, or claim a source was searched when it was not.

## Trust boundary

Use only installed commands, their reported output, and fetched primary content as evidence. Preserve source URLs and report failures. Do not add marketplaces automatically: adding a marketplace is a user trust decision.

## Direct URL

For a supplied HTTP(S) URL, fetch it first:

```bash
webcmd web fetch --url <url>
```

Only when the structured error code is `FETCH_BLOCKED` or `FETCH_REQUIRES_BROWSER`, use:

```bash
webcmd web fetch-browser --url <url>
```

Do not escalate on message prose and do not make `web fetch` launch a browser.

## Discover installed commands

Start every search request with:

```bash
webcmd list --tag search -f json
```

Shortlist up to five candidate commands from site, name, description, keywords, strategy, browser requirement, and output columns. Prefer the named site, then a comparably relevant installed command. Read live help before execution:

```bash
webcmd <site> <command> -h
```

## Marketplace install-to-inspect

When no installed command covers a named site or specialized capability, run:

```bash
webcmd plugin search <site-or-capability> -f json
```

Install promising plugins sequentially, at most three plugins per user request:

```bash
webcmd plugin install <source>
webcmd list --tag search -f json
```

Inspect the newly visible command help. Stop once a suitable command appears. If hosted marketplace installation is unavailable, state that gap and use installed commands.

## Search and fetch evidence

Run one primary search command. Run a second only if the first is weak, empty, fails, or an independent source materially corroborates it. Normalize useful result URLs and fetch up to three URLs by default (five for a broad comparison):

```bash
webcmd web fetch --url <url>
```

Use up to two browser fetches by default, only for the two stable fetch error codes above. Cite or link the source URL with substantive claims.

## Operational budgets

- At most three plugin installs per user request.
- Up to five candidate commands before choosing.
- One search by default; a second only for weakness or corroboration.
- Three URLs by default; five only for broad comparison.
- Two browser fetches by default.

## Search Summary

Append this to the response:

```md
Search Summary
- Commands: <executed commands>
- Sources fetched: <URLs>
- Browser fallback: <URLs or none>
- Gaps/failures: <none or details>
```
