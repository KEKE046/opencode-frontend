import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"

const POLL_MS = 10_000

const rank = (v?: ServerHealth) => {
  if (v?.healthy === true) return 0
  if (v?.healthy === false) return 2
  return 1
}

export function ServerStatusPopover() {
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const check = useCheckServerHealth()
  const [shown, setShown] = createSignal(false)
  const [health, setHealth] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  // server list with current server first
  const servers = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (list.every((item) => ServerConnection.key(item) !== ServerConnection.key(current))) return [current, ...list]
    return [current, ...list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(current))]
  })

  // sorted by health status
  const sorted = createMemo(() => {
    const list = servers()
    if (!list.length) return list
    const order = new Map(list.map((s, i) => [s, i] as const))
    return list.slice().sort((a, b) => {
      if (ServerConnection.key(a) === server.key) return -1
      if (ServerConnection.key(b) === server.key) return 1
      const d = rank(health[ServerConnection.key(a)]) - rank(health[ServerConnection.key(b)])
      if (d !== 0) return d
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  // default server key from platform
  const [defaults, setDefaults] = createStore({ url: undefined as string | undefined, tick: 0 })
  createEffect(() => {
    defaults.tick
    let dead = false
    const result = platform.getDefaultServer?.()
    if (!result) {
      setDefaults("url", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }
    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setDefaults("url", next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }
    setDefaults("url", normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })
  const defaultKey = () => {
    const u = defaults.url
    if (!u) return
    return ServerConnection.key({ type: "http", http: { url: u } })
  }
  const refreshDefault = () => setDefaults("tick", (v) => v + 1)

  // poll health when popover is open
  createEffect(() => {
    if (!shown()) {
      setHealth(reconcile({}))
      return
    }
    const list = servers()
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

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": language.t("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={shown() ? "status-active" : "status"} size="small" />
          </div>
          <div
            classList={{
              "absolute -top-px -right-px size-1.5 rounded-full": true,
              "bg-icon-success-base": server.healthy() === true,
              "bg-icon-critical-base": server.healthy() === false,
              "bg-border-weak-base": server.healthy() === undefined,
            }}
          />
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={4}
      placement="bottom-end"
    >
      <Show when={shown()}>
        <div class="w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
          <div class="bg-background-strong rounded-xl overflow-hidden">
            <div class="flex flex-col px-2 py-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <For each={sorted()}>
                  {(s) => {
                    const key = ServerConnection.key(s)
                    const blocked = () => health[key]?.healthy === false
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                        classList={{
                          "hover:bg-surface-raised-base-hover": !blocked(),
                          "cursor-not-allowed": blocked(),
                        }}
                        aria-disabled={blocked()}
                        onClick={() => {
                          if (blocked()) return
                          navigate("/")
                          queueMicrotask(() => server.setActive(key))
                        }}
                      >
                        <ServerHealthIndicator health={health[key]} />
                        <ServerRow
                          conn={s}
                          dimmed={blocked()}
                          status={health[key]}
                          class="flex items-center gap-2 w-full min-w-0"
                          nameClass="text-14-regular text-text-base truncate"
                          versionClass="text-12-regular text-text-weak truncate"
                          badge={
                            <Show when={key === defaultKey()}>
                              <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                                {language.t("common.default")}
                              </span>
                            </Show>
                          }
                        >
                          <div class="flex-1" />
                          <Show when={server.current && key === ServerConnection.key(server.current)}>
                            <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                          </Show>
                        </ServerRow>
                      </button>
                    )
                  }}
                </For>

                <Button
                  variant="secondary"
                  class="mt-3 self-start h-8 px-3 py-1.5"
                  onClick={() => {
                    const run = ++dialogRun
                    void import("./dialog-select-server").then((x) => {
                      if (dialogDead || dialogRun !== run) return
                      dialog.show(() => <x.DialogSelectServer />, refreshDefault)
                    })
                  }}
                >
                  {language.t("status.popover.action.manageServers")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </Popover>
  )
}
