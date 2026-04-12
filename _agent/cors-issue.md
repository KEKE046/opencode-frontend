# CORS Issue: Frontend Dev Server → Remote Backend

## Problem

When running the frontend dev server (`bun run dev -- --port 4444`) and connecting to a remote backend (e.g. `http://100.64.0.2:4096`), browser blocks responses due to CORS.

The request to `http://100.64.0.2:4096/global/health` returns 200 OK, but the browser refuses to expose the response because the `Access-Control-Allow-Origin` header is missing or doesn't match the frontend's origin.

## Root Cause

The backend CORS middleware (`packages/opencode/src/server/middleware.ts:68-83`) only allows:

- `http://localhost:*`
- `http://127.0.0.1:*`
- `tauri://localhost`, `http(s)://tauri.localhost`
- `https://*.opencode.ai`
- Explicitly passed `--cors` origins (exact match only)

When the frontend is accessed via a non-localhost address (e.g. `http://100.64.0.2:4444`), the Origin header doesn't match any allowed pattern, so CORS blocks the response.

The `--cors` flag only supports exact origin strings (`opts?.cors?.includes(input)`), no wildcard `*` support.

## Current Workaround

Start the backend with the frontend origin explicitly allowed:

```bash
opencode serve --cors http://100.64.0.2:4444
```

Or add to opencode global config:

```json
{
  "server": {
    "cors": ["http://100.64.0.2:4444"]
  }
}
```

## Potential Solutions

### A. Vite Dev Proxy (frontend-only fix)

Add a proxy in `packages/app/vite.config.ts` so the frontend routes API requests through the Vite dev server, avoiding CORS entirely. Challenge: the SDK uses absolute URLs (`server.url`), so this requires changes to how the SDK constructs request URLs.

### B. Backend Feature Request

Request `opencode serve` to support `--cors "*"` for development use cases, or auto-allow private/LAN IP ranges.

### C. Hybrid: Relative URL Mode for SDK

Add an option for the SDK to use relative URLs when the server is proxied through the same origin. Combined with a Vite proxy, this eliminates CORS without backend changes.

## Status

Parked. Using workaround (explicit `--cors` flag) for now.
