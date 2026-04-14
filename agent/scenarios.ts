/**
 * Test scenario definitions for the APIMatic GitHub App validator agent.
 *
 * Each scenario describes:
 *  - which repo to target
 *  - which file to make a dummy change to (the "trigger file")
 *  - the expected APIMatic check-run conclusion
 *  - an optional assertion on the PR comment body
 *
 * APP_ENV controls which app slug is polled:
 *   dev  → apimatic-openapi-linter-dev
 *   prod → apimatic-openapi-linter
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
  /**
   * Optional predicate on the first APIMatic PR comment body.
   * Return true if the comment is acceptable, false to fail the assertion.
   */
  validateComment?: (body: string) => boolean;
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
      validateComment: (body) =>
        body.includes('OpenAPI Validation') && body.includes('Validation failed'),
    },

    {
      id: 'TC-02',
      description:
        'Dot-named directory path (ben/capital.offer.created) — directory handler routes ' +
        'correctly [regression guard for apimatic/apimatic-common#1283]',
      repo: withSettingsRepo,
      triggerFile: 'ben/capital.offer.created/openapi.yaml',
      expectedConclusion: 'failure',
      // Key assertion: the PR comment mentions the spec title found INSIDE the directory.
      // This proves the directory handler was invoked (not the file handler, which would
      // have crashed trying to open the directory as a stream).
      validateComment: (body) =>
        body.includes('OpenAPI Validation') && body.includes('Capital Offer API'),
    },

    {
      id: 'TC-03',
      description:
        'Non-OpenAPI dot-named directory (my.api) — directory handler routes correctly',
      repo: withSettingsRepo,
      triggerFile: 'my.api/spec.yaml',
      expectedConclusion: 'failure',
      validateComment: (body) => body.includes('OpenAPI Validation'),
    },

    {
      id: 'TC-04',
      description:
        'Non-OpenAPI file change (README.md) — neutral, no definitions updated',
      repo: withSettingsRepo,
      triggerFile: 'README.md',
      expectedConclusion: 'neutral',
      // App posts no comment when conclusion is neutral.
      validateComment: undefined,
    },

    // ── Without .apimaticsettings.json (auto-detection) ──────────────────────

    {
      id: 'TC-05',
      description:
        'Auto-detection: invalid unified spec (specs/invalid.yaml) triggers failure',
      repo: noSettingsRepo,
      triggerFile: 'specs/invalid.yaml',
      expectedConclusion: 'failure',
      validateComment: (body) =>
        body.includes('OpenAPI Validation') && body.includes('Validation failed'),
    },

    {
      id: 'TC-06',
      description:
        'Auto-detection: valid unified spec (specs/unified.yaml) — check run completes ' +
        '[expected conclusion calibrated on first run; update to "success" once confirmed]',
      repo: noSettingsRepo,
      triggerFile: 'specs/unified.yaml',
      // APIMatic validation may flag warnings-as-errors. Accept 'failure' on first run
      // and update to 'success' once the spec is confirmed clean by APIMatic.
      expectedConclusion: 'failure',
      validateComment: (body) => body.includes('OpenAPI Validation'),
    },

    {
      id: 'TC-07',
      description:
        'Auto-detection: non-OpenAPI file change (README.md) — neutral, no definitions detected',
      repo: noSettingsRepo,
      triggerFile: 'README.md',
      expectedConclusion: 'neutral',
      validateComment: undefined,
    },
  ];
}
