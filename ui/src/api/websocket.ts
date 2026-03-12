/**
 * WebSocket client for real-time sync with the editor server.
 * Handles connection, reconnection, and message routing.
 */

import { ref, type Ref } from 'vue';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface UseWebSocket {
  connected: Ref<boolean>;
  clientId: Ref<string>;
  send(msg: WsMessage): void;
  onMessage(handler: (msg: WsMessage) => void): void;
  connect(): void;
  disconnect(): void;
}

export function useWebSocket(): UseWebSocket {
  const connected = ref(false);
  const clientId = ref('');
  let ws: WebSocket | null = null;
  let handlers: Array<(msg: WsMessage) => void> = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function getWsUrl(): string {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  }

  function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;

    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      connected.value = true;
      // Heartbeat every 30s
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === 'init') {
          clientId.value = msg.clientId as string;
        }
        for (const handler of handlers) {
          handler(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      connected.value = false;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      // Auto-reconnect after 3s
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws?.close();
    ws = null;
    connected.value = false;
  }

  function send(msg: WsMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function onMessage(handler: (msg: WsMessage) => void) {
    handlers.push(handler);
  }

  return { connected, clientId, send, onMessage, connect, disconnect };
}
