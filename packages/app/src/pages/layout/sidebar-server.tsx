import { createEffect, For, onCleanup, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useNavigate } from "@solidjs/router"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { getAvatarColors } from "@/context/layout"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"

const POLL_MS = 10_000
const COLORS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

function colorFor(key: string) {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

function initials(name: string) {
  // Strip protocol + port/path, take first 2 chars of the first hostname segment
  const host = name.replace(/^https?:\/\//, "").split(/[:/]/)[0]
  return host.slice(0, 2).toUpperCase()
}

export const ServerRail = (props: { mobile?: boolean }): JSX.Element => {
  const server = useServer()
  const navigate = useNavigate()
  const check = useCheckServerHealth()
  const [health, setHealth] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)
  const placement = () => (props.mobile ? "bottom" : "right")

  createEffect(() => {
    const list = server.list
    let dead = false
    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(list.map(async (conn) => (results[ServerConnection.key(conn)] = await check(conn.http))))
      if (dead) return
      setHealth(reconcile(results))
    }
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return (
    <For each={server.list}>
      {(conn) => {
        const key = ServerConnection.key(conn)
        const label = () => serverName(conn)
        const abbr = initials(serverName(conn))
        const colors = getAvatarColors(colorFor(key))
        const active = () => server.key === key

        return (
          <Tooltip placement={placement()} value={label()}>
            <button
              type="button"
              aria-label={label()}
              classList={{
                "relative flex items-center justify-center size-10 p-1 rounded-lg transition-colors cursor-default": true,
                "border-2 border-icon-strong-base": active(),
                "border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base": !active(),
              }}
              onClick={() => {
                navigate("/")
                queueMicrotask(() => server.setActive(key))
              }}
            >
              <div
                class="size-8 rounded flex items-center justify-center text-12-medium select-none"
                style={{ background: colors.background, color: colors.foreground }}
              >
                {abbr}
              </div>
              <div class="absolute top-px right-px">
                <ServerHealthIndicator health={health[key]} />
              </div>
            </button>
          </Tooltip>
        )
      }}
    </For>
  )
}
