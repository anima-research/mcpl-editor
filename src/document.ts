/**
 * Document model — Chronicle-backed with CM6 ChangeSet operations.
 *
 * Each edit is a `doc.op` record containing a serialized CM6 ChangeSet.
 * The server maintains the document as a CM6 Text object and applies
 * ChangeSets in Chronicle sequence order. Periodic `doc.checkpoint`
 * records store full text snapshots for fast catch-up.
 *
 * The Chronicle sequence number IS the collab version — clients use it
 * to track confirmed vs unconfirmed changes.
 */

import { ChangeSet, Text } from '@codemirror/state';
import { JsStore } from 'chronicle';
import type { JsRecord } from 'chronicle';

// ============================================================================
// Types
// ============================================================================

/** Serialized update as stored in doc.op records. */
export interface SerializedUpdate {
  /** CM6 ChangeSet JSON (from ChangeSet.toJSON()) */
  changes: unknown;
  /** Client identifier */
  clientID: string;
}

export interface EditOperation {
  type: 'replace_all' | 'replace_range' | 'insert_after';
  text: string;
  startLine?: number;
  endLine?: number;
  line?: number;
}

export interface OutlineEntry {
  level: number;
  text: string;
  line: number;
}

// ============================================================================
// DocumentModel
// ============================================================================

const CHECKPOINT_INTERVAL = 100;

export class DocumentModel {
  private store: JsStore;
  private doc: Text;
  /** Version = number of doc.op records processed. Maps to Chronicle sequence offset. */
  private version = 0;
  /** Sequence number of the baseline (last checkpoint or 0). */
  private baselineSeq = 0;
  private opsSinceCheckpoint = 0;

  constructor(store: JsStore) {
    this.store = store;
    this.doc = Text.of(['']);
  }

  /** Initialize from store — find latest checkpoint + replay ops. */
  init(): void {
    const checkpoints = this.store.query({
      types: ['doc.checkpoint'],
      reverse: true,
      limit: 1,
    });

    let fromSeq = 0;
    if (checkpoints.length > 0) {
      const cp = checkpoints[0]!;
      const payload = JSON.parse(Buffer.from(cp.payload).toString('utf-8'));
      this.doc = Text.of(payload.text.split('\n'));
      fromSeq = cp.sequence;
      this.baselineSeq = fromSeq;
    }

    // Replay ops since checkpoint
    if (fromSeq < this.store.currentSequence()) {
      const ops = this.store.query({
        types: ['doc.op'],
        fromSequence: fromSeq + 1,
      });

      for (const record of ops) {
        const update = JSON.parse(Buffer.from(record.payload).toString('utf-8')) as SerializedUpdate;
        try {
          const changes = ChangeSet.fromJSON(update.changes);
          this.doc = changes.apply(this.doc);
          this.version++;
          this.opsSinceCheckpoint++;
        } catch {
          // Skip invalid ops (e.g., from older full-text format)
        }
      }
    }
  }

  /** Current collab version (number of applied doc.ops). */
  getVersion(): number {
    return this.version;
  }

  /** Get current document text. */
  getText(): string {
    return this.doc.toString();
  }

  /** Get document length. */
  getLength(): number {
    return this.doc.length;
  }

  /** Get document text at a historical checkpoint. */
  getTextAt(checkpoint: string): string | null {
    const seq = this.parseCheckpoint(checkpoint);
    if (seq === null) return null;

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
      const payload = JSON.parse(Buffer.from(cp.payload).toString('utf-8'));
      text = payload.text;
      fromSeq = cp.sequence;
    }

    if (fromSeq >= seq) return text;

    let doc = Text.of(text.split('\n'));
    const ops = this.store.query({
      types: ['doc.op'],
      fromSequence: fromSeq + 1,
      toSequence: seq,
    });

    for (const record of ops) {
      const update = JSON.parse(Buffer.from(record.payload).toString('utf-8')) as SerializedUpdate;
      try {
        const changes = ChangeSet.fromJSON(update.changes);
        doc = changes.apply(doc);
      } catch {
        // Skip
      }
    }

    return doc.toString();
  }

  /**
   * Apply a CM6 ChangeSet from a browser client.
   * Returns the assigned version and sequence for confirmation.
   */
  applyUpdate(changesJSON: unknown, clientID: string): { version: number; sequence: number } {
    const changes = ChangeSet.fromJSON(changesJSON);
    this.doc = changes.apply(this.doc);

    const record = this.store.appendJson('doc.op', {
      changes: changesJSON,
      clientID,
    } satisfies SerializedUpdate);

    this.version++;
    this.opsSinceCheckpoint++;
    this.maybeCheckpoint();

    return { version: this.version, sequence: record.sequence };
  }

  /**
   * Apply edit operations from the agent (tool calls).
   * Converts line-based operations to a CM6 ChangeSet, applies it,
   * and returns the update for broadcasting to browser clients.
   */
  applyEdits(operations: EditOperation[], clientID: string): { text: string; version: number; sequence: number; changes: unknown } {
    let text = this.doc.toString();

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

    // Create a ChangeSet that replaces the entire document with the new text
    const changes = ChangeSet.of(
      { from: 0, to: this.doc.length, insert: text },
      this.doc.length,
    );
    const changesJSON = changes.toJSON();
    this.doc = changes.apply(this.doc);

    const record = this.store.appendJson('doc.op', {
      changes: changesJSON,
      clientID,
    } satisfies SerializedUpdate);

    this.version++;
    this.opsSinceCheckpoint++;
    this.maybeCheckpoint();

    return { text, version: this.version, sequence: record.sequence, changes: changesJSON };
  }

  /** Get document outline (headings with line numbers). */
  getOutline(): OutlineEntry[] {
    const text = this.doc.toString();
    const lines = text.split('\n');
    const outline: OutlineEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        outline.push({ level: match[1]!.length, text: match[2]!, line: i + 1 });
      }
    }
    return outline;
  }

  currentCheckpoint(): string {
    return `seq_${this.store.currentSequence()}`;
  }

  parseCheckpoint(checkpoint: string): number | null {
    const match = checkpoint.match(/^seq_(\d+)$/);
    if (!match) return null;
    return parseInt(match[1]!, 10);
  }

  forceCheckpoint(): void {
    this.store.appendJson('doc.checkpoint', { text: this.doc.toString() });
    this.opsSinceCheckpoint = 0;
  }

  /**
   * Get all updates since a given version (for catch-up).
   * Returns serialized updates that a client can apply.
   */
  getUpdatesSince(version: number): SerializedUpdate[] {
    // version = number of doc.ops already seen
    // We need doc.ops from (baselineSeq + version + 1) to current
    const fromSeq = this.baselineSeq + version + 1;
    const ops = this.store.query({
      types: ['doc.op'],
      fromSequence: fromSeq,
    });

    return ops.map(record => {
      return JSON.parse(Buffer.from(record.payload).toString('utf-8')) as SerializedUpdate;
    });
  }

  private maybeCheckpoint(): void {
    if (this.opsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
      this.forceCheckpoint();
    }
    // Flush writes to disk so data survives container restarts
    this.store.sync();
  }
}
