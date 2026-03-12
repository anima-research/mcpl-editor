/**
 * Editor server — Express HTTP + WebSocket for browsers + MCPL endpoint for agents.
 *
 * Browser clients connect via WebSocket for real-time editing sync.
 * MCPL hosts connect via a separate WebSocket endpoint.
 * Chronicle subscriptions bridge store events to browser clients.
 */

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JsStore } from 'chronicle';
import type { JsStoreEvent } from 'chronicle';
import { McplConnection } from '@connectome/mcpl-core';

import { DocumentModel } from './document.js';
import { ChatManager } from './chat.js';
import { EditorMcplServer } from './mcpl.js';

// ============================================================================
// Types
// ============================================================================

interface BrowserClient {
  ws: WebSocket;
  clientId: string;
  subscriptionId: string;
}

interface ServerOptions {
  port: number;
  storePath: string;
  initialText?: string;
}

// ============================================================================
// EditorServer
// ============================================================================

export class EditorServer {
  private store: JsStore;
  private doc: DocumentModel;
  private chat: ChatManager;
  private mcplServer: EditorMcplServer;
  private browserClients = new Map<string, BrowserClient>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private nextClientId = 1;

  constructor(options: ServerOptions) {
    this.store = JsStore.openOrCreate({ path: options.storePath });
    this.doc = new DocumentModel(this.store);
    this.chat = new ChatManager(this.store);

    // Initialize document from store or seed with initial text
    this.doc.init();
    if (this.doc.getText() === '' && options.initialText) {
      this.doc.applyEdits([{ type: 'replace_all', text: options.initialText }], 'init');
      this.doc.forceCheckpoint();
    }

    // Create MCPL server after doc is initialized (needs current checkpoint)
    this.mcplServer = new EditorMcplServer(this.doc, this.chat);
    this.mcplServer.setBroadcast((changes, clientID) => this.broadcastAgentUpdate(changes, clientID));
  }

  /**
   * Start the server.
   */
  async start(port: number): Promise<void> {
    const app = express();
    app.use(express.json());

    // CORS
    app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });

    // Health check
    app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

    // API: get current document
    app.get('/api/document', (_req, res) => {
      res.json({ text: this.doc.getText(), checkpoint: this.doc.currentCheckpoint() });
    });

    // API: get latest checkpoint for catch-up
    app.get('/api/checkpoint', (_req, res) => {
      const checkpoints = this.store.query({
        types: ['doc.checkpoint'],
        reverse: true,
        limit: 1,
      });
      if (checkpoints.length === 0) {
        res.json({ sequence: 0, text: '' });
      } else {
        const cp = checkpoints[0]!;
        const payload = JSON.parse(Buffer.from(cp.payload).toString('utf-8'));
        res.json({ sequence: cp.sequence, text: payload.text });
      }
    });

    // API: query records (for catch-up)
    app.get('/api/records', (req, res) => {
      const fromSeq = req.query.from ? parseInt(req.query.from as string, 10) : undefined;
      const types = req.query.type ? [req.query.type as string] : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

      const records = this.store.query({
        types,
        fromSequence: fromSeq,
        limit,
      });

      const items = records.map(r => ({
        id: r.id,
        sequence: r.sequence,
        type: r.recordType,
        payload: JSON.parse(Buffer.from(r.payload).toString('utf-8')),
        timestamp: r.timestamp,
      }));

      res.json({ items });
    });

    // Serve the Vue/CodeMirror UI from ui/dist/
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const uiDist = resolve(__dirname, '../ui/dist');
    if (existsSync(uiDist)) {
      app.use(express.static(uiDist));
      // SPA fallback — serve index.html for non-API routes
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.sendFile(resolve(uiDist, 'index.html'));
      });
    }

    const httpServer = createServer(app);

    // WebSocket server for browser clients (editing sync)
    const wsBrowser = new WebSocketServer({ noServer: true });
    wsBrowser.on('connection', (ws) => this.handleBrowserConnection(ws));

    // WebSocket server for MCPL connections
    const wsMcpl = new WebSocketServer({ noServer: true });
    wsMcpl.on('connection', (ws) => this.handleMcplConnection(ws));

    // Route upgrades by path
    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

      if (url.pathname === '/mcpl') {
        wsMcpl.handleUpgrade(request, socket, head, (ws) => {
          wsMcpl.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws') {
        wsBrowser.handleUpgrade(request, socket, head, (ws) => {
          wsBrowser.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Start polling subscriptions for browser clients
    this.pollInterval = setInterval(() => this.pollSubscriptions(), 50);

    httpServer.listen(port, () => {
      console.log(`mcpl-editor listening on http://localhost:${port}`);
      console.log(`  Browser WS: ws://localhost:${port}/ws`);
      console.log(`  MCPL WS:    ws://localhost:${port}/mcpl`);
    });
  }

  // ==========================================================================
  // Browser WebSocket handling
  // ==========================================================================

  private handleBrowserConnection(ws: WebSocket): void {
    const clientId = `browser-${this.nextClientId++}`;

    // Create a Chronicle subscription for chat messages only
    // (doc.ops are broadcast directly via broadcastUpdates for lower latency)
    const subscriptionId = this.store.subscribe({
      filter: {
        recordTypes: ['chat.message'],
        includeRecords: true,
      },
    });

    // Catch up to transition subscription to live mode
    this.store.catchUpSubscription(subscriptionId);

    const client: BrowserClient = { ws, clientId, subscriptionId };
    this.browserClients.set(clientId, client);

    // Send initial state with collab version
    ws.send(JSON.stringify({
      type: 'init',
      clientId,
      text: this.doc.getText(),
      version: this.doc.getVersion(),
      checkpoint: this.doc.currentCheckpoint(),
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
        this.handleBrowserMessage(clientId, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.store.unsubscribe(subscriptionId);
      this.browserClients.delete(clientId);
    });
  }

  private handleBrowserMessage(clientId: string, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'pushUpdates': {
        // Browser is sending collab updates (CM6 ChangeSets)
        const clientVersion = msg.version as number;
        const updates = msg.updates as Array<{ changes: unknown; clientID: string }>;

        if (clientVersion !== this.doc.getVersion()) {
          // Client is behind — send them the updates they missed
          const missed = this.doc.getUpdatesSince(clientVersion);
          const client = this.browserClients.get(clientId);
          if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'updates', updates: missed }));
          }
          return;
        }

        const previousText = this.doc.getText();
        const confirmed: Array<{ changes: unknown; clientID: string }> = [];

        for (const update of updates) {
          const { version } = this.doc.applyUpdate(update.changes, update.clientID);
          confirmed.push({ changes: update.changes, clientID: update.clientID });
        }

        // Broadcast confirmed updates to ALL browser clients (including sender)
        this.broadcastUpdates(confirmed);

        // Notify MCPL host
        this.mcplServer.notifyDocumentChanged(this.doc.getText(), previousText);
        break;
      }

      case 'chat': {
        // Browser is sending a chat message
        const author = (msg.author as string) ?? 'Human';
        const authorId = (msg.authorId as string) ?? clientId;
        const text = msg.text as string;
        this.chat.handleBrowserMessage(author, authorId, text).catch(() => {});
        break;
      }

      case 'ping':
        this.browserClients.get(clientId)?.ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  /** Broadcast confirmed collab updates to all browser clients. */
  private broadcastUpdates(updates: Array<{ changes: unknown; clientID: string }>): void {
    const msg = JSON.stringify({ type: 'updates', updates });
    for (const [, client] of this.browserClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /** Broadcast confirmed updates from an agent edit to all browser clients. */
  broadcastAgentUpdate(changes: unknown, clientID: string): void {
    this.broadcastUpdates([{ changes, clientID }]);
  }

  // ==========================================================================
  // Subscription polling → chat messages only
  // ==========================================================================

  private pollSubscriptions(): void {
    for (const [clientId, client] of this.browserClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      let event: JsStoreEvent | null;
      while ((event = this.store.pollSubscription(client.subscriptionId)) !== null) {
        if (event.eventType === 'caught_up' || event.eventType === 'dropped') continue;

        const parsed = JSON.parse(event.data);

        // Only forward chat messages (doc.ops are handled via broadcastUpdates)
        if (event.eventType === 'record' && parsed.record?.record_type === 'chat.message') {
          // Skip chat messages from this client (already shown optimistically)
          if (parsed.record?.payload?.authorId === clientId) continue;

          client.ws.send(JSON.stringify({
            type: 'event',
            eventType: event.eventType,
            data: parsed,
          }));
        }
      }
    }
  }

  // ==========================================================================
  // MCPL WebSocket handling
  // ==========================================================================

  private handleMcplConnection(ws: WebSocket): void {
    console.log('MCPL client connected');
    const conn = McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0]);

    // Run the MCPL server loop (blocks until disconnected)
    this.mcplServer.serve(conn).catch((err) => {
      console.error('MCPL serve error:', err);
    });
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const [, client] of this.browserClients) {
      this.store.unsubscribe(client.subscriptionId);
      client.ws.close();
    }
    this.browserClients.clear();

    this.store.close();
  }
}
