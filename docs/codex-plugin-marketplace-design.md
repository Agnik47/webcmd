# Codex Plugin Marketplace Design

## Goal

Make `agentrhq/webcmd` directly addable as a Codex plugin marketplace and make
Webcmd installable from that marketplace without duplicating the seven bundled
skills.

The intended Codex setup is:

```text
npm install -g @agentrhq/webcmd
Add marketplace: agentrhq/webcmd
Install Webcmd from Plugins
Start a new task
```

Codex plugin installation replaces `webcmd skills add` for Codex users. The
existing skills command remains the installation path for Claude, other agent
harnesses, and Codex users who do not use plugins.

## Repository Layout

The repository root is the plugin root:

```text
webcmd/
├── .agents/plugins/marketplace.json
├── .codex-plugin/plugin.json
├── skills/
├── package.json
└── README.md
```

This keeps `skills/` as the only source of truth. A nested plugin directory or
separate marketplace repository would require copied skills or release-time
packaging and is unnecessary for one plugin.

The existing `plugins/` directory remains exclusively for Webcmd community
site adapters.

## Plugin Manifest

`.codex-plugin/plugin.json` defines one skills-only plugin named `webcmd`.
It references `./skills/`, uses the same version as `package.json`, and includes
Webcmd's existing publisher, repository, website, license, category, starter
prompts, and interface metadata.

The plugin does not add an MCP server, hooks, apps, or an npm installer. Its
skills invoke the separately installed `webcmd` executable and should preserve
their existing missing-command guidance.

## Marketplace

`.agents/plugins/marketplace.json` defines one marketplace named `webcmd` and
one available plugin named `webcmd`. The entry points to `./`, the root of the
marketplace's checked-out repository snapshot.

Users can configure the marketplace with either the GitHub repository URL or
the `agentrhq/webcmd` shorthand. After configuration, Webcmd appears in that
marketplace's Plugins view and can be installed as a single bundle.

The repository currently ignores `.agents/`. The change will keep that default
while narrowly allowing only `.agents/plugins/marketplace.json`.

## Versioning

The plugin version follows the npm package version. Release Please updates both
JSON files in the same release so a Webcmd release cannot silently leave the
plugin cache on an older version.

A small repository check verifies:

- the plugin name and skills path;
- plugin and npm versions match;
- the marketplace exposes the expected Webcmd plugin;
- the marketplace source is the Webcmd repository root on `main`;
- all seven bundled skill manifests remain present.

## Documentation

The README and Webcmd documentation present two skill-delivery paths:

- Codex: install the npm runtime, add the marketplace, and install the plugin;
- other harnesses or plugin-free Codex: install the npm runtime and run
  `webcmd skills add`.

The docs warn Codex users not to install the same skills through both paths.

## Verification

The implementation will be checked with:

1. the plugin-creator validator;
2. the repository check added for manifest and marketplace drift;
3. an isolated Codex marketplace/install smoke test;
4. targeted skills and CLI tests;
5. typecheck, build, package inspection, and the full test suite.

## Public Submission

The same repository-root plugin is the artifact submitted through OpenAI's
plugin submission portal. The public listing uses AgentRHQ as publisher and
Webcmd's existing website and repository metadata.

The portal submission is separate from the Git marketplace. Approval and
publication make Webcmd searchable in the shared public ChatGPT and Codex
plugin directory without adding a repository marketplace.

OpenAI requires publisher verification and privacy-policy information during
submission. Webcmd currently has no discoverable privacy-policy URL. The code
and listing metadata can be made submission-ready in this pull request, but a
verified AgentRHQ publisher session and an approved privacy-policy URL are
external prerequisites for completing portal submission.

## Non-goals

- Installing the npm CLI from plugin lifecycle hooks.
- Adding Webcmd-specific MCP or app integrations.
- Moving or copying the bundled skills.
- Changing Webcmd community adapter packaging.
- Removing `webcmd skills add`.
