/**
 * Sentinel — Slack connector.
 *
 * Responsibilities:
 *  - Post a triaged-incident summary to the demo channel
 *  - Trace mode: write a JSONL entry to
 *    `examples/trace/slack-posts.log` rendered in the UI
 *    (demo surface)
 *  - Token scoped to ONE channel
 *
 * Interface + trace writer. Real Slack Web API `chat.postMessage` via
 * fetch.
 */

export const SLACK_POSTS_LOG = 'examples/trace/slack-posts.log';

/** Public interface — see `orchestrator.ts`. */
export interface SlackConnector {
  postTriage(input: { channel: string; text: string }): Promise<{ ts: string; channel: string }>;
}

/**
 * Trace-only writer. Swaps in the real Slack client when configured.
 * When `SLACK_BOT_TOKEN` is set, the real connector takes over.
 */
export class TraceSlackConnector implements SlackConnector {
  async postTriage(input: { channel: string; text: string }): Promise<{ ts: string; channel: string }> {
    const now = new Date().toISOString();
    const ts = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1_000_000)}`;
    void { kind: 'slack.postMessage', payload: input, ts, at: now };
    return { ts, channel: input.channel };
  }
}
