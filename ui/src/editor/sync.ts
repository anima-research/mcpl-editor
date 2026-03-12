/**
 * Editor sync — bridges WebSocket events to CodeMirror 6 state.
 *
 * Handles:
 * - Initial document load from server
 * - Local edits → send to server as ops
 * - Remote ops (from server subscription) → apply to CM6
 * - Skipping own ops that come back via subscription
 */

import { EditorView, type ViewUpdate } from '@codemirror/view';
import { type UseWebSocket, type WsMessage } from '../api/websocket.js';

export interface EditorSync {
  /** Set the EditorView reference (called after CM6 mounts). */
  setView(view: EditorView): void;
  /** Handle a WebSocket message. */
  handleMessage(msg: WsMessage): void;
  /** Create a CM6 update listener that sends ops on change. */
  updateListener(): (update: ViewUpdate) => void;
}

export function createEditorSync(ws: UseWebSocket): EditorSync {
  let view: EditorView | null = null;
  let suppressLocal = false; // Prevent echo when applying remote ops

  function setView(v: EditorView) {
    view = v;
  }

  function handleMessage(msg: WsMessage) {
    if (!view) return;

    switch (msg.type) {
      case 'init': {
        // Initial document from server
        const text = msg.text as string;
        const currentDoc = view.state.doc.toString();
        if (text !== currentDoc) {
          suppressLocal = true;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
          });
          suppressLocal = false;
        }
        break;
      }

      case 'event': {
        // Chronicle subscription event — data is { record: { record_type, payload, ... } }
        const eventType = msg.eventType as string;
        const data = msg.data as Record<string, unknown>;

        if (eventType === 'record') {
          const record = data.record as Record<string, unknown> | undefined;
          if (!record) break;
          const payload = record.payload as Record<string, unknown> | undefined;
          if (!payload) break;

          const recordType = record.record_type as string;

          // doc.op — apply remote document edit
          if (recordType === 'doc.op') {
            const newText = payload.text as string;
            if (newText === undefined) break;

            // Skip if it matches our current doc (already applied locally)
            const currentDoc = view.state.doc.toString();
            if (newText === currentDoc) break;

            suppressLocal = true;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: newText },
            });
            suppressLocal = false;
          }
        }
        break;
      }
    }
  }

  function updateListener(): (update: ViewUpdate) => void {
    return (update: ViewUpdate) => {
      if (suppressLocal) return;
      if (!update.docChanged) return;

      // Send the new document text to the server
      const text = update.state.doc.toString();
      ws.send({ type: 'op', text });
    };
  }

  return { setView, handleMessage, updateListener };
}
