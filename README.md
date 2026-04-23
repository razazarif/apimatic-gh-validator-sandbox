# APIMatic GitHub App Validator — Sandbox

End-to-end test suite for the APIMatic GitHub App path classifier. Covers the regression from [`apimatic/apimatic-common#1283`](https://github.com/apimatic/apimatic-common/pull/1283) where `Path.HasExtension("ben/capital.offer.created")` returned `true` due to dots, misrouting dot-named directories as files.

## Repos

Two repos work together as test targets:

| Repo | Purpose |
|------|---------|
| [`razazarif/apimatic-gh-validator-sandbox`](https://github.com/razazarif/apimatic-gh-validator-sandbox) | Has `.apimaticsettings.json` — tests explicit path configuration |
| [`razazarif/apimatic-gh-validator-no-settings`](https://github.com/razazarif/apimatic-gh-validator-no-settings) | No `.apimaticsettings.json` — tests auto-detection mode |

---

## Test Scenarios

All 7 scenarios are run by the automation agent. Each creates a temporary PR, waits for the `APIMatic OpenAPI Linter` check run, asserts the result, then cleans up.

### Sandbox repo (with `.apimaticsettings.json`)

| ID | Trigger file | Expected conclusion | What it tests |
|----|-------------|---------------------|---------------|
| TC-01 | `specs/openapi.yaml` | `failure` | File path in settings — routes to file handler |
| TC-02 | `ben/capital.offer.created/openapi.yaml` | `failure` | **Regression guard** — dot-named directory must route to directory handler, not file handler |
| TC-03 | `my.api/spec.yaml` | `failure` | Non-OpenAPI dot-named directory — directory handler |
| TC-04 | `README.md` | `neutral` | Non-OpenAPI file change — app posts no validation comment |

### No-settings repo (auto-detection mode)

| ID | Trigger file | Expected conclusion | What it tests |
|----|-------------|---------------------|---------------|
| TC-05 | `specs/invalid.yaml` | `failure` | Auto-detection finds a deliberately invalid spec |
| TC-06 | `specs/unified.yaml` | `failure` | Auto-detection finds a valid unified spec (currently has warnings) |
| TC-07 | `README.md` | `neutral` | Non-OpenAPI file change — no definitions detected |

---

## No-Settings Repo — Spec Files

[`razazarif/apimatic-gh-validator-no-settings`](https://github.com/razazarif/apimatic-gh-validator-no-settings) contains:

| File | Description |
|------|-------------|
| `specs/unified.yaml` | Valid, self-contained OpenAPI spec ("Unified Petstore API") |
| `specs/invalid.yaml` | Deliberately malformed spec ("Malformed API") — triggers validation errors |
| `specs/split/main.yaml` | Valid split spec with `$ref` includes |

No `.apimaticsettings.json` is present, so the app uses its built-in auto-detection to find OpenAPI files in changed paths.

---

## Running the Tests

### Option 1 — Claude Code skill (recommended)

Install the skill once, then trigger from any Claude Code session with a single command.

**Install:**
Copy the `run-gh-app-tests/` folder into your `~/.claude/skills/` directory:

```
~/.claude/skills/run-gh-app-tests/
├── SKILL.md
└── baselines.json
```

**Run:**
```
/run-gh-app-tests
```

The skill auto-clones this repo if not already present, installs dependencies, runs all 7 scenarios, and prints a full summary table with expected vs actual results. No context needed — the skill has everything built in.

**Options:**

| Command | What it does |
|---------|-------------|
| `/run-gh-app-tests` | All 7 scenarios against `dev` app |
| `/run-gh-app-tests prod` | All 7 scenarios against `prod` app |
| `/run-gh-app-tests TC-02` | Single scenario (regression guard only) |
| `/run-gh-app-tests TC-02,TC-05 prod` | Specific scenarios against prod |
| `/run-gh-app-tests capture` | Re-capture baselines after spec changes |

### Option 2 — Run manually from the terminal

```bash
cd agent
npm install
GITHUB_TOKEN=<your-pat> GH_APP_ENV=dev npm run run

# Single scenario
GITHUB_TOKEN=<your-pat> SCENARIO_IDS=TC-02 npm run run

# Against prod
GITHUB_TOKEN=<your-pat> GH_APP_ENV=prod npm run run
```

---

## Agent — How It Works

The agent lives in `agent/` and is written in TypeScript (Node 18+, `tsx`).

For each scenario it:
1. Creates a unique branch in the target repo
2. Appends a dummy comment to the trigger file to produce a real diff
3. Opens a pull request — this fires the APIMatic GitHub App
4. Polls until the `APIMatic OpenAPI Linter` check run completes
5. Asserts the conclusion matches `expectedConclusion`
6. Parses the validation summary comment and compares counts against `baselines.json`
7. Closes the PR and deletes the branch

### Key files

| File | Purpose |
|------|---------|
| `agent/index.ts` | Main runner — executes scenarios, prints summary, exits non-zero on failure |
| `agent/scenarios.ts` | Scenario definitions (trigger file, expected conclusion, repo) |
| `agent/github.ts` | GitHub REST API helpers (branch, PR, check-run polling, comments) |
| `agent/baselines.json` | Expected validation summary counts per scenario |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | required | PAT with repo write access to both test repos |
| `GH_APP_ENV` | `dev` | `dev` or `prod` — selects which GitHub App installation to poll |
| `SCENARIO_IDS` | all | Comma-separated list of scenario IDs to run (e.g. `TC-01,TC-03`) |
| `CAPTURE_BASELINE` | `false` | Set to `true` to capture new baselines instead of asserting |

### GitHub App identifiers

| Env | App slug | Check run name |
|-----|----------|----------------|
| `dev` | `apimatic-openapi-linter-dev` | `APIMatic OpenAPI Linter` |
| `prod` | `apimatic-openapi-linter` | `APIMatic OpenAPI Linter` |

---

## CI

A GitHub Actions workflow (`.github/workflows/gh-app-validator-agent.yml`) provides manual dispatch with `dev`/`prod` selection and an optional `SCENARIO_IDS` filter. Requires the `AGENT_GITHUB_TOKEN` repo secret.

---

## Prerequisites

- Node.js 18+
- `gh` CLI authenticated (`gh auth login`)
- Write access to both test repos

## Related

- Fix: [`apimatic/apimatic-common#1283`](https://github.com/apimatic/apimatic-common/pull/1283)
- QA issue: [`apimatic/apimatic-common#1282`](https://github.com/apimatic/apimatic-common/issues/1282)
- Tracking: [`apimatic/api-test-automation#50`](https://github.com/apimatic/api-test-automation/issues/50)
