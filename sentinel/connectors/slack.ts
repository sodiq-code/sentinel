/**
 * Sentinel — Slack connector.
 *
 * PDF §9.4.1 + §9.3.5.
 *
 * Responsibilities:
 *  - Post a triaged-incident summary to the sandbox channel
 *    (PDF §9.4.2 step 11)
 *  - Sandbox mode: write a JSONL entry to
 *    `examples/sandbox/slack-posts.log` rendered in the UI
 *    (Phase 3, Phase 5 demo surface)
 *  - Token scoped to ONE channel (PDF §9.3.5)
 *
 * Phase 0: interface + sandbox writer. Phase 3: real Slack Web API
 * `chat.postMessage` via fetch.
 */

export const SLACK_POSTS_LOG = 'examples/sandbox/slack-posts.log';

/** Public interface — see `orchestrator.ts`. */
export interface SlackConnector {
  postTriage(input: { channel: string; text: string }): Promise<{ ts: string; channel: string }>;
}

/**
 * Phase 0: sandbox-only writer. Phase 3 swaps in the real Slack client.
 * When `SLACK_BOT_TOKEN` is set in Phase 3, the real connector takes over.
 */
export class SandboxSlackConnector implements SlackConnector {
  async postTriage(input: { channel: string; text: string }): Promise<{ ts: string; channel: string }> {
    const now = new Date().toISOString();
    const ts = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1_000_000)}`;
    void { kind: 'slack.postMessage', payload: input, ts, at: now };
    return { ts, channel: input.channel };
  }
}
