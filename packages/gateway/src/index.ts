import { Hono } from "hono"
import { compress } from "hono/compress"
import { getMimeType } from "hono/utils/mime"
import { parseArgs } from "node:util"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"

// --- cli ---

const args = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    host: { type: "string", short: "h" },
  },
  strict: false,
})

const cfg = args.values.config ?? path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"),
  "opencode",
  "webui.json",
)
const port = Number(args.values.port) || 3000
const hostname = args.values.host ?? "127.0.0.1"

// --- assets ---

const assets: Record<string, string> | null = await import("gateway-assets.gen.ts")
  .then((m) => m.default as Record<string, string>)
  .catch(() => null)

// --- storage ---

type ServerInfo = {
  url: string
  name?: string
  username?: string
  password?: string
}

type StorageData = {
  _ts?: number
  servers?: Record<string, ServerInfo>
  [key: string]: unknown
}

async function load(): Promise<StorageData> {
  try {
    return JSON.parse(await fs.readFile(cfg, "utf8"))
  } catch {
    return {}
  }
}

// Serialize writes to prevent TOCTOU races
let pending: Promise<void> = Promise.resolve()

async function save(data: StorageData) {
  await fs.mkdir(path.dirname(cfg), { recursive: true })
  await fs.writeFile(cfg, JSON.stringify(data, null, 2))
}

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = pending.then(fn, fn)
  pending = result.then(() => {}, () => {})
  return result
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k]
      continue
    }
    const prev = out[k]
    if (typeof v === "object" && !Array.isArray(v) && typeof prev === "object" && prev && !Array.isArray(prev))
      out[k] = merge(prev as Record<string, unknown>, v as Record<string, unknown>)
    else out[k] = v
  }
  return out
}

// --- server registry ---

function generateKey(): string {
  return randomBytes(6).toString("base64url")
}

async function checkHealth(url: string, username?: string, password?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (username || password) {
      const token = Buffer.from(`${username || ""}:${password || ""}`).toString("base64")
      headers.Authorization = `Basic ${token}`
    }
    const res = await fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

function authHeader(server: ServerInfo): Record<string, string> {
  if (!server.username && !server.password) return {}
  const token = Buffer.from(`${server.username || ""}:${server.password || ""}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

// --- logging ---

function log(method: string, path: string, status: number, ms: number) {
  const ts = new Date().toISOString().slice(11, 23)
  const color = status < 400 ? "\x1b[32m" : "\x1b[31m"
  console.log(`${ts} ${color}${method}\x1b[0m ${path} ${status} ${ms}ms`)
}

// --- html injection ---

async function html(file: string) {
  const raw = await fs.readFile(file, "utf8")
  const body = raw.replace("<head>", '<head><meta name="opencode-gateway" content="true">')
  const script = body.match(/<script\b[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
  const hash = script ? createHash("sha256").update(script[2]).digest("base64") : ""
  const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
  return { body, csp }
}

// --- SSE gzip stream ---
// Wraps a backend SSE ReadableStream with node:zlib gzip + Z_SYNC_FLUSH so each
// event is flushed immediately. The gateway sets Content-Encoding: gzip and the
// browser decompresses transparently — no client changes required.

function gzipSseStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gz = zlib.createGzip({ level: 1, flush: zlib.constants.Z_SYNC_FLUSH })
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  gz.on("data", (chunk: Buffer) => {
    writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  })
  gz.on("end", () => writer.close())
  gz.on("error", (e) => writer.abort(e))

  ;(async () => {
    const reader = upstream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { gz.end(); break }
        gz.write(Buffer.from(value))
        // Z_SYNC_FLUSH: flush after each upstream chunk so events reach the client immediately
        await new Promise<void>((res, rej) => gz.flush(zlib.constants.Z_SYNC_FLUSH, (e) => e ? rej(e) : res()))
      }
    } catch (e) {
      gz.destroy(e as Error)
      writer.abort(e)
    }
  })()

  return readable
}

// --- proxy response TTL cache ---
// Large rarely-changing GET responses (provider list, global config) are cached
// in memory for TTL ms. The ETag is an MD5 of the body for client-side 304 support.

const CACHE_TTL_MS = 30_000
type CacheEntry = { body: string; etag: string; at: number; ct: string }
const proxyCache = new Map<string, CacheEntry>()

const CACHED_PATHS = new Set(["/provider", "/global/config"])

function proxyKey(serverKey: string, path: string) {
  return `${serverKey}:${path}`
}

// --- session single-GET field stripping (plan B) ---
// GET /session/:id (no trailing path, no query except directory/workspace)
// Returns full Session.Info including summary.diffs, revert.snapshot, revert.diff.
// Strip those large fields before forwarding to the client.

const SESSION_SINGLE_RE = /^\/session\/[^/]+$/

function stripSessionInfo(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const s = body as Record<string, unknown>
  const out: Record<string, unknown> = { ...s }
  if (out.summary && typeof out.summary === "object") {
    const { diffs: _, ...rest } = out.summary as Record<string, unknown>
    out.summary = rest
  }
  if (out.revert && typeof out.revert === "object") {
    const { snapshot: _s, diff: _d, ...rest } = out.revert as Record<string, unknown>
    out.revert = rest
  }
  return out
}

// --- app ---

const app = new Hono()
  .use(async (c, next) => {
    const isProxy = c.req.path.startsWith("/s/")
    const isSse = isProxy && (c.req.path.endsWith("/event") || c.req.path.endsWith("/sync-event"))
    if (isSse) return next()
    return compress()(c, next)
  })
  .use(async (c, next) => {
    const start = performance.now()
    await next()
    log(c.req.method, c.req.path, c.res.status, Math.round(performance.now() - start))
  })
  .get("/settings", async (c) => {
    const data = await load()
    // Exclude server registry (contains credentials) from settings response
    const { servers: _, ...safe } = data
    const tag = `"${createHash("md5").update(JSON.stringify(safe)).digest("hex")}"`
    if (c.req.header("if-none-match") === tag) return c.body(null, 304)
    c.header("ETag", tag)
    return c.json(safe)
  })
  .patch("/settings", async (c) => {
    const patch = await c.req.json() as Record<string, unknown>
    // Prevent injection of server registry via settings
    delete patch.servers
    delete patch._ts
    await serialized(async () => {
      const next = merge(await load(), patch) as StorageData
      next._ts = Date.now()
      await save(next)
    })
    return c.body(null, 204)
  })
  .post("/gateway/servers", async (c) => {
    const body = await c.req.json<{ url: string; name?: string; username?: string; password?: string }>()
    if (!body.url) return c.json({ error: "url required" }, 400)
    
    const healthy = await checkHealth(body.url, body.username, body.password)
    if (!healthy) return c.json({ error: "server unreachable or unhealthy" }, 503)
    
    const key = generateKey()
    await serialized(async () => {
      const data = await load()
      const servers = data.servers ?? {}
      servers[key] = {
        url: body.url.replace(/\/+$/, ""),
        name: body.name,
        username: body.username,
        password: body.password,
      }
      data.servers = servers
      data._ts = Date.now()
      await save(data)
    })
    
    return c.json({ key, name: body.name, healthy: true })
  })
  .get("/gateway/servers", async (c) => {
    const data = await load()
    const servers = data.servers ?? {}
    const list = Object.entries(servers).map(([key, info]) => ({
      key,
      name: info.name,
      healthy: true,
    }))
    return c.json(list)
  })
  .delete("/gateway/servers/:key", async (c) => {
    const key = c.req.param("key")
    return serialized(async () => {
      const data = await load()
      if (!data.servers?.[key]) return c.json({ error: "server not found" }, 404)
      delete data.servers[key]
      data._ts = Date.now()
      await save(data)
      return c.body(null, 204)
    })
  })
  .patch("/gateway/servers/:key", async (c) => {
    const key = c.req.param("key")
    const body = await c.req.json<{ url?: string; name?: string; username?: string; password?: string }>()
    
    return serialized(async () => {
      const data = await load()
      const server = data.servers?.[key]
      if (!server) return c.json({ error: "server not found" }, 404)
      
      const url = body.url ?? server.url
      const username = body.username ?? server.username
      const password = body.password ?? server.password
      
      const healthy = await checkHealth(url, username, password)
      if (!healthy) return c.json({ error: "server unreachable or unhealthy" }, 503)
      
      data.servers![key] = {
        url: url.replace(/\/+$/, ""),
        name: body.name ?? server.name,
        username,
        password,
      }
      data._ts = Date.now()
      await save(data)
      
      return c.json({ key, name: data.servers![key].name, healthy: true })
    })
  })
  .all("/s/:key/*", async (c) => {
    const key = c.req.param("key")
    const data = await load()
    const server = data.servers?.[key]
    if (!server) return c.json({ error: "server not found" }, 404)
    
    // Preserve query string
    const url = new URL(c.req.url)
    const targetPath = c.req.path.replace(`/s/${key}`, "")
    const targetUrl = server.url + targetPath + url.search
    
    const isSse = targetPath.endsWith("/event") || targetPath.endsWith("/sync-event")
    // Plan B: strip large fields from single-session GET response
    const isSessionSingle = c.req.method === "GET" && SESSION_SINGLE_RE.test(targetPath)
    // TTL cache for large rarely-changing responses (/provider, /global/config)
    const isCacheable = c.req.method === "GET" && CACHED_PATHS.has(targetPath)

    // Serve from cache if fresh (ETag 304 support included)
    if (isCacheable) {
      const ckey = proxyKey(key, targetPath)
      const cached = proxyCache.get(ckey)
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        if (c.req.header("if-none-match") === cached.etag) return c.body(null, 304)
        c.header("ETag", cached.etag)
        c.header("Content-Type", cached.ct)
        return c.body(cached.body)
      }
    }

    const hopByHop = new Set(["host", "connection", "keep-alive", "transfer-encoding"])
    if (isSse) hopByHop.add("accept-encoding")
    const headers = new Headers()
    for (const [name, value] of Object.entries(c.req.header())) {
      if (hopByHop.has(name.toLowerCase())) continue
      headers.set(name, value)
    }
    const auth = authHeader(server)
    if (auth.Authorization) headers.set("Authorization", auth.Authorization)
    
    try {
      const res = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        redirect: "manual",
      })
      
      const responseHeaders = new Headers()
      for (const [name, value] of res.headers.entries()) {
        if (["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"].includes(name.toLowerCase())) continue
        responseHeaders.set(name, value)
      }

      // Store in TTL cache
      if (isCacheable && res.ok) {
        const body = await res.text()
        const etag = `"${createHash("md5").update(body).digest("hex")}"`
        const ct = res.headers.get("content-type") ?? "application/json"
        proxyCache.set(proxyKey(key, targetPath), { body, etag, at: Date.now(), ct })
        if (c.req.header("if-none-match") === etag) return c.body(null, 304)
        c.header("ETag", etag)
        c.header("Content-Type", ct)
        return c.body(body)
      }

      // Plan B: strip summary.diffs / revert.snapshot / revert.diff
      if (isSessionSingle && res.ok) {
        const json = await res.json()
        return new Response(JSON.stringify(stripSessionInfo(json)), {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      }

      // SSE gzip: compress the event stream so the browser decompresses transparently.
      // no-transform is removed so the browser accepts Content-Encoding: gzip.
      if (isSse && res.ok && res.body) {
        responseHeaders.set("Content-Encoding", "gzip")
        const cc = responseHeaders.get("Cache-Control") ?? ""
        responseHeaders.set("Cache-Control", cc.replace(/,?\s*no-transform/gi, "").trim() || "no-cache")
        return new Response(gzipSseStream(res.body), {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      })
    } catch (err) {
      return c.json({ error: "proxy failed" }, 502)
    }
  })
  .get("/*", async (c) => {
    if (!assets) return c.text("opencode-gateway: no embedded assets (run build first)", 404)
    const key = c.req.path.replace(/^\//, "") || "index.html"
    const file = assets[key]
    if (file) {
      const mime = getMimeType(file) ?? "application/octet-stream"
      if (!mime.startsWith("text/html")) {
        c.header("Content-Type", mime)
        c.header("Cache-Control", "public, max-age=31536000, immutable")
        return c.body(new Uint8Array(await fs.readFile(file)))
      }
      const page = await html(file)
      c.header("Content-Security-Policy", page.csp)
      c.header("Content-Type", "text/html; charset=UTF-8")
      c.header("Cache-Control", "no-cache")
      return c.body(page.body)
    }
    // SPA fallback: only for navigation requests (no file extension)
    if (/\.\w+$/.test(key)) return c.json({ error: "Not Found" }, 404)
    const index = assets["index.html"]
    if (!index) return c.json({ error: "Not Found" }, 404)
    const page = await html(index)
    c.header("Content-Security-Policy", page.csp)
    c.header("Content-Type", "text/html; charset=UTF-8")
    c.header("Cache-Control", "no-cache")
    return c.body(page.body)
  })

// --- listen ---

Bun.serve({
  port,
  hostname,
  idleTimeout: 0,
  fetch(req, server) {
    const url = new URL(req.url)
    
    // WebSocket upgrade for proxy paths
    if (req.headers.get("upgrade") === "websocket" && url.pathname.startsWith("/s/")) {
      const match = url.pathname.match(/^\/s\/([^/]+)(\/.+)$/)
      if (!match) return new Response("Invalid path", { status: 400 })
      
      const [, key, targetPath] = match
      const success = server.upgrade(req, {
        data: { key, targetPath, search: url.search },
      })
      return success ? undefined : new Response("WebSocket upgrade failed", { status: 500 })
    }
    
    return app.fetch(req)
  },
  websocket: {
    async open(ws) {
      const { key, targetPath, search } = ws.data as { key: string; targetPath: string; search: string }
      const data = await load()
      const server = data.servers?.[key]
      
      if (!server) {
        ws.close(1008, "server not found")
        return
      }
      
      // Preserve query params (e.g. ?directory=...&cursor=...)
      const wsUrl = server.url.replace(/^http/, "ws") + targetPath + (search || "")
      const queue: (string | Buffer)[] = []
      const backendWs = new WebSocket(wsUrl, {
        headers: authHeader(server),
      })
      
      backendWs.onopen = () => {
        // Flush buffered messages
        for (const msg of queue) backendWs.send(msg)
        queue.length = 0
        ws.data.backendWs = backendWs
      }
      
      backendWs.onmessage = (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(event.data)
        }
      }
      
      backendWs.onerror = () => {
        ws.close(1011, "backend error")
      }
      
      backendWs.onclose = (event) => {
        ws.close(event.code, event.reason)
      }
      
      ws.data.queue = queue
    },
    message(ws, msg) {
      const backendWs = ws.data.backendWs as WebSocket | undefined
      if (backendWs && backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(msg)
      } else {
        // Buffer until backend connects
        const queue = ws.data.queue as (string | Buffer)[] | undefined
        if (queue) queue.push(msg)
      }
    },
    close(ws, code, reason) {
      const backendWs = ws.data.backendWs as WebSocket | undefined
      if (backendWs) {
        backendWs.close(code, reason)
      }
    },
  },
})
console.log(`opencode-gateway http://${hostname}:${port}`)
console.log(`config: ${cfg}`)
