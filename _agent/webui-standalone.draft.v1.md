# opencode-gateway: Standalone WebUI 服务

## 定位

`opencode-gateway` 是一个独立的轻量二进制，用 `bun build --compile` 编译为单文件。
它做两件事：

1. 托管 webui 静态文件（SPA fallback）
2. 持久化 UI 配置（`GET/PATCH /ui/settings`）

用户通过 webui 连接远程 opencode server，gateway 本身不包含 opencode 核心逻辑。

---

## 包结构

新建 `packages/gateway`，极简：

```
packages/gateway/
  ├── src/
  │   └── index.ts              # 全部服务端代码（~80 行）
  ├── script/
  │   └── build.ts              # 构建：vite build app → 生成嵌入 → bun build --compile
  ├── package.json
  └── tsconfig.json
```

不建独立 routes/storage 目录 — 代码量太少，全放一个文件。

### package.json

```json
{
  "name": "@opencode-ai/gateway",
  "private": true,
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun run script/build.ts"
  },
  "dependencies": {
    "hono": "catalog:"
  }
}
```

---

## src/index.ts

整个服务端约 80 行：

```ts
import { Hono } from "hono"
import { getMimeType } from "hono/utils/mime"
import fs from "node:fs/promises"
import path from "node:path"

// 构建时生成的虚拟模块，与 opencode 的 opencode-web-ui.gen.ts 同模式
// @ts-expect-error generated
import assets from "gateway-assets.gen.ts"

const dir = process.env.WEBUI_CONFIG_DIR
  ?? path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME!, ".config"),
    "opencode",
  )
const file = path.join(dir, "webui.json")

// --- storage ---

async function load(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return {}
  }
}

async function save(data: Record<string, unknown>) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2))
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue }
    const prev = out[k]
    if (typeof v === "object" && !Array.isArray(v) && typeof prev === "object" && prev && !Array.isArray(prev))
      out[k] = merge(prev as Record<string, unknown>, v as Record<string, unknown>)
    else
      out[k] = v
  }
  return out
}

// --- app ---

const app = new Hono()
  .get("/ui/settings", async (c) => c.json(await load()))
  .patch("/ui/settings", async (c) => {
    const patch = await c.req.json()
    const next = merge(await load(), patch)
    await save(next)
    return c.json(next)
  })
  .get("/*", async (c) => {
    const key = c.req.path.replace(/^\//, "") || "index.html"
    const match = (assets as Record<string, string>)[key]
      ?? (assets as Record<string, string>)["index.html"]
    if (!match) return c.json({ error: "Not Found" }, 404)
    const mime = getMimeType(match) ?? "application/octet-stream"
    c.header("Content-Type", mime)
    return c.body(new Uint8Array(await fs.readFile(match)))
  })

// --- listen ---

const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOST || "127.0.0.1"

Bun.serve({ fetch: app.fetch, port, hostname })
console.log(`opencode-gateway listening on http://${hostname}:${port}`)
```

要点：
- `gateway-assets.gen.ts` 是构建时生成的虚拟模块，与 opencode 的 `opencode-web-ui.gen.ts` 完全同模式
- settings API 在 static catch-all 之前，优先匹配
- 存储就是一个 JSON 文件，`merge()` 做深度合并，`null` 值表示删除
- 无 auth（localhost），需要时加 `GATEWAY_PASSWORD` env + basic auth 中间件

---

## script/build.ts

复用 opencode `build.ts:56-77` 的嵌入模式：

```ts
import path from "node:path"
import { $ } from "bun"

const root = path.resolve(import.meta.dirname, "../../..")
const app = path.join(root, "packages/app")
const dist = path.join(app, "dist")
const dir = path.resolve(import.meta.dirname, "..")

// 1. build frontend
await $`bun run --cwd ${app} build`

// 2. generate asset map (同 opencode createEmbeddedWebUIBundle 逻辑)
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
  .map((f) => f.replaceAll("\\", "/"))
  .sort()

const imports = files.map((f, i) => {
  const spec = path.relative(dir, path.join(dist, f)).replaceAll("\\", "/")
  return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
})
const entries = files.map((f, i) => `  ${JSON.stringify(f)}: file_${i},`)
const gen = [...imports, `export default {`, ...entries, `}`].join("\n")

// 3. compile single binary
await $`rm -rf dist && mkdir -p dist`

await Bun.build({
  entrypoints: ["./src/index.ts", "gateway-assets.gen.ts"],
  files: { "gateway-assets.gen.ts": gen },
  compile: {
    target: `bun-${process.platform}-${process.arch}` as any,
    outfile: "dist/opencode-gateway",
  },
})

console.log("built dist/opencode-gateway")
```

### 使用

```bash
# 编译
bun run --cwd packages/gateway build

# 运行
./packages/gateway/dist/opencode-gateway

# dev 模式（先 build app，再直接 bun run）
bun run --cwd packages/app build
bun run --cwd packages/gateway dev
```

dev 模式下 `gateway-assets.gen.ts` import 会失败。
可在 `src/index.ts` 中 catch 后 fallback 到代理 `app.opencode.ai`
（与 opencode UIRoutes 的 proxy 模式一致）。

---

## 配置持久化

### 存储

文件：`~/.config/opencode/webui.json`（`WEBUI_CONFIG_DIR` 可覆盖）

```json
{
  "settings": {
    "general": { "autoSave": true, "followup": "steer" },
    "appearance": { "fontSize": 14, "mono": "", "sans": "" },
    "keybinds": {},
    "notifications": { "agent": true, "permissions": true, "errors": false },
    "sounds": { "agentEnabled": true, "agent": "staplebops-01" }
  },
  "model": { "hidden": {}, "recent": [], "variant": {} },
  "language": "en"
}
```

### API

```
GET  /ui/settings     → 200 { 全量 }
PATCH /ui/settings    → 200 { 合并后全量 }
  body: 部分 JSON，深度合并。值为 null 表示删除。
```

### 前端集成

`packages/app/src/utils/persist.ts` 新增 storage backend：

```ts
function serverStorage(base: string): AsyncStorage {
  return {
    async getItem(key) {
      const res = await fetch(`${base}/ui/settings`)
      const data = await res.json()
      return JSON.stringify(data[key] ?? null)
    },
    async setItem(key, value) {
      await fetch(`${base}/ui/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: JSON.parse(value) }),
      })
    },
    async removeItem(key) {
      await fetch(`${base}/ui/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: null }),
      })
    },
  }
}
```

`persisted()` 已支持 `AsyncStorage`（桌面端路径），无需改上层 context。

### 读写策略

```
写：localStorage 即时写（optimistic）→ 异步 PATCH server（debounce 500ms）
读：先读 localStorage（无延迟）→ 异步 GET server → server 更新则合并
```

### 模式判断

`entry.tsx` 已区分场景。扩展为：
- `location.origin` 能响应 `/ui/settings` → standalone 模式，用 serverStorage
- `location.origin` 能响应 `/global/health` → embedded 模式（opencode server）
- 都不可达 → 纯 localStorage fallback

---

## 部署

| 方式 | 命令 | 场景 |
|------|------|------|
| 直接运行 | `./opencode-gateway` | 个人本地 |
| Docker | `docker run -p 3000:3000 -v config:/data opencode-gateway` | team / 服务器 |
| systemd | `ExecStart=/usr/local/bin/opencode-gateway` | 长驻服务 |

### Dockerfile

```dockerfile
FROM oven/bun:1-slim AS build
WORKDIR /src
COPY . .
RUN bun install && bun run --cwd packages/gateway build

FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/packages/gateway/dist/opencode-gateway /usr/local/bin/
EXPOSE 3000
VOLUME /data
ENV WEBUI_CONFIG_DIR=/data
ENTRYPOINT ["opencode-gateway"]
```

编译后二进制约 30-50MB（Bun runtime + 前端资产），无需额外 runtime。

---

## 与 opencode 构建的对比

| | opencode | opencode-gateway |
|---|---|---|
| 入口 | `packages/opencode/src/index.ts` | `packages/gateway/src/index.ts` |
| 嵌入前端 | `opencode-web-ui.gen.ts` | `gateway-assets.gen.ts` |
| 编译 | `Bun.build({ compile })` | `Bun.build({ compile })` |
| 代码量 | ~50k 行 | ~80 行 |
| 依赖 | Effect, Drizzle, AI SDK, ... | hono |
| 功能 | AI agent 全栈 | 静态文件 + settings KV |

完全复用已验证的 Bun 嵌入 + 编译模式，构建脚本逻辑约 30 行。

---

## 参考文件

| 文件 | 说明 |
|------|------|
| `packages/opencode/script/build.ts:56-77` | 前端嵌入生成（`createEmbeddedWebUIBundle`） |
| `packages/opencode/src/server/ui/index.ts` | 嵌入式静态文件服务 + SPA fallback |
| `packages/opencode/src/server/adapter.bun.ts` | `Bun.serve` 适配器 |
| `packages/app/src/utils/persist.ts` | 前端持久化层 |
| `packages/app/src/entry.tsx:100-111` | 服务器 URL 判断 |
