import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

const gatewayEnabled = typeof document !== "undefined" && document.querySelector('meta[name="opencode-gateway"]')

// --- batch fetch for gateway mode ---
// Collects all GET/HEAD requests in the same microtask and sends them as a
// single POST /_batch to the gateway, which fans out to the backend in parallel.
// Non-GET requests and SSE streams bypass the batcher and go directly.

type Pending = {
  path: string
  headers: Record<string, string>
  resolve: (res: Response) => void
  reject: (err: unknown) => void
}

function createBatchFetch(base: string) {
  let queue: Pending[] | null = null

  async function flush(batch: Pending[]) {
    try {
      const items = batch.map((p) => ({ method: "GET", path: p.path, headers: p.headers }))
      const res = await fetch(`${base}/_batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      })
      if (!res.ok) {
        // Batch request itself failed — fall back to individual fetches
        await fallback(batch)
        return
      }
      const results = (await res.json()) as Array<{
        status: number
        headers: Record<string, string>
        body: unknown
      }>
      for (let i = 0; i < batch.length; i++) {
        const r = results[i]
        if (!r) {
          batch[i].reject(new Error("missing batch result"))
          continue
        }
        const h = new Headers(r.headers ?? {})
        if (!h.has("content-type")) h.set("content-type", "application/json")
        const body = r.body == null ? "null" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)
        batch[i].resolve(new Response(body, { status: r.status, statusText: "OK", headers: h }))
      }
    } catch {
      // Any parse/construction error — fall back to individual fetches
      await fallback(batch)
    }
  }

  async function fallback(batch: Pending[]) {
    await Promise.allSettled(
      batch.map(async (p) => {
        try {
          const res = await fetch(`${base}${p.path}`)
          p.resolve(res)
        } catch (err) {
          p.reject(err)
        }
      }),
    )
  }

  const basePath = new URL(base).pathname

  return (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    const path = url.pathname.replace(basePath, "") + url.search

    // Only batch GET/HEAD; pass through mutations, SSE, and WebSocket
    if (input.method !== "GET" && input.method !== "HEAD") {
      ;(input as any).timeout = false
      return fetch(input)
    }

    // Don't batch SSE event streams
    if (path.endsWith("/event") || path.endsWith("/sync-event")) {
      ;(input as any).timeout = false
      return fetch(input)
    }

    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}
      input.headers.forEach((v, k) => {
        if (!["host", "connection", "accept-encoding"].includes(k.toLowerCase())) headers[k] = v
      })

      if (!queue) {
        queue = []
        // Flush on next microtask — all synchronous .load() / .get() calls in
        // the same tick end up in a single batch
        queueMicrotask(() => {
          const batch = queue!
          queue = null
          if (batch.length === 1) {
            // Single request — skip batch overhead, send directly
            ;(input as any).timeout = false
            fetch(input).then(batch[0].resolve, batch[0].reject)
            return
          }
          void flush(batch)
        })
      }
      queue.push({ path, headers, resolve, reject })
    })
  }
}

export function createSdkForServer({
  server,
  gatewayKey,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
  gatewayKey?: string
}) {
  const inGatewayMode = gatewayEnabled && gatewayKey
  
  const auth = (() => {
    if (inGatewayMode) return // Gateway handles auth
    if (!server.password) return
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
    }
  })()

  const baseUrl = inGatewayMode ? `${location.origin}/s/${gatewayKey}` : server.url

  const batchedFetch = inGatewayMode ? createBatchFetch(baseUrl) : undefined

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl,
    fetch: (batchedFetch ?? config.fetch) as typeof fetch | undefined,
  })
}
