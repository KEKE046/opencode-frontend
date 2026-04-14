# Gateway 性能优化记录

## 背景

Gateway 作为反向代理时，浏览器与后端之间的所有流量都经过 gateway。优化目标是在不改动 `packages/opencode` 的前提下，尽量减少传输量，提升响应速度。

## 已实施的优化

### 1. REST 响应压缩

**文件**：`packages/gateway/src/index.ts`

非 SSE 路径启用 Hono `compress()` 中间件，SSE 路径跳过（压缩会缓冲 chunk，延迟事件投递）。

```ts
.use(async (c, next) => {
  const isProxy = c.req.path.startsWith("/s/")
  const isSse = isProxy && (c.req.path.endsWith("/event") || c.req.path.endsWith("/sync-event"))
  if (isSse) return next()
  return compress()(c, next)
})
```

保留 `Accept-Encoding` 头转发给后端（非 SSE），后端会压缩响应，Bun fetch 自动解压后 gateway 再压缩。SSE 路径仍去掉 `Accept-Encoding`，避免后端压缩 SSE。

### 2. 静态资源长期缓存

**文件**：`packages/gateway/src/index.ts`

Vite 打包的非 HTML 文件（JS/CSS/字体等）都带 content hash，设置永久缓存：

```
Cache-Control: public, max-age=31536000, immutable
```

判断条件：`!mime.startsWith("text/html")`（所有 Vite 产物非 HTML 都是 immutable）。

`index.html` 和 SPA fallback 设置 `Cache-Control: no-cache`。

### 3. SSE 流级别 gzip（Z_SYNC_FLUSH）

**文件**：`packages/gateway/src/index.ts`

使用 `node:zlib.createGzip({ level: 1, flush: Z_SYNC_FLUSH })` 对 SSE 流进行实时压缩：

- 每个 upstream chunk 写入 gz 后立即调用 `gz.flush(Z_SYNC_FLUSH, cb)`，确保事件即时到达浏览器
- 设置 `Content-Encoding: gzip`，移除 `Cache-Control` 中的 `no-transform`
- 浏览器 fetch 自动透明解压，客户端代码**无需任何改动**
- 跨事件共享 LZ77 字典，压缩率优于逐事件独立压缩

**效果**：`message.part.updated` 事件（含大型 tool output）压缩率 ~98%；整体 SSE 流量减少 70-98%。

**实现注意事项**：
- 所有错误必须被吞掉（`.catch(() => {})`），否则未捕获的 Promise rejection 会导致进程崩溃
- `gz.once("error")` 调用 `writer.close().catch(() => {})` 而非 `writer.abort()`
- async pump 用 `void (async () => { ... })()`，防止顶层 rejection

```ts
function gzipSseStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const gz = zlib.createGzip({ level: 1, flush: zlib.constants.Z_SYNC_FLUSH })
  const ts = new TransformStream<Uint8Array, Uint8Array>()
  const writer = ts.writable.getWriter()

  gz.on("data", (chunk: Buffer) => {
    writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)).catch(() => {})
  })
  gz.once("end", () => { writer.close().catch(() => {}) })
  gz.once("error", () => { writer.close().catch(() => {}) })

  void (async () => {
    const reader = upstream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { gz.end(); return }
        gz.write(Buffer.from(value))
        await new Promise<void>((res) => gz.flush(zlib.constants.Z_SYNC_FLUSH, () => res()))
      }
    } catch {
      try { gz.destroy() } catch {}
      try { writer.close() } catch {}
    }
  })()

  return ts.readable
}
```

### 4. 单条 session GET 字段裁剪

**文件**：`packages/gateway/src/index.ts`

`GET /session/:id`（单条，无后续路径）返回完整 `Session.Info`，包含 `summary.diffs`、`revert.snapshot`、`revert.diff`。这些字段在列表视图已被剥离，但单条接口没有处理。

Gateway 拦截后裁剪：

```ts
const SESSION_SINGLE_RE = /^\/session\/[^/]+$/

function stripSessionInfo(body: unknown): unknown {
  const s = body as Record<string, unknown>
  const out = { ...s }
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
```

### 5. 常用 GET 端点 TTL 内存缓存

**文件**：`packages/gateway/src/index.ts`

以下端点数据变化频率低，缓存后多个客户端共享同一份响应：

| 端点 | TTL | 说明 |
|---|---|---|
| `GET /provider` | 30s | 所有 provider + 模型列表，约 180kB |
| `GET /global/config` | 30s | 全局配置含内置 agent prompt，约 147kB |
| `GET /command` | 60s | 命令列表，几乎不变 |

缓存条目同时保存 `X-Next-Cursor` 头（分页接口需要），并支持 ETag/304 响应避免重复传输响应体。

**注意**：消息列表（`GET /session/:id/message`）不缓存，因为：
- 消息随 AI 回复持续更新
- `X-Next-Cursor` + `complete` 状态被客户端用于判断是否可以加载更多，缓存错误状态会导致 `loadMore` 永久失效

### 6. 预取参数收紧

**文件**：`packages/app/src/pages/layout.tsx`

| 参数 | 改动前 | 改动后 | 说明 |
|---|---|---|---|
| `span` | 4 | 0 | 禁用侧边栏预取 |
| `prefetchChunk` | 200→50 | 5 | 每次预取的消息数 |
| `prefetchConcurrency` | 2 | 1 | 并发请求数 |
| `prefetchPendingLimit` | 10 | 2 | 队列上限 |

### 7. 初始消息加载量

**文件**：`packages/app/src/context/sync.tsx`

| 参数 | 值 | 说明 |
|---|---|---|
| `initialMessagePageSize` | 40 | 首次打开 session 拉取的消息数。不能太小，否则页面不足以显示滚动条，导致 `userScrolled` 无法被触发，scroll-based `loadMore` 永久失效 |
| `historyMessagePageSize` | 50 | "加载更多历史"每批拉取数 |

### 8. 通知与 prompt 历史上限

**文件**：`packages/app/src/context/notification.tsx`、`packages/app/src/components/prompt-input/history.ts`

| 项 | 改动前 | 改动后 |
|---|---|---|
| `MAX_NOTIFICATIONS` | 500 | 50 |
| `MAX_HISTORY` | 100 | 10 |

这两者都通过 `Persist.global` 同步到 gateway settings，缩小上限直接减少 `GET /settings` 的响应大小。

---

## 已尝试但放弃的方案

### ❌ 逐事件 gzip（per-event base64url）

在 gateway 对每个 SSE `data:` 字段单独 gzip 后 base64url 编码，客户端用 `DecompressionStream` 解码。

**失败原因**：客户端解码使用 `async start(ctrl)` 的 Web ReadableStream，JSON.parse 或 DecompressionStream 失败时 `ctrl.error(e)` 会产生未捕获的进程级 Promise rejection，导致 gateway 崩溃退出。同时 async 异步解码路径也破坏了 SSE 流的有序投递和 interrupt 信号。

**替代方案**：改用流级别 gzip（方案 3），浏览器透明解压，客户端无需任何改动。

### ❌ SSE stream 内 JSON 字段处理（patch trimming）

在 `gzipSseStream` 之前插入一个 async ReadableStream transform，解析 `session.updated` 和 `session.diff` 事件的 `patch` 字段，裁剪 context 行。

**失败原因**：两个 async ReadableStream 串联后，错误传播路径不可控，依然导致进程崩溃。单独 gzip 是可以的，但再加一层 transform 就不稳定。

### ❌ 消息列表 10s 缓存

对 `GET /session/:id/message` 加 10s TTL 缓存。

**失败原因**：
- 客户端 `sync.tsx` 的 `historyMore()` 依赖 `meta.complete[key]`，`complete = !cursor`。如果首次请求恰好返回空 cursor（消息数 ≤ limit），缓存会永久固化 `complete=true`，`loadMore` 所有 guard 都会失效，scroll-to-load 完全失效。
- 消息在 AI 回复期间持续更新，缓存会导致新消息不可见。

---

## 重要 Bug 记录

### `X-Next-Cursor` 丢失

**现象**：打开有历史消息的 session，向上滚动无法触发加载更多。

**根因**：gateway 的 TTL 缓存只存储 `body`、`etag`、`content-type`，命中缓存时丢失 `X-Next-Cursor` 响应头。`sync.tsx` 的 `loadMore` 检查 `meta.cursor[key]`，cursor 为空时直接 return。

**修复**：缓存条目增加 `cursor?: string` 字段，存入和命中时都携带。

### `initialMessagePageSize` 过小导致 scroll 失效

**现象**：设置较小的初始加载量（如 10 或 30），向上滚动无法触发 `loadMore`。

**根因**：`loadMore` 的 scroll 触发路径依赖 `userScrolled()` 为 true。`userScrolled` 由 `createAutoScroll` 管理，仅当 `canScroll(el) = scrollHeight - clientHeight > 1` 时才能被设置为 true。消息太少导致无滚动条，`canScroll = false`，`userScrolled` 永远为 false，`onScrollerScroll` 第一个 guard 直接 return。

**修复**：`initialMessagePageSize` 恢复为 40，确保大多数 session 的消息量足以产生滚动条。

---

## 禁止事项（避免踩坑）

1. **不要在 SSE proxy 路径上加 async Web ReadableStream transform**：任何未捕获错误都会导致进程崩溃。如需 SSE 内容处理，必须用 node:stream pipeline 或在 gzip stream 内部处理。

2. **不要缓存带分页 cursor 的接口**：缓存会固化 `complete` 状态，导致 `loadMore` 永久失效。

3. **gateway compress() 中间件不能用于 SSE**：`compress()` 的 `CompressionStream` 会缓冲数据，SSE 事件无法实时投递。SSE 必须用 `node:zlib` + `Z_SYNC_FLUSH` 手动处理。

4. **SSE error 处理必须 swallow**：node:zlib `error` 事件和 TransformStream writer 的 reject 必须都用 `.catch(() => {})` 吞掉，否则进程会崩溃。
