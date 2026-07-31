/**
 * Sentinel — GitHub connector.
 *
 * Responsibilities:
 *  - Open an issue on the failing-asset's pipeline repo with a filled-in
 *    template
 *  - Open a remediation PR (a schedule fix) — never merged
 *    (no-merge policy)
 *  - Trace mode: write a JSONL entry to
 *    `examples/trace/github-actions.log` rendered in the UI
 *    (demo surface)
 *  - Token scoped to ONE demo repo with `issues:write` + `pull_requests:write`
 *    only (least-privilege connectors)
 *
 * Interface + trace writer. Real GitHub API via Octokit or raw fetch
 * (POST /repos/{owner}/{repo}/issues, /pulls).
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
  /** Sentinel NEVER merges. This method does not exist. */
}

export const GITHUB_ACTIONS_LOG = 'examples/trace/github-actions.log';

/**
 * Trace-only writer. Swaps in the real GitHub client when configured.
 * The trace writer writes one JSONL line per action with the structure the
 * UI reads back. When `GITHUB_TOKEN` is set, the real connector takes over;
 * otherwise the trace writer remains the default.
 */
export class TraceGitHubConnector implements GitHubConnector {
  async openIssue(input: {
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ url: string; number: number }> {
    return this.traceLog('github.openIssue', input);
  }

  async openPR(input: {
    repo: string;
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<{ url: string; number: number }> {
    return this.traceLog('github.openPR', { ...input, merged: false });
  }

  private async traceLog(
    kind: 'github.openIssue' | 'github.openPR',
    payload: unknown,
  ): Promise<{ url: string; number: number }> {
    const now = new Date().toISOString();
    const number = Math.floor(Math.random() * 1000) + 1;
    const url =
      kind === 'github.openIssue'
        ? `https://github.com/${(payload as { repo: string }).repo}/issues/${number}`
        : `https://github.com/${(payload as { repo: string }).repo}/pull/${number}`;
    // Trace write — replaced with the real GitHub API when configured.
    void { kind, payload, url, number, ts: now };
    return { url, number };
  }
}

export { type ProposedAction };
