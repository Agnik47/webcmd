---
name: smart-search
description: Use when a request needs search, research, source discovery, direct URL fetch, evidence fetching, or search-capable Webcmd adapter discovery.
---

# Smart Search

This is Webcmd's one-stop workflow for search + fetch. Use it for any request that asks to search, research, find sources, look something up, fetch/read a URL, compare sources, or gather evidence.

Use live command metadata and live help. Do not infer command arguments from this skill, maintain a routing table, or claim a source was searched when it was not.

Do not use this skill for plugin inventory, plugin management, or listing available extensions. Marketplace commands appear here only to find and install search-capable adapters needed for the current search/fetch task.

## Trust boundary

Use only installed commands, their reported output, and fetched primary content as evidence. Preserve source URLs and report failures. Do not add marketplaces automatically: adding a marketplace is a user trust decision.

Prefer primary sources, official docs, and direct content over search snippets. Treat snippets, previews, and result titles as discovery, not evidence.

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

If direct fetch is rate-limited, blocked, CAPTCHA-gated, login-gated, geo-gated, or returns unusable extracted text, report that state. Only browser-escalate for `FETCH_BLOCKED` or `FETCH_REQUIRES_BROWSER`.

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

Do not add custom marketplaces in this workflow. In hosted mode, only verified hosted marketplace adapters are installable.

## Search and fetch evidence

Run one primary search command. Run a second only if the first is weak, empty, fails, or an independent source materially corroborates it. Normalize useful result URLs and fetch up to three URLs by default (five for a broad comparison):

```bash
webcmd web fetch --url <url>
```

Use up to two browser fetches by default, only for the two stable fetch error codes above. Cite or link the source URL with substantive claims.

If a command returns a rate-limit, auth, CAPTCHA, bot-detection, or quota error, do not loop. Switch once to another relevant search command/source if available; otherwise report the blocker.

## Operational budgets

- At most three plugin installs per user request.
- Up to five candidate commands before choosing.
- One search by default; a second only for weakness or corroboration.
- Three URLs by default; five only for broad comparison.
- Two browser fetches by default.
- Do not retry the same blocked command more than once.

## Search Summary

Append this to the response:

```md
Search Summary
- Commands: <executed commands>
- Sources fetched: <URLs>
- Browser fallback: <URLs or none>
- Gaps/failures: <none or details>
```
