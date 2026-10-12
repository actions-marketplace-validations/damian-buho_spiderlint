<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

# Spiderlint Site Audit — GitHub Action

Crawl a site and lint its SEO tags, security headers, TLS and links — directly from a GitHub Actions workflow.

This action is a thin composite wrapper around the
[`ghcr.io/damian-buho/spiderlint`](https://github.com/damian-buho/spiderlint/pkgs/container/spiderlint)
image. It crawls the seed URLs once into a store, renders the human
report into the run summary, optionally uploads SARIF to code scanning,
and gates the job on a configurable severity threshold. The store is kept
in the Actions cache, so an unchanged site is re-audited with `304`s.

## Quick start

```yaml
name: Site audit
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'

permissions:
  contents: read

jobs:
  spiderlint:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@v6
      - uses: damian-buho/spiderlint@0.143.0
        with:
          urls: https://example.com/
```

## Version pinning

| Ref        | Selects       | Recommended for |
| ---------- | ------------- | --------------- |
| `@0.143.0` | Exact release | All consumers   |
| `@main`    | Bleeding edge | Not recommended |

Pin an exact tag for reproducible runs: the action then pulls the image of
the same tag, unless `version` or `image` says otherwise.

## Inputs

| Name           | Default   | Description                                                                                            |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `urls`         | *(empty)* | Newline-separated seed URLs. Empty takes the targets from the config file.                             |
| `config_file`  | *(empty)* | Projectfile or plain YAML carrying the `org.spiderlint` subtree, relative to the workspace.            |
| `site`         | *(empty)* | One `org.spiderlint.sites` name to audit; a config declaring several needs one step per site.          |
| `rules`        | *(empty)* | Comma-separated rulesets replacing every group’s rules (e.g. `recommended,axe`).                       |
| `args`         | *(empty)* | More `audit` flags, one per line with its value after a space (e.g. `--max-pages 200`).                |
| `fail_on`      | `error`   | Severity that fails the job: `error`, `warning`, `info` or `never`.                                    |
| `upload_sarif` | `false`   | Upload the SARIF report to code scanning; needs the `security-events: write` permission.               |
| `cache`        | `true`    | Keep the crawl store in the Actions cache, so an unchanged site is re-audited with `304`s.             |
| `version`      | *(empty)* | Image tag to pull (e.g. `latest`, `1.2.3`). Empty follows the action’s own version tag, else `latest`. |
| `image`        | *(empty)* | Full image reference. Takes precedence over `version`.                                                 |

## Outputs

| Name          | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `exit_code`   | spiderlint’s exit code: `0` clean, `1` findings at or above `fail_on`. |
| `report_json` | Path on the runner to the JSON report.                                 |
| `sarif_path`  | Path on the runner to the SARIF report.                                |

## Common recipes

### Audit the sites a projectfile declares

```yaml
# projectfile.yaml
org:
  spiderlint:
    sites:
      static:
        targets: [https://example.com/]
      preview:
        targets: [https://preview.example.com/]
        fetch: browser
```

```yaml
strategy:
  matrix:
    site: [static, preview]
steps:
  - uses: actions/checkout@v6
  - uses: damian-buho/spiderlint@0.143.0
    with:
      config_file: projectfile.yaml
      site:        ${{ matrix.site }}
```

Each site gets its own store, cache entry and SARIF category.

### Code scanning alerts via SARIF

```yaml
permissions:
  contents:        read
  security-events: write
steps:
  - uses: actions/checkout@v6
  - uses: damian-buho/spiderlint@0.143.0
    with:
      urls:         https://example.com/
      upload_sarif: true
```

### Pick rulesets and widen the crawl

```yaml
- uses: damian-buho/spiderlint@0.143.0
  with:
    urls:  https://example.com/
    rules: recommended,axe
    args: |
      --max-pages 200
```

### Warn-only (advisory mode)

```yaml
- uses: damian-buho/spiderlint@0.143.0
  with:
    urls:    https://example.com/
    fail_on: never
```

### Pin a specific image, e.g. for an air-gapped runner

```yaml
- uses: damian-buho/spiderlint@0.143.0
  with:
    urls:  https://intranet.example/
    image: my-registry.internal/spiderlint:0.143.0
```

## Permissions

| Permission               | Required when                    |
| ------------------------ | -------------------------------- |
| `contents: read`         | Always (for `actions/checkout`). |
| `security-events: write` | `upload_sarif: true`.            |

## Reporting

The action always writes:

- A JSON report to `$RUNNER_TEMP` (exposed as `report_json`).
- A SARIF report to `$RUNNER_TEMP` (exposed as `sarif_path`).
- A rendered human report in the Actions run summary page.

Both reports are rendered from the stored crawl, so the site is fetched once
per run. Exit codes above `1` (a crawl or configuration failure) fail the
job regardless of `fail_on`.

## Source and support

- Source: [github.com/damian-buho/spiderlint](https://github.com/damian-buho/spiderlint)
- Image:  [ghcr.io/damian-buho/spiderlint](https://github.com/damian-buho/spiderlint/pkgs/container/spiderlint)
- npm:    [npmjs.com/package/spiderlint](https://www.npmjs.com/package/spiderlint)
- Issues: [github.com/damian-buho/spiderlint/issues](https://github.com/damian-buho/spiderlint/issues)

## Development

Step logic lives in [`.scripts/action/audit.sh`](.scripts/action/audit.sh),
invoked via `github.action_path` and covered by the repository
`auto-shellcheck` gate — `action.yaml` itself holds only inputs, outputs
and step wiring.
