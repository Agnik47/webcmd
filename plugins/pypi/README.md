# webcmd-plugin-pypi

Inspect public Python package metadata and releases from PyPI. No login or API
key is required.

## Install

```bash
webcmd plugin install github:agentrhq/webcmd/plugins/pypi
```

## Commands

| Command | Description |
| --- | --- |
| `webcmd pypi package <name>` | Show current project metadata for a package |
| `webcmd pypi releases <name>` | List recent release files for a package |

## Examples

```bash
webcmd pypi package django
webcmd pypi releases pictovap --limit 5
```

Use this plugin when an agent needs deterministic package metadata before
installing, upgrading, or comparing Python tools.
