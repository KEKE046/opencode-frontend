import { Hono } from "hono"
import { compress } from "hono/compress"
import { getMimeType } from "hono/utils/mime"
import { parseArgs } from "node:util"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

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

async function load(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(cfg, "utf8"))
  } catch {
    return {}
  }
}

async function save(data: Record<string, unknown>) {
  await fs.mkdir(path.dirname(cfg), { recursive: true })
  await fs.writeFile(cfg, JSON.stringify(data, null, 2))
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

// --- app ---

const app = new Hono()
  .use(compress())
  .use(async (c, next) => {
    const start = performance.now()
    await next()
    log(c.req.method, c.req.path, c.res.status, Math.round(performance.now() - start))
  })
  .get("/ui/settings", async (c) => c.json(await load()))
  .patch("/ui/settings", async (c) => {
    const patch = await c.req.json()
    const next = merge(await load(), patch)
    await save(next)
    return c.body(null, 204)
  })
  .get("/*", async (c) => {
    if (!assets) return c.text("opencode-gateway: no embedded assets (run build first)", 404)
    const key = c.req.path.replace(/^\//, "") || "index.html"
    const file = assets[key]
    if (file) {
      const mime = getMimeType(file) ?? "application/octet-stream"
      if (!mime.startsWith("text/html")) {
        c.header("Content-Type", mime)
        return c.body(new Uint8Array(await fs.readFile(file)))
      }
      const page = await html(file)
      c.header("Content-Security-Policy", page.csp)
      c.header("Content-Type", "text/html; charset=UTF-8")
      return c.body(page.body)
    }
    // SPA fallback: only for navigation requests (no file extension)
    if (/\.\w+$/.test(key)) return c.json({ error: "Not Found" }, 404)
    const index = assets["index.html"]
    if (!index) return c.json({ error: "Not Found" }, 404)
    const page = await html(index)
    c.header("Content-Security-Policy", page.csp)
    c.header("Content-Type", "text/html; charset=UTF-8")
    return c.body(page.body)
  })

// --- listen ---

Bun.serve({ fetch: app.fetch, port, hostname })
console.log(`opencode-gateway http://${hostname}:${port}`)
console.log(`config: ${cfg}`)
