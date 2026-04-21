/**
 * APIMatic GitHub App Validator — Automation Agent
 *
 * Runs all test scenarios defined in scenarios.ts.
 * For each scenario it:
 *   1. Creates a unique branch in the target repo.
 *   2. Appends a dummy comment to the trigger file so the PR has a real diff.
 *   3. Opens a pull request — this fires the APIMatic GitHub App.
 *   4. Polls until the "APIMatic OpenAPI Linter" check run completes.
 *   5. Asserts the conclusion against expectedConclusion.
 *   6. Parses the validation summary comment (errors / warnings / info / total / specName)
 *      and either captures it to baselines.json (CAPTURE_BASELINE=true) or asserts
 *      it matches the stored baseline.
 *   7. Cleans up: closes the PR and deletes the branch.
 *
 * Required environment variables:
 *   GITHUB_TOKEN                        Personal access token with repo write access
 *                                       to both test repos.
 *
 * Optional environment variables:
 *   GH_APP_ENV                          'dev' (default) | 'prod'
 *   CAPTURE_BASELINE                    'true' to capture baselines instead of asserting.
 *                                       Writes agent/baselines.json. Commit that file
 *                                       afterwards so future runs can compare against it.
 *   GH_VALIDATOR_REPO_WITH_SETTINGS     owner/repo for the repo with .apimaticsettings.json
 *                                       (default: razazarif/apimatic-gh-validator-sandbox)
 *   GH_VALIDATOR_REPO_WITHOUT_SETTINGS  owner/repo for the repo without settings
 *                                       (default: razazarif/apimatic-gh-validator-no-settings)
 *   SCENARIO_IDS                        Comma-separated list of scenario IDs to run
 *                                       (default: all). Example: TC-01,TC-02
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getDefaultBranchSha,
  createBranch,
  deleteBranch,
  getFileContent,
  updateFile,
  createPullRequest,
  closePullRequest,
  pollApIMaticCheckRun,
  getPRComments,
  parseValidationSummary,
  type CheckConclusion,
  type ValidationSummary,
} from './github.js';
import { buildScenarios, type Scenario } from './scenarios.js';

// ── Config ───────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const APP_ENV = (process.env.GH_APP_ENV ?? 'dev') as 'dev' | 'prod';
const CAPTURE_BASELINE = process.env.CAPTURE_BASELINE === 'true';
const WITH_SETTINGS_REPO =
  process.env.GH_VALIDATOR_REPO_WITH_SETTINGS ??
  'razazarif/apimatic-gh-validator-sandbox';
const NO_SETTINGS_REPO =
  process.env.GH_VALIDATOR_REPO_WITHOUT_SETTINGS ??
  'razazarif/apimatic-gh-validator-no-settings';
const SCENARIO_FILTER = process.env.SCENARIO_IDS
  ? new Set(process.env.SCENARIO_IDS.split(',').map((s) => s.trim()))
  : null;

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN environment variable is required.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_PATH = path.join(__dirname, 'baselines.json');

// ── Baseline helpers ─────────────────────────────────────────────────────────

type BaselineEntry = ValidationSummary | null;
type Baselines = Record<string, BaselineEntry>;

function loadBaselines(): Baselines {
  if (!fs.existsSync(BASELINES_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINES_PATH, 'utf8')) as Baselines;
}

function saveBaselines(baselines: Baselines): void {
  fs.writeFileSync(BASELINES_PATH, JSON.stringify(baselines, null, 2) + '\n', 'utf8');
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'error';
  actualConclusion?: CheckConclusion;
  expectedConclusion: CheckConclusion;
  baselineStatus?: 'captured' | 'matched' | 'mismatch' | 'no_baseline';
  capturedSummary?: BaselineEntry;
  errorMessage?: string;
  prUrl?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function uniqueBranch(scenarioId: string): string {
  return `agent/${scenarioId.toLowerCase()}-${Date.now()}`;
}

function splitRepo(ownerRepo: string): [string, string] {
  const [owner, repo] = ownerRepo.split('/');
  return [owner, repo];
}

function applyDummyChange(original: string, triggerFile: string): string {
  const ts = new Date().toISOString();
  if (triggerFile.endsWith('.yaml') || triggerFile.endsWith('.yml')) {
    return original.trimEnd() + '\n# agent-trigger: ' + ts + '\n';
  }
  return original.trimEnd() + '\n\n<!-- agent-trigger: ' + ts + ' -->\n';
}

function summaryMatches(actual: ValidationSummary, baseline: ValidationSummary): boolean {
  return (
    actual.specName === baseline.specName &&
    actual.errors === baseline.errors &&
    actual.warnings === baseline.warnings &&
    actual.information === baseline.information &&
    actual.totalMessages === baseline.totalMessages
  );
}

function formatSummary(s: ValidationSummary): string {
  return (
    'specName="' + s.specName + '"' +
    ' errors=' + s.errors +
    ' warnings=' + s.warnings +
    ' info=' + s.information +
    ' total=' + s.totalMessages
  );
}

// ── Core runner ──────────────────────────────────────────────────────────────

async function runScenario(
  scenario: Scenario,
  baselines: Baselines,
): Promise<ScenarioResult> {
  const [owner, repo] = splitRepo(scenario.repo);
  const branch = uniqueBranch(scenario.id);
  let prNumber: number | undefined;

  console.log('\n' + '─'.repeat(72));
  console.log('▶  ' + scenario.id + ': ' + scenario.description);
  console.log('   Repo: ' + scenario.repo + '  |  Trigger: ' + scenario.triggerFile);

  try {
    const baseSha = await getDefaultBranchSha(owner, repo, GITHUB_TOKEN);
    await createBranch(owner, repo, branch, baseSha, GITHUB_TOKEN);
    console.log('   Branch created: ' + branch);

    const file = await getFileContent(owner, repo, scenario.triggerFile, branch, GITHUB_TOKEN);
    if (!file) {
      throw new Error('Trigger file not found: ' + scenario.triggerFile);
    }
    const newContent = applyDummyChange(file.content, scenario.triggerFile);
    await updateFile(
      owner,
      repo,
      scenario.triggerFile,
      newContent,
      'test(' + scenario.id + '): agent trigger — ' + new Date().toISOString(),
      branch,
      file.sha,
      GITHUB_TOKEN,
    );
    console.log('   Trigger file updated.');

    const { number, headSha } = await createPullRequest(
      owner,
      repo,
      '[agent] ' + scenario.id + ': ' + scenario.description,
      branch,
      'main',
      'Automated test PR created by the APIMatic GitHub App validator agent.\n\n**Scenario:** ' +
        scenario.id +
        '\n**Expected conclusion:** `' + scenario.expectedConclusion + '`',
      GITHUB_TOKEN,
    );
    prNumber = number;
    const prUrl = 'https://github.com/' + scenario.repo + '/pull/' + number;
    console.log('   PR opened: ' + prUrl);

    console.log('   Waiting for APIMatic check run (app-env: ' + APP_ENV + ') ...');
    const checkResult = await pollApIMaticCheckRun(
      owner,
      repo,
      headSha,
      APP_ENV,
      GITHUB_TOKEN,
    );
    console.log(
      '   Check run completed: conclusion=' + checkResult.conclusion + '  title="' + checkResult.outputTitle + '"',
    );

    const conclusionPassed = checkResult.conclusion === scenario.expectedConclusion;
    if (!conclusionPassed) {
      console.log(
        '   ✗ Conclusion mismatch: expected "' + scenario.expectedConclusion + '", got "' + checkResult.conclusion + '"',
      );
    }

    const comments = await getPRComments(owner, repo, number, GITHUB_TOKEN);
    const apIMaticComment = comments.find((c) => c.body.includes('OpenAPI Validation'));
    const actualSummary = apIMaticComment ? parseValidationSummary(apIMaticComment.body) : null;

    let baselineStatus: ScenarioResult['baselineStatus'];

    if (CAPTURE_BASELINE) {
      baselines[scenario.id] = actualSummary;
      baselineStatus = 'captured';
      if (actualSummary) {
        console.log('   ● Baseline captured: ' + formatSummary(actualSummary));
      } else {
        console.log('   ● Baseline captured: null (neutral — no comment posted)');
      }
    } else {
      const stored = baselines[scenario.id];
      if (stored === undefined) {
        baselineStatus = 'no_baseline';
        console.log('   ⚠ No baseline for ' + scenario.id + ' — skipping count assertion. Run with CAPTURE_BASELINE=true first.');
      } else if (stored === null && actualSummary === null) {
        baselineStatus = 'matched';
        console.log('   ✓ Baseline matched: null (neutral)');
      } else if (stored !== null && actualSummary !== null && summaryMatches(actualSummary, stored)) {
        baselineStatus = 'matched';
        console.log('   ✓ Baseline matched: ' + formatSummary(actualSummary));
      } else {
        baselineStatus = 'mismatch';
        console.log('   ✗ Baseline mismatch:');
        console.log('     Expected: ' + (stored ? formatSummary(stored) : 'null'));
        console.log('     Actual  : ' + (actualSummary ? formatSummary(actualSummary) : 'null'));
      }
    }

    const baselinePassed =
      CAPTURE_BASELINE ||
      baselineStatus === 'matched' ||
      baselineStatus === 'no_baseline';

    const passed = conclusionPassed && baselinePassed;
    console.log(passed ? '   ✓ PASSED' : '   ✗ FAILED');

    return {
      id: scenario.id,
      description: scenario.description,
      status: passed ? 'passed' : 'failed',
      actualConclusion: checkResult.conclusion,
      expectedConclusion: scenario.expectedConclusion,
      baselineStatus,
      capturedSummary: CAPTURE_BASELINE ? actualSummary : undefined,
      prUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('   ✗ ERROR: ' + msg);
    return {
      id: scenario.id,
      description: scenario.description,
      status: 'error',
      expectedConclusion: scenario.expectedConclusion,
      errorMessage: msg,
    };
  } finally {
    if (prNumber !== undefined) {
      try { await closePullRequest(owner, repo, prNumber, GITHUB_TOKEN); } catch { /* non-fatal */ }
    }
    try {
      await deleteBranch(owner, repo, branch, GITHUB_TOKEN);
      console.log('   Branch deleted: ' + branch);
    } catch { /* non-fatal */ }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allScenarios = buildScenarios(WITH_SETTINGS_REPO, NO_SETTINGS_REPO);
  const scenarios = SCENARIO_FILTER
    ? allScenarios.filter((s) => SCENARIO_FILTER.has(s.id))
    : allScenarios;

  console.log('APIMatic GitHub App Validator — Automation Agent');
  console.log('App env        : ' + APP_ENV);
  console.log('Mode           : ' + (CAPTURE_BASELINE ? 'CAPTURE BASELINE' : 'ASSERT'));
  console.log('With-settings repo    : ' + WITH_SETTINGS_REPO);
  console.log('No-settings repo      : ' + NO_SETTINGS_REPO);
  console.log('Scenarios to run      : ' + scenarios.map((s) => s.id).join(', '));
  if (CAPTURE_BASELINE) {
    console.log('Baselines file        : ' + BASELINES_PATH);
  }

  const baselines = loadBaselines();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, baselines);
    results.push(result);
  }

  if (CAPTURE_BASELINE) {
    saveBaselines(baselines);
    console.log('\n✓ Baselines written to ' + BASELINES_PATH);
    console.log('  Commit this file so future runs can assert against it.');
  }

  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const r of results) {
    const icon = r.status === 'passed' ? '✓' : '✗';
    const conclusionDetail = 'expected=' + r.expectedConclusion + '  actual=' + (r.actualConclusion ?? 'n/a');
    const baselineDetail = r.baselineStatus ? '  baseline=' + r.baselineStatus : '';
    const errDetail = r.status === 'error' ? r.errorMessage ?? '' : conclusionDetail + baselineDetail;
    console.log('  ' + icon + '  ' + r.id + '  ' + r.status.toUpperCase().padEnd(7) + '  ' + errDetail);
    if (r.prUrl) console.log('        PR: ' + r.prUrl);
    if (r.status === 'passed') passCount++;
    else if (r.status === 'failed') failCount++;
    else errorCount++;
  }

  console.log('\n  Passed: ' + passCount + '  Failed: ' + failCount + '  Errors: ' + errorCount);
  console.log('═'.repeat(72));

  if (failCount > 0 || errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
