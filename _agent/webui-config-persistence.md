# WebUI Standalone 模式：构建、部署与配置持久化

## 核心问题

期望 webui 是一个 **standalone** 的状态 — 后端不是 opencode server。
即：webui 作为独立前端应用运行，通过网络连接到远程的 opencode server，
自身需要一个轻量级服务来托管静态文件和持久化 UI 配置。

这带来两个子问题：
1. standalone 模式的服务端如何构建和部署？
2. 该服务端如何持久化 UI 配置？

---

## 当前部署架构（对照）

目前 webui 有三种运行方式，**全部依赖 opencode server**：

### 方式 1: app.opencode.ai（Cloudflare 静态站）

```
浏览器
  ↓ 加载页面
app.opencode.ai (Cloudflare CDN, 纯静态)
  ↓ 前端 JS 连接
localhost:4096 (本地 opencode server)
```
- 静态部署，无服务端逻辑
- 前端 `entry.tsx:101` 硬编码连接 `localhost:4096`
- UI 配置存 localStorage — **换浏览器就丢**
- 相关代码：`infra/app.ts:61-68` (SST Cloudflare StaticSite)

### 方式 2: opencode serve/web（嵌入式）

```
浏览器
  ↓ 加载页面 + API 请求
opencode server (同一进程，同一端口)
  ├── API 路由 (/global/*, /session/*, ...)
  └── UIRoutes catch-all (嵌入的静态文件，SPA fallback)
```
- 前端 build 产物通过 `opencode-web-ui.gen.ts` 嵌入二进制
- `entry.tsx:104`: 生产模式下用 `location.origin`（即自身）
- 相关代码：`packages/opencode/src/server/ui/index.ts:24-37`

### 方式 3: 桌面端（Tauri / Electron）

```
Tauri/Electron webview
  ↓ 加载本地 HTML
本地 opencode 进程 (sidecar 或 in-process)
```
- Tauri: 外部 sidecar 二进制 (`cli.rs:552-607`)
- Electron: 进程内运行 (`server.ts:33-42`)
- 配置存 Tauri Store / Electron localStorage

**三种方式的共同点：全部依赖 opencode server 提供 API。UI 配置全部在客户端。**

---

## 当前前端对后端的依赖分析

前端启动流程（`app.tsx:360-378`）：

```
ServerProvider (加载服务器列表)
  → 无服务器？显示 NoServer 连接表单
  → 有服务器？→ ConnectionGate (健康检查 /global/health)
    → 不健康？显示 ServerUnreachable + 重试
    → 健康？→ GlobalSDKProvider (建立 SSE 事件流)
      → GlobalSyncProvider (拉取 projects, providers, config)
        → 正常渲染 app
```

前端必须从 opencode server 获取的数据：

| 数据 | 端点 | 是否 standalone 需要 |
|------|------|---------------------|
| 健康检查 | `GET /global/health` | 否（standalone 自身提供） |
| 全局配置 | `GET /global/config` | 否（从连接的远程 server 获取） |
| Provider 列表 | `GET /provider` | 否（同上） |
| 项目列表 | `GET /project` | 否（同上） |
| 会话管理 | `GET/POST /session` | 否（同上） |
| SSE 事件流 | `GET /global/event`, `GET /event` | 否（同上） |
| UI 设置 | localStorage | **是 — 这就是要解决的问题** |

结论：前端的 AI 功能全部通过 SDK 连接远程 opencode server。
**standalone 服务端只需解决两件事：托管静态文件 + 持久化 UI 配置。**

---

## Standalone 服务端方案

### 架构目标

```
浏览器
  ↓ 加载页面（静态文件）
standalone server (轻量级，非 opencode)
  ├── 静态文件服务 (SPA fallback)
  └── UI 配置 API (GET/PATCH /ui/settings)
  ↓ 前端 JS 通过 SDK 连接
远程 opencode server(s) (多个，用户可配)
```

### 方案 A: 独立轻量 Bun/Hono 服务（推荐）

在 `packages/app` 或新建 `packages/app-server` 中，写一个最小 Hono 服务：

```
packages/app-server/
  ├── src/
  │   ├── index.ts          # 入口，Bun.serve
  │   ├── routes/
  │   │   └── settings.ts   # GET/PATCH /ui/settings
  │   └── storage.ts        # JSON 文件读写
  ├── package.json
  └── Dockerfile
```

功能：
1. **静态文件服务** — 挂载 `packages/app/dist/`，SPA fallback 到 `index.html`
2. **UI 设置 API** — 极简 CRUD：
   - `GET /ui/settings` — 返回全量 JSON
   - `PATCH /ui/settings` — 深度合并 + 写回文件
3. **存储** — 单个 JSON 文件 `~/.config/opencode/webui.json`（与 TUI 的 `tui.json` 对齐）

核心代码量约 100 行。不需要 Effect、Drizzle、SQLite。

**优点**：
- 极简，部署方便（单文件 / Docker）
- 与 opencode server 完全解耦
- JSON 文件人工可编辑
- 可复用 Hono（项目已有依赖）

**缺点**：
- 新增一个独立服务需要维护
- 需要前端感知"当前是 standalone 模式还是 embedded 模式"

### 方案 B: 在 opencode server 中加 webui config 端点

即上一版文档中的方案 A — 在现有 opencode server 加 `GET/PATCH /global/webui-config`。

**问题**：这不满足"standalone"要求。用户明确说后端没有 opencode。
此方案只适合"embedded"场景（opencode serve/web 或桌面端）。

**可以作为补充**：embedded 模式用 opencode server 的端点，standalone 模式用独立服务。

### 方案 C: Cloudflare Workers + KV

将 app.opencode.ai 从纯静态站升级为 Cloudflare Worker：

```
app.opencode.ai (Cloudflare Worker)
  ├── 静态资产 (Pages / R2)
  └── /ui/settings (KV 存储)
```

- 用 Cloudflare KV 存储 UI 配置
- 需要用户认证（否则任何人可读写别人的配置）
- 与现有 SST 部署方式冲突

**优点**：无需用户自己部署服务
**缺点**：需要账号系统、存储成本、与 self-hosted 场景不兼容

---

## 推荐架构：双模式

```
┌─────────────────────────────────────────────┐
│               前端 (packages/app)             │
│                                              │
│  persist.ts 判断当前模式：                     │
│    ├── standalone 模式 → 调 /ui/settings API   │
│    └── embedded 模式  → 调 /global/webui-config│
│                                              │
│  两种模式都保留 localStorage 做缓存/fallback    │
└──────────────┬───────────────────┬────────────┘
               │                   │
    ┌──────────▼────────┐  ┌──────▼──────────────┐
    │ standalone server  │  │ opencode server      │
    │ (轻量 Hono)        │  │ (现有，加 webui 端点) │
    │                    │  │                      │
    │ GET/PATCH          │  │ GET/PATCH             │
    │   /ui/settings     │  │   /global/webui-config│
    │                    │  │                      │
    │ 存：webui.json     │  │ 存：webui.json        │
    └────────────────────┘  └──────────────────────┘
```

### 前端如何判断模式

`entry.tsx` 中的 `getCurrentUrl()` 已经区分了三种场景：
- `app.opencode.ai` → standalone（CDN 托管，连远程 server）
- `import.meta.env.DEV` → dev 模式
- 其他 → embedded（`location.origin` 就是 opencode server）

可以扩展为：
- 如果 `location.origin` 的 `/global/health` 可达且返回 opencode 标识 → embedded 模式
- 否则 → standalone 模式，UI 设置走 `/ui/settings` 或纯 localStorage

---

## Standalone 服务端构建与部署

### 构建

```bash
# 1. 构建前端
bun run --cwd packages/app build

# 2. 构建 standalone server
bun build packages/app-server/src/index.ts \
  --target bun --outdir packages/app-server/dist

# 或直接用 bun run 启动（无需编译）
```

### 部署方式

| 方式 | 命令 | 适合场景 |
|------|------|---------|
| 直接运行 | `bun packages/app-server/src/index.ts` | 开发、个人使用 |
| Docker | `docker run -p 3000:3000 -v ~/.config/opencode:/data opencode-webui` | 生产、team 部署 |
| 编译二进制 | `bun build --compile` 输出单文件 | 分发、无 runtime 依赖 |
| 静态托管 + 无配置 | 部署到任意 CDN（Vercel/Netlify/Cloudflare Pages） | 不需要配置持久化时 |

### Docker 镜像

```dockerfile
FROM oven/bun:1-slim
WORKDIR /app
COPY packages/app/dist ./static
COPY packages/app-server/dist ./server
EXPOSE 3000
VOLUME /data
ENV WEBUI_CONFIG_DIR=/data
CMD ["bun", "server/index.js"]
```

---

## UI 配置持久化设计

### 存储格式

文件：`$WEBUI_CONFIG_DIR/webui.json`（默认 `~/.config/opencode/webui.json`）

```json
{
  "settings": {
    "general": { "autoSave": true, "followup": "steer", ... },
    "appearance": { "fontSize": 14, "mono": "", "sans": "" },
    "keybinds": {},
    "permissions": { "autoApprove": false },
    "notifications": { "agent": true, ... },
    "sounds": { "agentEnabled": true, ... }
  },
  "model": {
    "hidden": {},
    "recent": [],
    "variant": {}
  },
  "language": "en"
}
```

### API 设计

```
GET  /ui/settings          → 200 { 全量 JSON }
PATCH /ui/settings         → 200 { 合并后的全量 JSON }
     body: { 部分 JSON，深度合并 }
```

无需认证（standalone 通常跑在 localhost）。
如果需要多用户支持，可加 `?user=<id>` 或 cookie-based session。

### 前端集成

在 `persist.ts` 中新增一个 storage backend：

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

现有 `persisted()` 已支持 `AsyncStorage` 接口（桌面端用的就是异步存储），
切换 backend 不需要改上层 context 代码。

### 读写策略

```
写入：
  1. 写 localStorage（即时，optimistic）
  2. 异步写 server（后台，debounce 500ms）
  3. 写失败？保留 localStorage 版本，下次重试

读取：
  1. 先读 localStorage（即时显示，避免白屏）
  2. 异步读 server（后台）
  3. server 版本更新？合并到 localStorage + 更新 store
```

这保证了：
- 离线可用（localStorage 兜底）
- 多设备同步（server 为 source of truth）
- 无延迟（先用本地缓存）

---

## 参考文件

| 文件 | 说明 |
|------|------|
| `packages/app/src/utils/persist.ts` | 前端持久化层，支持 Sync/Async storage |
| `packages/app/src/context/settings.tsx` | UI 设置上下文，定义 Settings 接口 |
| `packages/app/src/context/platform.tsx` | 平台检测 (`web` / `desktop`) |
| `packages/app/src/entry.tsx:100-111` | 服务器 URL 解析逻辑 |
| `packages/app/src/app.tsx:360-378` | ServerGate / ConnectionGate 启动流程 |
| `packages/opencode/src/server/ui/index.ts` | 现有 UIRoutes（嵌入式/代理模式） |
| `packages/opencode/src/config/tui.ts` | TUI 配置先例（独立 JSON 文件） |
| `packages/opencode/src/server/server.ts` | 现有 Hono 服务结构 |
| `infra/app.ts:61-68` | 现有 Cloudflare 静态部署 |
