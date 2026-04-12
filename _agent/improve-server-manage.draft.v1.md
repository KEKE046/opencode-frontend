# OpenCode Web UI - Server 管理改进方案

## 现状问题

### 1. 硬编码 localhost:4096

`packages/app/src/entry.tsx:129` 始终创建一个指向 `http://localhost:4096` 的 server 对象，通过 `servers={[server]}` 传入 `AppInterface`。无论用户环境是否有 opencode server 在运行，都会尝试连接这个地址。

### 2. 跳过健康检查

`packages/app/src/entry.tsx:137` 传入了 `disableHealthCheck`，导致 web 端永远不检测 server 是否存活，直接标记为 healthy。即使 localhost:4096 没有任何服务在运行，前端也会认为连接正常。

### 3. Server 管理入口仅在 session 页面可用

`StatusPopover`（包含 Servers / MCP / LSP / Plugins 四个 tab）仅在 `packages/app/src/components/session/session-header.tsx:419` 中通过 Portal 注入到标题栏右上角。在 Home 页面（`/` 路由），标题栏右上角区域 `#opencode-titlebar-right` 是空的，用户没有入口管理 server。

### 4. Home 页的 server 按钮位置不直观

`packages/app/src/pages/home.tsx:77-87` 在 Logo 下方居中位置有一个显示 server 名称的小按钮，点击可以打开 `DialogSelectServer` 对话框。但这个按钮不在常规的工具栏位置，容易被忽略。

---

## 改进方案

> 本期仅实现方案三（右上角 Server 管理按钮）。方案一（NoServer 欢迎页）和方案二（ConnectionError 改进）后续迭代。

### 一、首次启动：无 Server 欢迎页（后续迭代）

暂不实现。保持当前 localhost:4096 默认连接行为。

### 二、已有 Server 但连接失败（后续迭代）

暂不实现。保持当前 ConnectionError 行为不变。

### 三、右上角 Server 管理按钮（本期实现）

**目标**：在 Home 页面标题栏右上角增加 server 管理入口。

#### 视觉设计

按钮与 `StatusPopover`（`packages/app/src/components/status-popover.tsx`）的触发按钮**完全相同**：

```
  trigger 按钮                   StatusPopover 触发按钮
  ┌─────────┐                   ┌─────────┐
  │  [⚙]●  │     ===           │  [⚙]●  │
  └─────────┘                   └─────────┘
       │                             │
  status/status-active 图标     同一个图标
  右上角 1.5px 圆点:            右上角 1.5px 圆点:
    绿色 = server 健康             绿色 = 全部健康
    红色 = server 不可达           红色 = 有问题
    灰色 = 未知                    灰色 = 未知
```

- 使用 `status` / `status-active` 图标（与 StatusPopover 一致）
- 右上角健康圆点：仅反映 server 连接状态（Home 页无 MCP/LSP 上下文）

#### 交互逻辑

点击按钮 → 打开 Popover，内容为 StatusPopover servers tab 的**同款内容**：

```
┌──────────────────────────────┐
│  ● my-server:4096       ✓  │
│  ● localhost:4096           │
│                              │
│  [ 管理服务器 ]               │
└──────────────────────────────┘
```

- 展示所有 server 列表 + 健康状态 + 当前选中标记
- 点击 server 可切换
- 底部"管理服务器"按钮打开 `DialogSelectServer` 对话框（支持添加/编辑/删除）
- 内容与 `StatusPopoverBody`（`packages/app/src/components/status-popover-body.tsx`）的 servers tab（第 277-339 行）逻辑一致

#### 显示条件

- **Home 页面**（`!params.dir`）：显示此按钮
- **Session 页面**（`params.dir` 存在）：**不显示**，因为 `session-header` 已通过 Portal 注入完整的 `StatusPopover`（含 Servers / MCP / LSP / Plugins 四个 tab）

#### 复用策略

`StatusPopover` 当前依赖 `useSync()`（目录级上下文），Home 页面不在目录上下文内，无法直接复用整个组件。复用方案：

1. **提取 servers popover 内容**：将 `StatusPopoverBody` 中 servers tab 的内容（server 列表 + 健康检查 + 切换 + 管理按钮）提取为独立组件 `ServerPopoverBody`
2. **提取 trigger 按钮**：将 StatusPopover 的触发按钮（图标 + 健康圆点）提取为 `ServerStatusTrigger` 共享组件
3. **组合**：
   - Home 页面：`ServerStatusTrigger` + `Popover` + `ServerPopoverBody`（仅 servers）
   - Session 页面：StatusPopover 内部复用 `ServerStatusTrigger` + `ServerPopoverBody`（servers tab），同时保留 MCP/LSP/Plugins tabs

---

## 代码改动范围

| 文件 | 改动内容 |
|------|----------|
| `packages/app/src/components/status-popover.tsx` | 提取 trigger 按钮为共享组件 `ServerStatusTrigger` |
| `packages/app/src/components/status-popover-body.tsx` | 提取 servers tab 内容为共享组件 `ServerPopoverBody` |
| `packages/app/src/components/server-status-popover.tsx` | **新增**：Home 页面使用的 server-only popover（组合 trigger + servers body） |
| `packages/app/src/components/titlebar.tsx` | Home 页面右上角渲染 `ServerStatusPopover` |

不涉及 `entry.tsx`、`server.tsx`、`app.tsx`、i18n 文件的改动（留给后续迭代）。
