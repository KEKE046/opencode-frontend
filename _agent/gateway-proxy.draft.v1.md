# Gateway 反向代理设计草案

## 背景

当前 gateway 模式下，浏览器直接连接 opencode 后端服务器。这意味着后端必须从用户浏览器可达，违背了 gateway 作为中间层的初衷。

**现状：**
```
浏览器 ──HTTP/SSE/WS──▶ opencode 后端 (http://10.0.0.5:4096)
  │
  └──settings 同步──▶ gateway (http://gateway:3000)
```

**目标：**
```
浏览器 ──所有流量──▶ gateway (http://gateway:3000) ──代理──▶ opencode 后端
```

## 决策记录

- **连接池**：每个浏览器客户端独立连接，不共享 SSE/WS
- **Gateway 认证**：先不加，后续可扩展
- **API 路径**：`/ui/settings` 重命名为 `/settings`
- **projects 同步**：`projects` 通过 gateway 同步；`lastProject` 保持 localStorage 本地存储

## 核心变更

### 1. Gateway：服务器注册 API

Gateway 需要管理后端服务器列表（当前只存 UI 设置）。

**与现有 settings 同步的冲突：**

当前前端的 `ServerProvider` 使用 `Persist.global("server")` 存储服务器列表，而 `Persist.global()` 设置 `sync: true`。这意味着完整的服务器列表（包括 URL、username、password）已经通过 `/settings` 同步到 gateway 的 `webui.json`。

如果再新增独立的 `/gateway/servers` API，会产生两个数据源冲突。

**解决方案：**
- Gateway 模式下，`server` 键的 persist 配置改为 `sync: false`（不再通过 settings 同步服务器列表）
- 服务器列表完全由 `/gateway/servers` API 管理（单一数据源）
- `projects` 通过 `/settings` 同步（多客户端共享打开的项目列表）
- `lastProject` 保持 localStorage 本地存储（每个客户端独立的最后访问项目）
- 所有客户端通过 `/gateway/servers` 看到相同的服务器列表

**新增 API：**

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/gateway/servers` | 添加服务器（gateway 执行健康检查） |
| `GET` | `/gateway/servers` | 列出所有已注册服务器（不含凭据） |
| `DELETE` | `/gateway/servers/:key` | 移除服务器 |
| `PATCH` | `/gateway/servers/:key` | 修改服务器（URL/名称/凭据） |

**`GET /gateway/servers` 响应**（返回给浏览器，不含密码）：
```json
[
  { "key": "abc123", "name": "dev-server", "healthy": true },
  { "key": "def456", "name": "staging", "healthy": false }
]
```

**`POST /gateway/servers` 请求**（浏览器 → gateway）：
```json
{ "url": "http://10.0.0.5:4096", "name": "dev-server", "username": "", "password": "" }
```

**`POST /gateway/servers` 响应**：
```json
{ "key": "abc123", "name": "dev-server", "healthy": true }
```

**`PATCH /gateway/servers/:key` 请求**（浏览器 → gateway）：
```json
{ "url": "http://10.0.0.5:4096", "name": "renamed", "username": "", "password": "" }
```

**Gateway 磁盘存储**（`webui.json`，凭据只在这里）：
```json
{
  "_ts": 1234,
  "servers": {
    "abc123": {
      "url": "http://10.0.0.5:4096",
      "name": "dev-server",
      "username": "",
      "password": ""
    }
  },
  "settings.v3": { ... }
}
```

- `key` 由 gateway 生成（短 ID），不暴露真实 URL 给浏览器
- 凭据只存在 gateway 端，浏览器永远不接触后端密码
- `GET /gateway/servers` 返回列表时不含 `url`/`username`/`password`

### 2. Gateway：反向代理

所有后端流量通过路径前缀 `/s/{key}/` 转发：

| 浏览器请求 | Gateway 转发至 |
|---|---|
| `GET /s/{key}/global/health` | `GET http://10.0.0.5:4096/global/health` |
| `GET /s/{key}/global/event` (SSE) | SSE 代理至后端 |
| `WS /s/{key}/pty/{id}/connect` | WebSocket 代理至后端 |
| `POST /s/{key}/session` | `POST http://10.0.0.5:4096/session` |

三种传输协议需要代理：

#### 2a. HTTP REST 代理

最简单。Gateway 收到请求后：
1. 从注册表查找 `key` 对应的后端 URL 和凭据
2. 构造新请求：`fetch(backendUrl + path, { method, headers, body })`
3. 注入 `Authorization: Basic ...` 头（如果后端需要认证）
4. 将响应原样返回浏览器（status、headers、body）

```ts
app.all("/s/:key/*", async (c) => {
  const server = registry[c.req.param("key")]
  if (!server) return c.json({ error: "unknown server" }, 404)
  const path = c.req.path.replace(`/s/${c.req.param("key")}`, "")
  const res = await fetch(server.url + path, {
    method: c.req.method,
    headers: { ...stripHeaders(c.req.raw.headers), ...authHeaders(server) },
    body: c.req.raw.body,
  })
  return new Response(res.body, { status: res.status, headers: res.headers })
})
```

#### 2b. SSE 代理

长连接。Gateway 需要：
1. 检测 `Accept: text/event-stream` 头
2. 向后端打开 SSE 连接
3. 将后端的 `ReadableStream` 直接 pipe 给浏览器
4. 处理后端断连：自动重连或通知浏览器

```ts
// SSE 可以复用 HTTP 代理逻辑
// 因为 SSE 本质就是一个长连接的 HTTP 响应
// 只需确保不缓冲响应体（streaming）
```

注意：Hono 的 `compress()` 中间件可能会缓冲 SSE 流，需要对 SSE 路径跳过压缩。

#### 2c. WebSocket 代理

双向数据流。Gateway 需要：
1. 接受浏览器的 WebSocket 升级请求
2. 同时向后端建立 WebSocket 连接
3. 双向 pipe：浏览器消息 → 后端，后端消息 → 浏览器
4. 任一端关闭时关闭另一端

```ts
// Bun 原生 WebSocket 支持
Bun.serve({
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") {
      const key = extractServerKey(req.url)
      const backend = registry[key]
      server.upgrade(req, { data: { backend } })
    }
  },
  websocket: {
    open(ws) {
      // 连接后端 WS
      const backendWs = new WebSocket(ws.data.backend.wsUrl)
      backendWs.onmessage = (e) => ws.send(e.data)
      ws.data.backendWs = backendWs
    },
    message(ws, msg) {
      ws.data.backendWs.send(msg)
    },
    close(ws) {
      ws.data.backendWs.close()
    },
  },
})
```

注意：当前 gateway 使用 Hono，但 Hono 的 WebSocket 支持需要 `hono/bun` adapter。可能需要从纯 Hono 切换到 `Bun.serve` + Hono 的混合模式。

### 3. Gateway：API 路径重命名

原 `/ui/settings` 重命名为 `/settings`：

| 方法 | 原路径 | 新路径 | 说明 |
|------|--------|--------|------|
| `GET` | `/ui/settings` | `/settings` | 读取设置（ETag 支持） |
| `PATCH` | `/ui/settings` | `/settings` | 写入设置（deep-merge） |

前端 `persist.ts` 中的 gateway 同步代码需要同步更新请求路径。

### 4. 前端：SDK 客户端修改

**文件：`packages/app/src/utils/server.ts`**

在 gateway 模式下，`createSdkForServer()` 的 `baseUrl` 应指向 gateway 代理路径：

```ts
// 当前
createOpencodeClient({ baseUrl: server.url })
// → http://10.0.0.5:4096

// 改为（gateway 模式）
createOpencodeClient({ baseUrl: `${location.origin}/s/${server.gatewayKey}` })
// → http://gateway:3000/s/abc123
```

不再需要注入 `Authorization` 头，因为凭据由 gateway 管理。

### 5. 前端：服务器连接类型与存储

**文件：`packages/app/src/context/server.tsx`**

#### 5a. 连接类型扩展

`ServerConnection.Http` 复用，但 gateway 模式下语义不同：

```ts
// gateway 模式下的 Http 连接
{
  type: "http",
  displayName: "dev-server",       // 从 gateway 返回的 name
  http: {
    url: "/s/abc123",              // 代理路径（相对于 gateway）
    // 无 username/password — 凭据由 gateway 管理
  },
  gatewayKey: "abc123",            // 新增字段
}
```

需要在 `ServerConnection` namespace 中扩展：
```ts
export type Http = {
  type: "http"
  http: HttpBase
  gatewayKey?: string   // 新增：gateway 分配的 key
} & Base
```

#### 5b. Persist 配置

```ts
// 当前
persisted(Persist.global("server", ["server.v3"]), ...)
// → sync: true → 整个 server store（list + projects + lastProject）同步到 /settings

// 改为
// server store 拆分同步策略：
// - list: gateway 模式下不同步（由 /gateway/servers 管理）
// - projects: 继续同步（多客户端共享项目列表）
// - lastProject: 不同步（localStorage 本地存储）
```

实现方式：保持 `Persist.global("server")` 的 `sync: true`，但在 `gatewaySync()` 中过滤掉 `list` 字段（gateway 模式下），只同步 `projects`。或者将 `projects` 拆成独立的 persist key。

#### 5c. 服务器列表来源

Gateway 模式下 `allServers()` 的数据来源变化：

```ts
// 当前
const allServers = createMemo(() => {
  // 合并 props.servers（桌面注入）+ store.list（localStorage）
})

// gateway 模式下
const allServers = createMemo(() => {
  // 合并 props.servers + gatewayServers()（从 /gateway/servers 获取）
  // store.list 不再使用
})
```

需要新增一个信号来存储 gateway 返回的服务器列表：
```ts
const [gatewayServers, setGatewayServers] = createSignal<ServerConnection.Http[]>([])
```

### 6. 前端：添加服务器流程修改

**文件：`packages/app/src/components/dialog-select-server.tsx`**

#### 6a. 添加服务器（当前 `addMutation`，line 228-252）

**当前流程：**
1. 用户输入 URL + 凭据
2. `normalizeServerUrl(value)` 规范化 URL
3. 构造 `ServerConnection.Http` 对象（含 url/username/password）
4. `checkServerHealth(conn.http)` — 浏览器直连后端健康检查
5. 成功 → `server.add(conn)` 写入 localStorage

**Gateway 模式改为：**
1. 用户输入 URL + 凭据（表单不变）
2. `POST /gateway/servers { url, name, username, password }` — 发给 gateway
3. Gateway 执行健康检查（用户浏览器不直连后端）
4. 成功 → gateway 返回 `{ key, name, healthy }`
5. 前端构造 `ServerConnection.Http`（`url: "/s/{key}"`, `gatewayKey: key`）
6. 加入本地服务器列表 / 更新 `gatewayServers` 信号

```ts
// gateway 模式的 addMutation
const addMutation = useMutation(() => ({
  mutationFn: async (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return

    const res = await fetch("/gateway/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: normalized,
        name: store.addServer.name.trim() || undefined,
        username: store.addServer.username || undefined,
        password: store.addServer.password || undefined,
      }),
    })
    if (!res.ok) {
      setStore("addServer", { error: "连接失败" })
      return
    }
    const data = await res.json()
    // data: { key: "abc123", name: "dev-server", healthy: true }

    const conn: ServerConnection.Http = {
      type: "http",
      displayName: data.name,
      http: { url: `/s/${data.key}` },
      gatewayKey: data.key,
    }
    await select(conn, true)
  },
}))
```

#### 6b. 编辑服务器（当前 `editMutation`，line 254-295）

**当前流程：**
1. 用户修改 URL/名称/凭据
2. 浏览器直连新 URL 做健康检查
3. URL 不变 → `server.add(conn)` 原地更新
4. URL 变了 → `replaceServer()` 先加新的、切换 active、再删旧的

**Gateway 模式改为：**
1. 用户修改 URL/名称/凭据
2. `PATCH /gateway/servers/:key { url, name, username, password }` — 发给 gateway
3. Gateway 用新信息做健康检查
4. 成功 → gateway 更新注册表并返回更新后的信息
5. 前端更新本地服务器列表

```ts
// gateway 模式的 editMutation
const editMutation = useMutation(() => ({
  mutationFn: async (input: { key: string; value: string }) => {
    const normalized = normalizeServerUrl(input.value)
    if (!normalized) return

    const res = await fetch(`/gateway/servers/${input.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: normalized,
        name: store.editServer.name.trim() || undefined,
        username: store.editServer.username || undefined,
        password: store.editServer.password || undefined,
      }),
    })
    if (!res.ok) {
      setStore("editServer", { error: "连接失败" })
      return
    }
    // 刷新服务器列表
    await refreshGatewayServers()
  },
}))
```

#### 6c. 删除服务器（当前 `handleRemove`，line 498-504）

**当前流程：**
1. `server.remove(key)` — 从 localStorage 移除
2. 如果列表空了 → 关闭 dialog
3. 如果删的是默认服务器 → 清除默认设置

**Gateway 模式改为：**
1. `DELETE /gateway/servers/:key` — 通知 gateway 删除
2. Gateway 删除注册表条目
3. 刷新本地服务器列表
4. 如果列表空了 → 关闭 dialog

```ts
async function handleRemove(conn: ServerConnection.Http) {
  if (!conn.gatewayKey) return
  await fetch(`/gateway/servers/${conn.gatewayKey}`, { method: "DELETE" })
  await refreshGatewayServers()
  if (server.list.length === 0) dialog.close()
}
```

#### 6d. 健康检查（当前 `refreshHealth`，line 335-343）

**当前流程：**
- 遍历所有服务器，`checkServerHealth(conn.http)` 浏览器直连每个后端

**Gateway 模式改为：**
- 两种选择：
  - **方案 A**：仍通过代理路径 `/s/{key}/global/health` 做健康检查（复用现有 SDK）
  - **方案 B**：`GET /gateway/servers` 返回的 `healthy` 字段已包含状态

推荐 **方案 A**：复用现有 `checkServerHealth`，只是 `conn.http.url` 已经是 `/s/{key}` 代理路径，请求自动走 gateway 代理。无需额外改动。

#### 6e. 实时预览状态（当前 `useServerPreview`，line 77-107）

**当前流程：**
- 用户输入 URL 时，`previewStatus()` 实时调用 `checkServerHealth(http)` 浏览器直连后端

**Gateway 模式改为：**
- 不做实时预览（用户输入的 URL 从浏览器不可达）
- 或者：每次 URL 变更时调用 `POST /gateway/servers/check { url, username, password }`（新增一个只做检查不保存的 API）
- 建议初期简化：去掉实时预览，只在提交时检查

#### 6f. 服务器列表展示

**当前流程：**
- `items()` 合并 `server.current` + `server.list`
- `ServerRow` 显示 `conn.http.url` 作为标识
- 菜单项：编辑、设为默认、删除

**Gateway 模式改为：**
- `items()` 来自 `gatewayServers()` 信号
- `ServerRow` 显示 `conn.displayName`（因为 URL 是代理路径 `/s/abc123`，对用户无意义）
- 编辑菜单保持不变，但提交走 gateway API

### 7. 前端：WebSocket URL 修改

**文件：`packages/app/src/components/terminal.tsx`** (line 519)

当前：
```ts
new URL(sdk.url + `/pty/${id}/connect`)
// → ws://10.0.0.5:4096/pty/xxx/connect
```

Gateway 模式下 `sdk.url` 已经是 `http://gateway:3000/s/abc123`，所以：
```ts
new URL(sdk.url + `/pty/${id}/connect`)
// → ws://gateway:3000/s/abc123/pty/xxx/connect
```

如果 step 4 正确修改了 `baseUrl`，这里**不需要额外改动**。

### 8. 前端：SSE 事件流

**文件：`packages/app/src/context/global-sdk.tsx`** (line 139)

同理，如果 SDK 的 `baseUrl` 正确指向 gateway 代理路径，SSE 连接会自动走代理：
```
GET http://gateway:3000/s/abc123/global/event
```
**不需要额外改动**（前提是 step 4 完成）。

## 安全考量

1. **凭据隔离**：后端服务器的 username/password 只存在 gateway 的 `webui.json` 中，永远不发送给浏览器
2. **URL 隐藏**：浏览器只知道 gateway 分配的 `key`（如 `abc123`），不知道后端真实 IP/端口
3. **Gateway 自身认证**：先不加，后续可扩展（独立于后端认证）

## 文件修改清单

| 文件 | 变更 |
|------|------|
| `packages/gateway/src/index.ts` | `/ui/settings` → `/settings`；新增 `/gateway/servers` CRUD API；新增 `/s/:key/*` 反向代理（HTTP/SSE/WS） |
| `packages/app/src/utils/server.ts` | gateway 模式下 `baseUrl` 指向 `/s/{key}` 代理路径，不注入 auth |
| `packages/app/src/context/server.tsx` | `Http` 类型添加 `gatewayKey`；gateway 模式下服务器列表从 `/gateway/servers` 获取；`projects` 继续同步，`list` 不同步 |
| `packages/app/src/components/dialog-select-server.tsx` | gateway 模式下 add/edit/remove 走 gateway API；去掉实时预览或改为 gateway check API |
| `packages/app/src/components/terminal.tsx` | 不需要改动（`sdk.url` 已经是代理路径） |
| `packages/app/src/context/global-sdk.tsx` | 不需要改动（`baseUrl` 已经是代理路径） |
| `packages/app/src/entry.tsx` | `gatewaySeed()` 扩展为同时拉取 `/gateway/servers` |
| `packages/app/src/utils/persist.ts` | `/ui/settings` → `/settings`；gateway 模式下过滤 server list 不同步 |

## 实现顺序建议

1. **Phase 1：Gateway 侧** — `/settings` 重命名 + 服务器注册 API + HTTP REST 代理（最小可用）
2. **Phase 2：SSE 代理** — 长连接流式转发
3. **Phase 3：WebSocket 代理** — PTY 终端双向代理
4. **Phase 4：前端适配** — SDK baseUrl 改写 + add/edit/remove 走 gateway API
5. **Phase 5：多客户端同步** — projects 通过 `/settings` 同步；服务器列表通过 `/gateway/servers` 在多客户端间共享

## 待定问题

1. **超时与断连** — SSE/WS 代理的超时策略、重连策略。
2. **Hono vs Bun.serve** — WebSocket 代理可能需要直接使用 `Bun.serve` 的 WebSocket API，需要确认和当前 Hono 路由的兼容性。
3. **健康检查轮询** — Gateway 是否主动轮询后端健康？还是只在浏览器请求时检查？初期建议只在请求时检查。
4. **实时预览** — 添加服务器时的 URL 可达性预览，是否需要专门的 check API？
