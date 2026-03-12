/**
 * MCPL server logic — handles the MCP/MCPL handshake, tool dispatch,
 * state/update flow, and push/event debouncing.
 */

import type {
  McplConnection,
  JsonRpcRequest,
  JsonRpcNotification,
  PushEventParams,
  StateUpdateParams,
} from '@connectome/mcpl-core';
import { method, textContent } from '@connectome/mcpl-core';

import type { DocumentModel } from './document.js';
import type { ChatManager } from './chat.js';
import { CHAT_CHANNEL } from './chat.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { toolDefinitions } from './tools.js';

// ============================================================================
// Constants
// ============================================================================

const PUSH_DEBOUNCE_MS = 1500;
const PUSH_MAX_DELAY_MS = 5000;

// ============================================================================
// EditorMcplServer
// ============================================================================

export class EditorMcplServer {
  private conn: McplConnection | null = null;
  private doc: DocumentModel;
  private chat: ChatManager;
  private enabledFeatureSets = new Set<string>();
  private mcplEnabled = false;
  private currentCheckpoint: string | null = null;

  // Push/event debounce state
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushMaxTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSummary: string | null = null;
  private broadcastFn: ((changes: unknown, clientID: string) => void) | null = null;

  constructor(doc: DocumentModel, chat: ChatManager) {
    this.doc = doc;
    this.chat = chat;
    this.currentCheckpoint = doc.currentCheckpoint();
  }

  /** Set the broadcast function for pushing agent edits to browser clients. */
  setBroadcast(fn: (changes: unknown, clientID: string) => void): void {
    this.broadcastFn = fn;
  }

  /**
   * Main serve loop — handles the MCPL connection lifecycle.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.chat.setConnection(conn);

    await this.handleInitialize();

    if (this.mcplEnabled) {
      await this.chat.registerChannel();
    }

    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await this.handleRequest(msg.request);
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch {
      // Connection closed
    } finally {
      this.conn = null;
      this.clearDebounceTimers();
    }
  }

  // ==========================================================================
  // Document change notifications (called by the server when browsers edit)
  // ==========================================================================

  /**
   * Called when a browser client edits the document.
   * Sends state/update immediately and schedules debounced push/event.
   */
  notifyDocumentChanged(newText: string, previousText: string): void {
    if (!this.conn || !this.mcplEnabled) return;

    const checkpoint = this.doc.currentCheckpoint();
    const parent = this.currentCheckpoint;

    // Send state/update (opaque checkpoint, no data)
    if (isEnabled('editor.observe', this.enabledFeatureSets)) {
      this.conn.sendRequest(method.STATE_UPDATE, {
        featureSet: 'editor.observe',
        checkpoint,
        parent,
      } satisfies StateUpdateParams).catch(() => {});
    }

    this.currentCheckpoint = checkpoint;

    // Schedule debounced push/event
    this.schedulePushEvent(newText, previousText);
  }

  // ==========================================================================
  // Initialize handshake
  // ==========================================================================

  private async handleInitialize(): Promise<void> {
    const msg = await this.conn!.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      throw new Error('Expected initialize request');
    }

    const params = (msg.request.params ?? {}) as Record<string, unknown>;
    const caps = params.capabilities as Record<string, unknown> | undefined;
    const experimental = caps?.experimental as Record<string, unknown> | undefined;
    const mcpl = experimental?.mcpl as Record<string, unknown> | undefined;
    this.mcplEnabled = !!mcpl;

    // Build response
    const serverCaps: Record<string, unknown> = {
      tools: {},
    };

    if (this.mcplEnabled) {
      serverCaps.experimental = {
        mcpl: {
          version: '0.5',
          pushEvents: true,
          stateUpdate: true,
          channels: { register: true, publish: true, observe: true },
          branches: { list: true, create: true, switch: true, delete: true },
          featureSets,
        },
      };
    }

    this.conn!.sendResponse(msg.request.id!, {
      protocolVersion: '2024-11-05',
      capabilities: serverCaps,
      serverInfo: { name: 'mcpl-editor', version: '0.1.0' },
    });

    // Wait for initialized notification
    const initialized = await this.conn!.nextMessage();
    if (initialized.type !== 'notification') {
      throw new Error('Expected notifications/initialized');
    }

    // Default: enable all feature sets
    if (this.mcplEnabled) {
      for (const name of Object.keys(featureSets)) {
        this.enabledFeatureSets.add(name);
      }
    }
  }

  // ==========================================================================
  // Request dispatch
  // ==========================================================================

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list':
          this.conn!.sendResponse(req.id!, { tools: toolDefinitions });
          break;

        case 'tools/call':
          await this.handleToolCall(req, params);
          break;

        case method.CHANNELS_LIST:
          this.conn!.sendResponse(req.id!, { channels: [CHAT_CHANNEL] });
          break;

        case method.CHANNELS_OPEN:
          this.chat.setChannelOpen(true);
          this.conn!.sendResponse(req.id!, { channel: CHAT_CHANNEL });
          break;

        case method.CHANNELS_CLOSE:
          this.chat.setChannelOpen(false);
          this.conn!.sendResponse(req.id!, { closed: true });
          break;

        case method.STATE_ROLLBACK:
          this.handleRollback(req, params);
          break;

        default:
          this.conn!.sendError(req.id!, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      this.conn!.sendError(req.id!, -32603, err instanceof Error ? err.message : 'Internal error');
    }
  }

  // ==========================================================================
  // Notification dispatch
  // ==========================================================================

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        const params = (notif.params ?? {}) as { enabled?: string[]; disabled?: string[] };
        if (params.enabled) {
          for (const name of params.enabled) this.enabledFeatureSets.add(name);
        }
        if (params.disabled) {
          for (const name of params.disabled) this.enabledFeatureSets.delete(name);
        }
        break;
      }

      case method.CHANNELS_PUBLISH: {
        const params = (notif.params ?? {}) as { channelId?: string; content?: unknown[] };
        if (params.channelId === CHAT_CHANNEL.id && params.content) {
          this.chat.handleAgentMessage(params.content as import('@connectome/mcpl-core').ContentBlock[]);
        }
        break;
      }

      case method.BRANCHES_CHANGED: {
        // Host notifies us that a branch changed — we could update UI state
        // For now, just acknowledge internally
        break;
      }
    }
  }

  // ==========================================================================
  // Tool handlers
  // ==========================================================================

  private async handleToolCall(req: JsonRpcRequest, params: Record<string, unknown>): Promise<void> {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    const fs = featureSetForTool(name);
    if (!isEnabled(fs, this.enabledFeatureSets)) {
      this.conn!.sendError(req.id!, -32001, `Feature set not enabled: ${fs}`);
      return;
    }

    switch (name) {
      case 'get_document': {
        const checkpoint = args.atCheckpoint as string | undefined;
        const text = checkpoint
          ? this.doc.getTextAt(checkpoint)
          : this.doc.getText();

        if (text === null) {
          this.conn!.sendResponse(req.id!, {
            content: [textContent(`Checkpoint not found: ${checkpoint}`)],
            isError: true,
          });
          return;
        }

        this.conn!.sendResponse(req.id!, {
          content: [textContent(text)],
        });
        break;
      }

      case 'edit_document': {
        const operations = args.operations as import('./document.js').EditOperation[];
        const { text, sequence, changes } = this.doc.applyEdits(operations, 'agent');
        const checkpoint = `seq_${sequence}`;
        const parent = this.currentCheckpoint;
        this.currentCheckpoint = checkpoint;

        // Broadcast to browser clients so they see the edit in real-time
        this.broadcastFn?.(changes, 'agent');

        // Send state/update to host
        if (this.conn && isEnabled('editor.observe', this.enabledFeatureSets)) {
          this.conn.sendRequest(method.STATE_UPDATE, {
            featureSet: 'editor.observe',
            checkpoint,
            parent,
          } satisfies StateUpdateParams).catch(() => {});
        }

        this.conn!.sendResponse(req.id!, {
          content: [textContent(`Document updated (${text.split('\n').length} lines)`)],
          state: { checkpoint },
        });
        break;
      }

      case 'get_outline': {
        const outline = this.doc.getOutline();
        const formatted = outline.length === 0
          ? 'No headings found.'
          : outline.map(e => `${'  '.repeat(e.level - 1)}${e.text} (line ${e.line})`).join('\n');

        this.conn!.sendResponse(req.id!, {
          content: [textContent(formatted)],
        });
        break;
      }

      default:
        this.conn!.sendError(req.id!, -32601, `Unknown tool: ${name}`);
    }
  }

  // ==========================================================================
  // Rollback
  // ==========================================================================

  private handleRollback(req: JsonRpcRequest, params: Record<string, unknown>): void {
    const checkpoint = params.checkpoint as string;
    const text = this.doc.getTextAt(checkpoint);

    if (text === null) {
      this.conn!.sendResponse(req.id!, {
        checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      });
      return;
    }

    // Apply as a new edit (creates a forward-moving sequence)
    const { sequence } = this.doc.applyEdits(
      [{ type: 'replace_all', text }],
      'rollback',
    );
    const newCheckpoint = `seq_${sequence}`;
    this.currentCheckpoint = newCheckpoint;

    this.conn!.sendResponse(req.id!, {
      checkpoint: newCheckpoint,
      success: true,
    });
  }

  // ==========================================================================
  // Push/event debouncing
  // ==========================================================================

  private schedulePushEvent(newText: string, previousText: string): void {
    if (!isEnabled('editor.observe', this.enabledFeatureSets)) return;

    // Build a simple summary
    const newLines = newText.split('\n').length;
    const prevLines = previousText.split('\n').length;
    const lineDiff = newLines - prevLines;
    const summary = lineDiff === 0
      ? `Document edited (${newLines} lines)`
      : lineDiff > 0
        ? `Document edited: ${lineDiff} lines added (${newLines} total)`
        : `Document edited: ${Math.abs(lineDiff)} lines removed (${newLines} total)`;

    this.pendingSummary = summary;

    // Restart debounce timer
    if (this.pushDebounceTimer) clearTimeout(this.pushDebounceTimer);
    this.pushDebounceTimer = setTimeout(() => this.firePushEvent(), PUSH_DEBOUNCE_MS);

    // Start max timer if not running
    if (!this.pushMaxTimer) {
      this.pushMaxTimer = setTimeout(() => this.firePushEvent(), PUSH_MAX_DELAY_MS);
    }
  }

  private firePushEvent(): void {
    this.clearDebounceTimers();
    if (!this.conn || !this.pendingSummary) return;

    const params: PushEventParams = {
      featureSet: 'editor.observe',
      eventId: `doc_change_${Date.now()}`,
      timestamp: new Date().toISOString(),
      origin: { source: 'editor' },
      payload: {
        content: [textContent(this.pendingSummary)],
      },
    };

    this.conn.sendRequest(method.PUSH_EVENT, params).catch(() => {});
    this.pendingSummary = null;
  }

  private clearDebounceTimers(): void {
    if (this.pushDebounceTimer) { clearTimeout(this.pushDebounceTimer); this.pushDebounceTimer = null; }
    if (this.pushMaxTimer) { clearTimeout(this.pushMaxTimer); this.pushMaxTimer = null; }
  }
}
