# Architecture

Muse uses a pnpm workspace monorepo.

```txt
apps/
  desktop/        Tauri desktop client for macOS and Windows
  server/         Node.js backend service

packages/
  shared/         Shared TypeScript types, schemas, and constants
  model-router/   Server-side model provider routing
```

Future clients can be added as:

```txt
apps/
  mobile/         iOS and Android client
  miniapp/        WeChat Mini Program client
```
