/**
 * GitHub REST API helpers used by the validation agent.
 * Uses native fetch (Node 18+). No external dependencies required.
 */

const GITHUB_API = 'https://api.github.com';

// ── Internal fetch wrapper ───────────────────────────────────────────────────

async function gh(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ── Branch helpers ───────────────────────────────────────────────────────────

export async function getDefaultBranchSha(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const repoRes = await gh('GET', `/repos/${owner}/${repo}`, token);
  const repoData = await repoRes.json() as { default_branch: string };
  const branch = repoData.default_branch;

  const refRes = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
  const refData = await refRes.json() as { object: { sha: string } };
  return refData.object.sha;
}

export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  sha: string,
  token: string,
): Promise<void> {
  const res = await gh('POST', `/repos/${owner}/${repo}/git/refs`, token, {
    ref: `refs/heads/${branchName}`,
    sha,
  });
  if (!res.ok) {
    throw new Error(`createBranch failed: ${res.status} ${await res.text()}`);
  }
}

export async function deleteBranch(
  owner: string,
  repo: string,
  branchName: string,
  token: string,
): Promise<void> {
  await gh('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branchName}`, token);
}

// ── File helpers ─────────────────────────────────────────────────────────────

export async function getFileContent(
  owner: string,
  repo: string,
  filePath: string,
  branch: string,
  token: string,
): Promise<{ content: string; sha: string } | null> {
  const res = await gh('GET', `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
  if (res.status === 404) return null;
  const data = await res.json() as { content: string; sha: string };
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

export async function updateFile(
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  message: string,
  branch: string,
  sha: string,
  token: string,
): Promise<void> {
  const res = await gh('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, token, {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    sha,
  });
  if (!res.ok) {
    throw new Error(`updateFile failed: ${res.status} ${await res.text()}`);
  }
}

// ── Pull request helpers ─────────────────────────────────────────────────────

export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string,
  token: string,
): Promise<{ number: number; headSha: string }> {
  const res = await gh('POST', `/repos/${owner}/${repo}/pulls`, token, {
    title,
    head,
    base,
    body,
  });
  if (!res.ok) {
    throw new Error(`createPullRequest failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { number: number; head: { sha: string } };
  return { number: data.number, headSha: data.head.sha };
}

export async function closePullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<void> {
  await gh('PATCH', `/repos/${owner}/${repo}/pulls/${prNumber}`, token, { state: 'closed' });
}

// ── Check-run helpers ────────────────────────────────────────────────────────

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

export interface CheckRunResult {
  conclusion: CheckConclusion;
  outputTitle: string;
  outputText: string;
}

/**
 * Polls until the APIMatic check run for `headSha` completes, then returns its result.
 * Throws if it does not complete within `timeoutMs`.
 */
export async function pollApIMaticCheckRun(
  owner: string,
  repo: string,
  headSha: string,
  appEnv: 'dev' | 'prod',
  token: string,
  timeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 15_000,
): Promise<CheckRunResult> {
  const appSlug =
    appEnv === 'dev' ? 'apimatic-openapi-linter-dev' : 'apimatic-openapi-linter';
  const checkName = 'APIMatic OpenAPI Linter';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await gh(
      'GET',
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs`,
      token,
    );
    const data = await res.json() as {
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: CheckConclusion;
        app: { slug: string };
        output: { title: string; text: string };
      }>;
    };

    const run = data.check_runs.find(
      (r) => r.app?.slug === appSlug && r.name === checkName,
    );

    if (run?.status === 'completed') {
      return {
        conclusion: run.conclusion,
        outputTitle: run.output?.title ?? '',
        outputText: run.output?.text ?? '',
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `APIMatic check run did not complete within ${timeoutMs / 1000}s for commit ${headSha}`,
  );
}

// ── PR comment helpers ───────────────────────────────────────────────────────

export async function getPRComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<Array<{ body: string; user: { login: string } }>> {
  const res = await gh('GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, token);
  return res.json() as Promise<Array<{ body: string; user: { login: string } }>>;
}