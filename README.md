# APIMatic GitHub Validator Sandbox

This repo tests how the APIMatic GitHub App routes paths defined in `.apimaticsettings.json`.
Each scenario branch targets a different path type and becomes a PR that triggers the validator.

## Scenarios

| Branch | `OpenapiDefinitionPaths` value | Expected routing |
|--------|-------------------------------|-----------------|
| `test/scenario-1-dot-directory` | `ben/capital.offer.created` | Directory handler |
| `test/scenario-2-valid-yaml-file` | `specs/openapi.yaml` | File handler |
| `test/scenario-3-dot-named-dir` | `my.api` | Directory handler |

## Why this exists

`Path.HasExtension("ben/capital.offer.created")` returns `true` because of the dots,
causing the path to be misrouted as a file. Fix tracked in apimatic/apimatic-common#1283.

<!-- agent-trigger: 2026-04-23T05:41:14.059Z -->
