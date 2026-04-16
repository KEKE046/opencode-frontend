import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

const gatewayEnabled = typeof document !== "undefined" && document.querySelector('meta[name="opencode-gateway"]')

// --- batch fetch for gateway mode ---

type Pending = {
  path: string
  headers: Record<string, string>
  resolve: (res: Response) => void
  reject: (err: unknown) => void
}

function createBatchFetch(base: string) {
  const basePath = new URL(base).pathname
  let queue: Pending[] | null = null

  async function flush(batch: Pending[]) {
    const items = batch.map((p) => ({ method: "GET", path: p.path, headers: p.headers }))
    const res = await fetch(`${base}/_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items),
    })
    if (!res.ok) {
      for (const p of batch) p.reject(new Error(`batch ${res.status}`))
      return
    }
    const results = (await res.json()) as Array<{
      status: number
      headers: Record<string, string>
      body: string
    }>
    for (let i = 0; i < batch.length; i++) {
      const r = results[i]
      if (!r) {
        batch[i].reject(new Error("missing batch result"))
        continue
      }
      const h = new Headers(r.headers ?? {})
      if (!h.has("content-type")) h.set("content-type", "application/json")
      batch[i].resolve(new Response(r.body ?? "", { status: r.status, statusText: "OK", headers: h }))
    }
  }

  return (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    const path = url.pathname.replace(basePath, "") + url.search

    // Only batch GET/HEAD
    if (input.method !== "GET" && input.method !== "HEAD") {
      ;(input as any).timeout = false
      return fetch(input)
    }

    // Don't batch SSE
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
        // Collect requests over a 10ms window so async bootstrap phases
        // across multiple workspaces merge into a single batch.
        setTimeout(() => {
          const batch = queue!
          queue = null
          if (batch.length === 1) {
            const req = new Request(`${base}${batch[0].path}`, { headers: input.headers })
            ;(req as any).timeout = false
            fetch(req).then(batch[0].resolve, batch[0].reject)
            return
          }
          flush(batch).catch((err) => {
            for (const p of batch) p.reject(err)
          })
        }, 10)
      }
      queue.push({ path, headers, resolve, reject })
    })
  }
}

// Shared batcher per gateway key
const batchers = new Map<string, (input: Request) => Promise<Response>>()

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

  let batcher: ((input: Request) => Promise<Response>) | undefined
  if (inGatewayMode) {
    if (!batchers.has(gatewayKey)) batchers.set(gatewayKey, createBatchFetch(baseUrl))
    batcher = batchers.get(gatewayKey)
  }

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl,
    fetch: (batcher ?? config.fetch) as typeof fetch | undefined,
  })
}
