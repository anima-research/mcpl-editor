/**
 * Editor sync — CM6 collab extension bridged to WebSocket.
 *
 * Uses @codemirror/collab for proper OT-style collaboration:
 * - Local changes are sent as serialized ChangeSets
 * - Remote changes are received and applied via receiveUpdates()
 * - The collab extension handles rebasing unconfirmed local changes
 *
 * The server (Chronicle) is the single sequencer — its sequence number
 * IS the collab version.
 */

import { collab, sendableUpdates, receiveUpdates, getSyncedVersion } from '@codemirror/collab';
import { ChangeSet, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { UseWebSocket, WsMessage } from '../api/websocket.js';

export interface EditorSync {
  /** Create the CM6 collab extensions (pass to EditorState.create). */
  extensions(): Extension[];
  /** Handle a WebSocket message. */
  handleMessage(msg: WsMessage): void;
}

export function createEditorSync(ws: UseWebSocket): EditorSync {
  let view: EditorView | null = null;
  let startVersion = 0;
  let clientID = '';

  function pushUpdates() {
    if (!view) return;
    const updates = sendableUpdates(view.state);
    if (updates.length === 0) return;

    ws.send({
      type: 'pushUpdates',
      version: getSyncedVersion(view.state),
      updates: updates.map(u => ({
        changes: u.changes.toJSON(),
        clientID: u.clientID,
      })),
    });
  }

  function handleMessage(msg: WsMessage) {
    if (!view) return;

    switch (msg.type) {
      case 'init': {
        // Server sends initial document + version
        const text = msg.text as string;
        startVersion = msg.version as number;
        clientID = msg.clientId as string;

        // Replace entire document content
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
        break;
      }

      case 'updates': {
        // Server pushes confirmed updates
        const serialized = msg.updates as Array<{ changes: unknown; clientID: string }>;
        const updates = serialized.map(u =>
          ({
            changes: ChangeSet.fromJSON(u.changes),
            clientID: u.clientID,
          }),
        );

        view.dispatch(receiveUpdates(view.state, updates));

        // After receiving updates, check if we have unconfirmed changes to push
        pushUpdates();
        break;
      }
    }
  }

  function extensions(): Extension[] {
    return [
      collab({ startVersion, clientID }),
      ViewPlugin.fromClass(class {
        constructor(private view: EditorView) {
          // Capture view reference for the sync layer
          // Use queueMicrotask to avoid dispatching during init
          queueMicrotask(() => {
            (view as any); // keep reference alive
            setView(this.view);
          });
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            pushUpdates();
          }
        }
      }),
    ];
  }

  function setView(v: EditorView) {
    view = v;
  }

  return { extensions, handleMessage };
}
