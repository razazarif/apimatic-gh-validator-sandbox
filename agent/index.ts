/**
 * APIMatic GitHub App Validator — Automation Agent
 *
 * Runs all test scenarios defined in scenarios.ts.
 * For each scenario it:
 *   1. Creates a unique branch in the target repo.
 *   2. Appends a dummy comment to the trigger file so the PR has a real diff.
 *   3. Opens a pull request — this fires the APIMatic GitHub App.
 *   4. Polls until the "APIMatic OpenAPI Linter" check run completes.
 *   5. Asserts the conclusion and (optionally) the PR comment body.
 *   6. Cleans up: closes the PR and deletes the branch.
 *
 * Required environment variables:
 *   GITHUB_TOKEN                        Personal access token with repo write access
 *                                       to both test repos.
 *
 * Optional environment variables:
 *   GH_APP_ENV                          'dev' (default) | 'prod'
 *   GH_VALIDATOR_REPO_WITH_SETTINGS     owner/repo for the repo with .apimaticsettings.json
 *                                       (default: razazarif/apimatic-gh-validator-sandbox)
 *   GH_VALIDATOR_REPO_WITHOUT_SETTINGS  owner/repo for the repo without settings
 *                                       (default: razazarif/apimatic-gh-validator-no-settings)
 *   SCENARIO_IDS                        Comma-separated list of scenario IDs to run
 *                                       (default: all). Example: TC-01,TC-02
 */

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
  type CheckConclusion,
} from './github.js';
import { buildScenarios, type Scenario } from './scenarios.js';

// ── Config ───────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const APP_ENV = (process.env.GH_APP_ENV ?? 'dev') as 'dev' | 'prod';
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

// ── Types ────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'error';
  actualConclusion?: CheckConclusion;
  expectedConclusion: CheckConclusion;
  commentAssertionPassed?: boolean;
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

/** Appends a YAML / markdown comment with a timestamp — minimal non-semantic change. */
function applyDummyChange(original: string, triggerFile: string): string {
  const ts = new Date().toISOString();
  if (triggerFile.endsWith('.yaml') || triggerFile.endsWith('.yml')) {
    return `${original.trimEnd()}\n# agent-trigger: ${ts}\n`;
  }
  return `${original.trimEnd()}\n\n<!-- agent-trigger: ${ts} -->\n`;
}

// ── Core runner ──────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const [owner, repo] = splitRepo(scenario.repo);
  const branch = uniqueBranch(scenario.id);
  let prNumber: number | undefined;

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`▶  ${scenario.id}: ${scenario.description}`);
  console.log(`   Repo: ${scenario.repo}  |  Trigger: ${scenario.triggerFile}`);

  try {
    // 1. Create branch off main
    const baseSha = await getDefaultBranchSha(owner, repo, GITHUB_TOKEN);
    await createBranch(owner, repo, branch, baseSha, GITHUB_TOKEN);
    console.log(`   Branch created: ${branch}`);

    // 2. Apply dummy change to trigger file
    const file = await getFileContent(owner, repo, scenario.triggerFile, branch, GITHUB_TOKEN);
    if (!file) {
      throw new Error(`Trigger file not found: ${scenario.triggerFile}`);
    }
    const newContent = applyDummyChange(file.content, scenario.triggerFile);
    await updateFile(
      owner,
      repo,
      scenario.triggerFile,
      newContent,
      `test(${scenario.id}): agent trigger — ${new Date().toISOString()}`,
      branch,
      file.sha,
      GITHUB_TOKEN,
    );
    console.log(`   Trigger file updated.`);

    // 3. Open pull request
    const { number, headSha } = await createPullRequest(
      owner,
      repo,
      `[agent] ${scenario.id}: ${scenario.description}`,
      branch,
      'main',
      `Automated test PR created by the APIMatic GitHub App validator agent.\n\n**Scenario:** ${scenario.id}\n**Expected conclusion:** \`${scenario.expectedConclusion}\``,
      GITHUB_TOKEN,
    );
    prNumber = number;
    const prUrl = `https://github.com/${scenario.repo}/pull/${number}`;
    console.log(`   PR opened: ${prUrl}`);

    // 4. Poll for APIMatic check run
    console.log(`   Waiting for APIMatic check run (app-env: ${APP_ENV}) …`);
    const checkResult = await pollApIMaticCheckRun(
      owner,
      repo,
      headSha,
      APP_ENV,
      GITHUB_TOKEN,
    );
    console.log(
      `   Check run completed: conclusion=${checkResult.conclusion}  title="${checkResult.outputTitle}"`,
    );

    // 5. Assert conclusion
    const conclusionPassed = checkResult.conclusion === scenario.expectedConclusion;
    if (!conclusionPassed) {
      console.log(
        `   ✗ Conclusion mismatch: expected "${scenario.expectedConclusion}", got "${checkResult.conclusion}"`,
      );
    }

    // 6. Assert PR comment (if validator provided)
    let commentAssertionPassed: boolean | undefined;
    if (scenario.validateComment) {
      const comments = await getPRComments(owner, repo, number, GITHUB_TOKEN);
      const apIMaticComment = comments.find((c) =>
        c.body.includes('OpenAPI Validation'),
      );
      if (apIMaticComment) {
        commentAssertionPassed = scenario.validateComment(apIMaticComment.body);
        if (!commentAssertionPassed) {
          console.log(`   ✗ PR comment assertion failed.`);
          console.log(`   Comment body (first 300 chars): ${apIMaticComment.body.slice(0, 300)}`);
        }
      } else {
        // No APIMatic comment found — only a problem for scenarios that expect one
        commentAssertionPassed = scenario.expectedConclusion === 'neutral';
        if (!commentAssertionPassed) {
          console.log(`   ✗ No APIMatic PR comment found (expected one for non-neutral conclusion).`);
        }
      }
    }

    const passed =
      conclusionPassed &&
      (commentAssertionPassed === undefined || commentAssertionPassed);

    if (passed) {
      console.log(`   ✓ PASSED`);
    } else {
      console.log(`   ✗ FAILED`);
    }

    return {
      id: scenario.id,
      description: scenario.description,
      status: passed ? 'passed' : 'failed',
      actualConclusion: checkResult.conclusion,
      expectedConclusion: scenario.expectedConclusion,
      commentAssertionPassed,
      prUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ✗ ERROR: ${msg}`);
    return {
      id: scenario.id,
      description: scenario.description,
      status: 'error',
      expectedConclusion: scenario.expectedConclusion,
      errorMessage: msg,
    };
  } finally {
    // 7. Clean up: close PR and delete branch regardless of outcome
    if (prNumber !== undefined) {
      try {
        await closePullRequest(owner, repo, prNumber, GITHUB_TOKEN);
      } catch {
        // non-fatal
      }
    }
    try {
      await deleteBranch(owner, repo, branch, GITHUB_TOKEN);
      console.log(`   Branch deleted: ${branch}`);
    } catch {
      // non-fatal
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allScenarios = buildScenarios(WITH_SETTINGS_REPO, NO_SETTINGS_REPO);
  const scenarios = SCENARIO_FILTER
    ? allScenarios.filter((s) => SCENARIO_FILTER.has(s.id))
    : allScenarios;

  console.log('APIMatic GitHub App Validator — Automation Agent');
  console.log(`App env  : ${APP_ENV}`);
  console.log(`With-settings repo    : ${WITH_SETTINGS_REPO}`);
  console.log(`No-settings repo      : ${NO_SETTINGS_REPO}`);
  console.log(`Scenarios to run      : ${scenarios.map((s) => s.id).join(', ')}`);

  const results: ScenarioResult[] = [];

  // Run scenarios sequentially to avoid race conditions on shared branches
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(72)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(72));

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const r of results) {
    const icon = r.status === 'passed' ? '✓' : '✗';
    const detail =
      r.status === 'error'
        ? r.errorMessage ?? ''
        : `expected=${r.expectedConclusion}  actual=${r.actualConclusion ?? 'n/a'}`;
    console.log(`  ${icon}  ${r.id}  ${r.status.toUpperCase().padEnd(7)}  ${detail}`);
    if (r.prUrl) console.log(`        PR: ${r.prUrl}`);
    if (r.status === 'passed') passCount++;
    else if (r.status === 'failed') failCount++;
    else errorCount++;
  }

  console.log(`\n  Passed: ${passCount}  Failed: ${failCount}  Errors: ${errorCount}`);
  console.log('═'.repeat(72));

  if (failCount > 0 || errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
