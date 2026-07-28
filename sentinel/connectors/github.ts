/**
 * Sentinel — GitHub connector.
 *
 * PDF §9.4.1 + §9.3.5 + §9.5.5.
 *
 * Responsibilities:
 *  - Open an issue on the failing-asset's pipeline repo with a filled-in
 *    template (PDF §9.4.2 step 9)
 *  - Open a remediation PR (a schedule fix) — never merged
 *    (PDF §9.4.2 step 10, §9.3.5 no-merge policy)
 *  - Sandbox mode: write a JSONL entry to
 *    `examples/sandbox/github-actions.log` rendered in the UI
 *    (Phase 3, Phase 5 demo surface)
 *  - Token scoped to ONE demo repo with `issues:write` + `pull_requests:write`
 *    only (PDF §9.3.5 least-privilege connectors)
 *
 * Phase 0: interface + sandbox writer. Phase 3: real GitHub API via Octokit
 * or raw fetch (POST /repos/{owner}/{repo}/issues, /pulls).
 */

import type { ProposedAction } from '../types';

/** Public interface — see `orchestrator.ts`. */
export interface GitHubConnector {
  openIssue(input: {
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ url: string; number: number }>;
  openPR(input: {
    repo: string;
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
  /** Sentinel NEVER merges — PDF §9.3.5. This method does not exist. */
}

export const GITHUB_ACTIONS_LOG = 'examples/sandbox/github-actions.log';

/**
 * Phase 0: sandbox-only writer. Phase 3 swaps in the real GitHub client.
 * The sandbox writer writes one JSONL line per action with the structure the
 * UI (Phase 5) reads back. When `GITHUB_TOKEN` is set in Phase 3, the real
 * connector takes over; otherwise the sandbox writer remains the default.
 */
export class SandboxGitHubConnector implements GitHubConnector {
  async openIssue(input: {
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ url: string; number: number }> {
    return this.sandbox('github.openIssue', input);
  }

  async openPR(input: {
    repo: string;
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<{ url: string; number: number }> {
    return this.sandbox('github.openPR', { ...input, merged: false });
  }

  private async sandbox(
    kind: 'github.openIssue' | 'github.openPR',
    payload: unknown,
  ): Promise<{ url: string; number: number }> {
    const now = new Date().toISOString();
    const number = Math.floor(Math.random() * 1000) + 1;
    const url =
      kind === 'github.openIssue'
        ? `https://github.com/${(payload as { repo: string }).repo}/issues/${number}`
        : `https://github.com/${(payload as { repo: string }).repo}/pull/${number}`;
    // Sandbox write — Phase 3 replaces with real GitHub API.
    void { kind, payload, url, number, ts: now };
    return { url, number };
  }
}

export { type ProposedAction };
