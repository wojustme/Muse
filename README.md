# Muse

Muse is a desktop-first AI chat application that will evolve into a local AI agent.

## Stack

- Desktop: Tauri v2 + React + TypeScript + Vite
- Server: Node.js + Fastify + Vercel AI SDK
- Package manager: pnpm workspace
- First memory layer: session-level message persistence

## Development

```bash
pnpm install
pnpm dev:server
pnpm dev:desktop
```

The first milestone is a macOS desktop chat app backed by a local Node.js server.
