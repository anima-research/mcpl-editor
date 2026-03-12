/**
 * Editor sync — CM6 collab extension bridged to WebSocket.
 *
 * The editor is created AFTER the init message arrives (so we know the
 * correct startVersion). The collab extension handles rebasing
 * unconfirmed local changes against confirmed remote ones.
 */

import { collab, sendableUpdates, receiveUpdates, getSyncedVersion } from '@codemirror/collab';
import { ChangeSet, EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { UseWebSocket, WsMessage } from '../api/websocket.js';

export interface EditorSync {
  /** Handle a WebSocket message. */
  handleMessage(msg: WsMessage): void;
  /** Called by the App when the editor container element is ready. */
  setContainer(el: HTMLElement): void;
  /** Provide the static extensions (everything except collab). */
  staticExtensions: Extension[];
}

export function createEditorSync(ws: UseWebSocket, staticExtensions: Extension[]): EditorSync {
  let view: EditorView | null = null;
  let container: HTMLElement | null = null;
  let pendingUpdates: Array<{ changes: unknown; clientID: string }> = [];

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

  function createEditor(text: string, version: number, clientID: string) {
    if (!container) return;
    if (view) view.destroy();

    const state = EditorState.create({
      doc: text,
      extensions: [
        ...staticExtensions,
        collab({ startVersion: version, clientID }),
        ViewPlugin.fromClass(class {
          update(update: ViewUpdate) {
            if (update.docChanged) pushUpdates();
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: container });

    // Apply any updates that arrived before the editor was created
    if (pendingUpdates.length > 0) {
      applyRemoteUpdates(pendingUpdates);
      pendingUpdates = [];
    }
  }

  function applyRemoteUpdates(serialized: Array<{ changes: unknown; clientID: string }>) {
    if (!view) return;
    const updates = serialized.map(u => ({
      changes: ChangeSet.fromJSON(u.changes),
      clientID: u.clientID,
    }));
    view.dispatch(receiveUpdates(view.state, updates));
    pushUpdates();
  }

  function handleMessage(msg: WsMessage) {
    switch (msg.type) {
      case 'init': {
        const text = msg.text as string;
        const version = msg.version as number;
        const clientID = msg.clientId as string;
        createEditor(text, version, clientID);
        break;
      }

      case 'updates': {
        const serialized = msg.updates as Array<{ changes: unknown; clientID: string }>;
        if (view) {
          applyRemoteUpdates(serialized);
        } else {
          // Editor not ready yet — buffer updates
          pendingUpdates.push(...serialized);
        }
        break;
      }
    }
  }

  function setContainer(el: HTMLElement) {
    container = el;
  }

  return { handleMessage, setContainer, staticExtensions };
}
