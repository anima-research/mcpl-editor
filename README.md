# mcpl-editor

A collaborative markdown editor that runs as an [MCPL](https://github.com/anima-research/mcpl) server. Humans write in a CodeMirror 6 web UI, AI agents connect via MCPL to observe changes, edit the document, and chat.

## Architecture

```
Browser (CodeMirror 6 + Chat)
    ↕ WebSocket /ws (Chronicle subscription sync)
Editor Server (Express + Chronicle store)
    ↕ WebSocket /mcpl (MCPL protocol)
Host / Agent (any MCPL host)
```

Single process serving:
- **`/`** — Vue + CodeMirror 6 editor with real-time sync and chat panel
- **`/ws`** — WebSocket for browser clients (editing + chat)
- **`/mcpl`** — WebSocket for MCPL agent connections
- **`/api/*`** — REST API for document, checkpoint, and record queries
- **`/health`** — Health check endpoint

## Data Model

Every edit is a [Chronicle](https://github.com/anima-research/chronicle) record. Chronicle assigns a monotonic sequence number — this is the canonical operation order. No OT/CRDT needed.

| Record Type | Purpose |
|-------------|---------|
| `doc.op` | Character-level edit (full document text + clientId) |
| `doc.checkpoint` | Full document snapshot (every 100 ops) |
| `chat.message` | Chat messages (human or agent) |

Browser clients subscribe to records via WebSocket. New clients catch up from the latest checkpoint.

## MCPL Features

| Feature Set | Capabilities |
|-------------|-------------|
| `editor.observe` | `pushEvents`, `stateUpdate` — get notified of changes |
| `editor.read` | `tools` — `get_document`, `get_outline` |
| `editor.write` | `tools` — `edit_document` (with rollback support) |
| `editor.chat` | `channels.publish`, `channels.observe` — chat with the human |
| `editor.branches` | `branches` — manage host branches from the editor UI |

The editor uses **opaque checkpoints** (`seq_N`) — it manages its own Chronicle store and only sends checkpoint references to the host via `state/update`.

## Running Locally

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Build the UI
npm run build

# Start the server
npm start -- --port 3100 --store ./data/my-doc --seed "# Hello World"

# Or with defaults (port 3100, store ./data/editor-store)
npm start
```

Open `http://localhost:3100` in your browser. Connect an MCPL host to `ws://localhost:3100/mcpl`.

## Development

```bash
# Terminal 1: backend (auto-reloads via tsx)
npm run dev -- --port 3100 --store ./data/dev --seed "# Dev Document"

# Terminal 2: frontend with hot reload (proxies API/WS to backend)
npm run dev:ui
```

The Vite dev server runs on port 5173 and proxies `/api` and `/ws` to the backend on port 3100.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP server port (Railway sets this automatically) |
| `STORE_PATH` | `./data/editor-store` | Chronicle store directory |

CLI args (`--port`, `--store`, `--seed`) take precedence over defaults but `PORT` env var takes precedence over `--port`.

## Deploying to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

1. Connect this repo to a Railway project
2. Railway will auto-detect Node.js, run `npm install` + `npm run build` + `npm start`
3. Set `STORE_PATH` to a persistent volume mount (e.g., `/data/editor-store`)
4. The health check endpoint is `/health`

**Note:** The `file:` dependencies (`@connectome/mcpl-core`, `chronicle`) require these sibling repos to be available at build time. For Railway, either:
- Use a monorepo structure with all deps
- Publish the packages to npm
- Use a Dockerfile that clones the deps

## Dockerfile (alternative deployment)

```dockerfile
FROM node:20-slim

WORKDIR /app

# Clone dependencies (until published to npm)
RUN apt-get update && apt-get install -y git
RUN git clone https://github.com/anima-research/mcpl-core-ts.git /deps/mcpl-core-ts \
 && cd /deps/mcpl-core-ts && npm install && npx tsc
RUN git clone https://github.com/anima-research/chronicle.git /deps/chronicle \
 && cd /deps/chronicle && npm install

# Copy app
COPY package*.json ./
RUN sed -i 's|file:../mcpl-core-ts|file:/deps/mcpl-core-ts|' package.json \
 && sed -i 's|file:../chronicle|file:/deps/chronicle|' package.json
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3100
CMD ["npm", "start"]
```

## Dependencies

| Package | Source | Purpose |
|---------|--------|---------|
| [@connectome/mcpl-core](https://github.com/anima-research/mcpl-core-ts) | local | MCPL protocol types + WebSocket transport |
| [chronicle](https://github.com/anima-research/chronicle) | local | Branchable record store with subscriptions |
| express | npm | HTTP server |
| ws | npm | WebSocket server |
| CodeMirror 6 | npm | Browser-side markdown editor |
| Vue 3 | npm | Frontend framework |

## Related

- [MCPL Spec](https://github.com/anima-research/mcpl) — MCP Live protocol specification
- [Agent Framework](https://github.com/anima-research/agent-framework) — Host-side MCPL implementation
- [Chronicle](https://github.com/anima-research/chronicle) — Branchable, time-traveling record store
