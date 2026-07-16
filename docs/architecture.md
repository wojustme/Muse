# Architecture

Muse uses a pnpm workspace monorepo.

```txt
apps/
  desktop/        Tauri desktop client for macOS and Windows
  mobile/         Tauri mobile client for iOS and Android
  server/         Node.js backend service

packages/
  shared/         Shared TypeScript types, schemas, and constants
  api-client/     Shared browser-compatible API client
  model-router/   Server-side model provider routing
```

Future clients can be added as:

```txt
apps/
  miniapp/        WeChat Mini Program client
```
