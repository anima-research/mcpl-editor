/**
 * Document model — Chronicle-backed document storage with operation log.
 *
 * Each edit is a `doc.op` record. Periodic `doc.checkpoint` records
 * store full document snapshots for fast catch-up. The document is
 * reconstructed by replaying ops from the last checkpoint.
 */

import { JsStore } from 'chronicle';
import type { JsRecord } from 'chronicle';

// ============================================================================
// Types
// ============================================================================

export interface EditOperation {
  type: 'replace_all' | 'replace_range' | 'insert_after';
  text: string;
  startLine?: number;
  endLine?: number;
  line?: number;
}

export interface DocOp {
  /** Operation that transforms the document. For now, replace_all with full text. */
  text: string;
  clientId: string;
  /** Previous document text (for diffing in push/event). */
  previousLength: number;
}

export interface DocCheckpoint {
  text: string;
}

export interface OutlineEntry {
  level: number;
  text: string;
  line: number;
}

// ============================================================================
// DocumentModel
// ============================================================================

const CHECKPOINT_INTERVAL = 100; // Create checkpoint every N ops

export class DocumentModel {
  private store: JsStore;
  private currentText: string = '';
  private opsSinceCheckpoint: number = 0;

  constructor(store: JsStore) {
    this.store = store;
  }

  /** Initialize from store — find latest checkpoint + replay ops. */
  init(): void {
    // Find the latest checkpoint
    const checkpoints = this.store.query({
      types: ['doc.checkpoint'],
      reverse: true,
      limit: 1,
    });

    let fromSeq = 0;
    if (checkpoints.length > 0) {
      const cp = checkpoints[0]!;
      const payload = JSON.parse(Buffer.from(cp.payload).toString('utf-8')) as DocCheckpoint;
      this.currentText = payload.text;
      fromSeq = cp.sequence;
    }

    // Replay ops since checkpoint
    const ops = this.store.query({
      types: ['doc.op'],
      fromSequence: fromSeq + 1,
    });

    for (const record of ops) {
      const op = JSON.parse(Buffer.from(record.payload).toString('utf-8')) as DocOp;
      this.currentText = op.text;
      this.opsSinceCheckpoint++;
    }
  }

  /** Get current document text. */
  getText(): string {
    return this.currentText;
  }

  /** Get document text at a historical checkpoint. */
  getTextAt(checkpoint: string): string | null {
    const seq = this.parseCheckpoint(checkpoint);
    if (seq === null) return null;

    // Find latest checkpoint at or before seq
    const checkpoints = this.store.query({
      types: ['doc.checkpoint'],
      toSequence: seq,
      reverse: true,
      limit: 1,
    });

    let text = '';
    let fromSeq = 0;
    if (checkpoints.length > 0) {
      const cp = checkpoints[0]!;
      const payload = JSON.parse(Buffer.from(cp.payload).toString('utf-8')) as DocCheckpoint;
      text = payload.text;
      fromSeq = cp.sequence;
    }

    // Replay ops between checkpoint and target seq
    if (fromSeq >= seq) return text;
    const ops = this.store.query({
      types: ['doc.op'],
      fromSequence: fromSeq + 1,
      toSequence: seq,
    });

    for (const record of ops) {
      const op = JSON.parse(Buffer.from(record.payload).toString('utf-8')) as DocOp;
      text = op.text;
    }

    return text;
  }

  /**
   * Apply edit operations from the agent.
   * Returns the new document text and the Chronicle sequence (checkpoint).
   */
  applyEdits(operations: EditOperation[], clientId: string): { text: string; sequence: number } {
    let text = this.currentText;

    for (const op of operations) {
      switch (op.type) {
        case 'replace_all':
          text = op.text;
          break;

        case 'replace_range': {
          const lines = text.split('\n');
          const start = (op.startLine ?? 1) - 1;
          const end = (op.endLine ?? lines.length) - 1;
          const newLines = op.text.split('\n');
          lines.splice(start, end - start + 1, ...newLines);
          text = lines.join('\n');
          break;
        }

        case 'insert_after': {
          const lines = text.split('\n');
          const after = op.line ?? 0;
          const newLines = op.text.split('\n');
          lines.splice(after, 0, ...newLines);
          text = lines.join('\n');
          break;
        }
      }
    }

    const previousLength = this.currentText.length;
    this.currentText = text;

    // Append doc.op record
    const record = this.store.appendJson('doc.op', {
      text,
      clientId,
      previousLength,
    } satisfies DocOp);

    this.opsSinceCheckpoint++;
    this.maybeCheckpoint();

    return { text, sequence: record.sequence };
  }

  /**
   * Apply a raw text update from a browser client (via WebSocket).
   * Returns the Chronicle sequence.
   */
  applyBrowserOp(text: string, clientId: string): number {
    const previousLength = this.currentText.length;
    this.currentText = text;

    const record = this.store.appendJson('doc.op', {
      text,
      clientId,
      previousLength,
    } satisfies DocOp);

    this.opsSinceCheckpoint++;
    this.maybeCheckpoint();

    return record.sequence;
  }

  /** Get document outline (headings with line numbers). */
  getOutline(): OutlineEntry[] {
    const lines = this.currentText.split('\n');
    const outline: OutlineEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        outline.push({
          level: match[1]!.length,
          text: match[2]!,
          line: i + 1,
        });
      }
    }

    return outline;
  }

  /** Get current sequence number as a checkpoint string. */
  currentCheckpoint(): string {
    return `seq_${this.store.currentSequence()}`;
  }

  /** Parse a checkpoint string to a sequence number. */
  parseCheckpoint(checkpoint: string): number | null {
    const match = checkpoint.match(/^seq_(\d+)$/);
    if (!match) return null;
    return parseInt(match[1]!, 10);
  }

  /** Force a checkpoint now. */
  forceCheckpoint(): void {
    this.store.appendJson('doc.checkpoint', {
      text: this.currentText,
    } satisfies DocCheckpoint);
    this.opsSinceCheckpoint = 0;
  }

  /** Create a checkpoint if enough ops have accumulated. */
  private maybeCheckpoint(): void {
    if (this.opsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
      this.forceCheckpoint();
    }
  }
}
