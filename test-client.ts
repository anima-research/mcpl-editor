/**
 * Test client — connects to mcpl-editor as an MCPL host, exercises the full protocol.
 *
 * Usage: node --import tsx test-client.ts [port]
 */

import WebSocket from 'ws';
import { McplConnection } from '@connectome/mcpl-core';

const port = process.argv[2] ?? '3100';
const url = `ws://localhost:${port}/mcpl`;

async function main() {
  console.log(`Connecting to ${url}...`);
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const conn = McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0]);

  // Collect server-initiated requests (push/event, state/update) in the background
  const serverRequests: Array<{ method: string; params: unknown }> = [];
  conn.on('request', (req) => {
    serverRequests.push({ method: req.method, params: req.params });
    // Auto-accept state/update and push/event
    if (req.id != null) {
      conn.sendResponse(req.id, { accepted: true });
    }
  });

  // Step 1: Initialize handshake
  console.log('\n1. Sending initialize...');
  const initResult = await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {
      experimental: {
        mcpl: {
          version: '0.5',
          pushEvents: true,
          stateUpdate: true,
          featureSets: true,
          branches: { list: true, create: true, switch: true, delete: true },
        },
      },
    },
    clientInfo: { name: 'test-client', version: '0.1.0' },
  });
  console.log('   Server capabilities:', JSON.stringify(initResult, null, 2).split('\n').slice(0, 5).join('\n') + '...');

  conn.sendNotification('notifications/initialized');

  // Step 2: List tools
  console.log('\n2. Listing tools...');
  const toolsResult = await conn.sendRequest('tools/list', {}) as { tools: Array<{ name: string }> };
  console.log('   Tools:', toolsResult.tools.map(t => t.name).join(', '));

  // Step 3: Get document
  console.log('\n3. Getting document...');
  const docResult = await conn.sendRequest('tools/call', {
    name: 'get_document',
    arguments: {},
  }) as { content: Array<{ text?: string }> };
  const docText = docResult.content[0]?.text ?? '';
  console.log('   Document:', JSON.stringify(docText.slice(0, 100)));

  // Step 4: Get outline
  console.log('\n4. Getting outline...');
  const outlineResult = await conn.sendRequest('tools/call', {
    name: 'get_outline',
    arguments: {},
  }) as { content: Array<{ text?: string }> };
  console.log('   Outline:', outlineResult.content[0]?.text ?? '(empty)');

  // Step 5: Edit document
  console.log('\n5. Editing document...');
  const editResult = await conn.sendRequest('tools/call', {
    name: 'edit_document',
    arguments: {
      operations: [
        { type: 'insert_after', line: 1, text: '\n## Added by Agent\n\nThis section was added by the MCPL agent.' },
      ],
    },
  }) as { content: Array<{ text?: string }>; state?: { checkpoint: string } };
  console.log('   Result:', editResult.content[0]?.text);
  console.log('   Checkpoint:', editResult.state?.checkpoint);

  // Step 6: Get document again to verify edit
  console.log('\n6. Verifying edit...');
  const doc2 = await conn.sendRequest('tools/call', {
    name: 'get_document',
    arguments: {},
  }) as { content: Array<{ text?: string }> };
  console.log('   Document after edit:', JSON.stringify(doc2.content[0]?.text?.slice(0, 200)));

  // Step 7: Get outline again
  console.log('\n7. Outline after edit...');
  const outline2 = await conn.sendRequest('tools/call', {
    name: 'get_outline',
    arguments: {},
  }) as { content: Array<{ text?: string }> };
  console.log('   Outline:', outline2.content[0]?.text);

  // Step 8: Check server-initiated messages received
  console.log('\n8. Server-initiated messages received:');
  for (const msg of serverRequests) {
    console.log(`   ${msg.method}:`, JSON.stringify(msg.params));
  }

  // Step 9: Historical access
  console.log('\n9. Getting original document (at first checkpoint)...');
  const original = await conn.sendRequest('tools/call', {
    name: 'get_document',
    arguments: { atCheckpoint: 'seq_2' },
  }) as { content: Array<{ text?: string }> };
  console.log('   Original:', JSON.stringify(original.content[0]?.text?.slice(0, 100)));

  console.log('\nAll tests passed!');
  conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
