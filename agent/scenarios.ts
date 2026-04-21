/**
 * Test scenario definitions for the APIMatic GitHub App validator agent.
 *
 * Each scenario describes:
 *  - which repo to target
 *  - which file to make a dummy change to (the "trigger file")
 *  - the expected APIMatic check-run conclusion
 *
 * Validation message counts (errors / warnings / info / total) are asserted
 * via baselines.json rather than hardcoded predicates. Run with
 * CAPTURE_BASELINE=true once to capture, then commit baselines.json.
 */

import type { CheckConclusion } from './github.js';

export interface Scenario {
  id: string;
  description: string;
  /** owner/repo */
  repo: string;
  /** File to append a dummy comment to so the PR has a real diff. */
  triggerFile: string;
  expectedConclusion: CheckConclusion;
}

export function buildScenarios(
  withSettingsRepo: string,
  noSettingsRepo: string,
): Scenario[] {
  return [
    // ── With .apimaticsettings.json ──────────────────────────────────────────

    {
      id: 'TC-01',
      description:
        'File path in settings (specs/openapi.yaml) — file handler routes correctly',
      repo: withSettingsRepo,
      triggerFile: 'specs/openapi.yaml',
      expectedConclusion: 'failure',
    },

    {
      id: 'TC-02',
      description:
        'Dot-named directory path (ben/capital.offer.created) — directory handler routes ' +
        'correctly [regression guard for apimatic/apimatic-common#1283]',
      repo: withSettingsRepo,
      triggerFile: 'ben/capital.offer.created/openapi.yaml',
      expectedConclusion: 'failure',
      // specName "Capital Offer API" captured in baseline proves directory handler was
      // invoked, not the file handler (regression guard for #1283).
    },

    {
      id: 'TC-03',
      description:
        'Non-OpenAPI dot-named directory (my.api) — directory handler routes correctly',
      repo: withSettingsRepo,
      triggerFile: 'my.api/spec.yaml',
      expectedConclusion: 'failure',
    },

    {
      id: 'TC-04',
      description:
        'Non-OpenAPI file change (README.md) — neutral, no definitions updated',
      repo: withSettingsRepo,
      triggerFile: 'README.md',
      expectedConclusion: 'neutral',
    },

    // ── Without .apimaticsettings.json (auto-detection) ──────────────────────

    {
      id: 'TC-05',
      description:
        'Auto-detection: invalid unified spec (specs/invalid.yaml) triggers failure',
      repo: noSettingsRepo,
      triggerFile: 'specs/invalid.yaml',
      expectedConclusion: 'failure',
    },

    {
      id: 'TC-06',
      description:
        'Auto-detection: valid unified spec (specs/unified.yaml) — check run completes',
      repo: noSettingsRepo,
      triggerFile: 'specs/unified.yaml',
      expectedConclusion: 'failure',
    },

    {
      id: 'TC-07',
      description:
        'Auto-detection: non-OpenAPI file change (README.md) — neutral, no definitions detected',
      repo: noSettingsRepo,
      triggerFile: 'README.md',
      expectedConclusion: 'neutral',
    },
  ];
}
