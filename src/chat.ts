/**
 * Chat channel — bridges browser chat to MCPL channels.
 *
 * Chat messages are stored as `chat.message` records in Chronicle.
 * Browser clients receive them via subscription.
 * The MCPL host receives them via `channels/incoming`.
 */

import type { JsStore } from 'chronicle';
import type { McplConnection, ChannelDescriptor, ContentBlock } from '@connectome/mcpl-core';
import { method, textContent } from '@connectome/mcpl-core';

export interface ChatMessage {
  author: string;
  authorId: string;
  text: string;
  timestamp: string;
  source: 'human' | 'agent';
}

export const CHAT_CHANNEL: ChannelDescriptor = {
  id: 'editor:chat',
  type: 'editor',
  label: 'Document Chat',
  direction: 'bidirectional',
};

export class ChatManager {
  private store: JsStore;
  private conn: McplConnection | null = null;
  private channelOpen = false;

  constructor(store: JsStore) {
    this.store = store;
  }

  setConnection(conn: McplConnection): void {
    this.conn = conn;
  }

  setChannelOpen(open: boolean): void {
    this.channelOpen = open;
  }

  /** Register the chat channel with the host. */
  async registerChannel(): Promise<void> {
    if (!this.conn) return;
    await this.conn.sendRequest(method.CHANNELS_REGISTER, {
      channels: [CHAT_CHANNEL],
    });
  }

  /**
   * Handle a chat message from a browser client.
   * Stores in Chronicle and forwards to MCPL host via channels/incoming.
   */
  async handleBrowserMessage(author: string, authorId: string, text: string): Promise<number> {
    const msg: ChatMessage = {
      author,
      authorId,
      text,
      timestamp: new Date().toISOString(),
      source: 'human',
    };

    const record = this.store.appendJson('chat.message', msg);

    // Forward to MCPL host (send regardless of channel open state —
    // the host may not explicitly open the channel but still wants messages)
    if (this.conn) {
      try {
        await this.conn.sendRequest(method.CHANNELS_INCOMING, {
          messages: [{
            channelId: CHAT_CHANNEL.id,
            messageId: String(record.id),
            author: { id: authorId, name: author },
            timestamp: msg.timestamp,
            content: [textContent(text)],
          }],
        });
      } catch {
        // Host may not be connected or channel not open — that's fine
      }
    }

    return record.sequence;
  }

  /**
   * Handle a channels/publish from the MCPL host (agent sending a chat message).
   * Stores in Chronicle — browsers pick it up via subscription.
   */
  handleAgentMessage(content: ContentBlock[]): number {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const msg: ChatMessage = {
      author: 'Agent',
      authorId: 'agent',
      text,
      timestamp: new Date().toISOString(),
      source: 'agent',
    };

    const record = this.store.appendJson('chat.message', msg);
    return record.sequence;
  }
}
