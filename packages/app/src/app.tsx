import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, normalizeServerUrl, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { ServerForm } from "@/components/dialog-select-server"
import { Button } from "@opencode-ai/ui/button"
import { createStore } from "solid-js/store"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"

const HomeRoute = lazy(() => import("@/pages/home"))
const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
const Loading = () => <div class="size-full" />

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <Layout>{props.children}</Layout>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(
    () => (server.loaded() ? true : undefined),
    () =>
      props.disableHealthCheck
        ? true
        : Effect.gen(function* () {
            if (!server.current) return true
            const { http, type } = server.current

            while (true) {
              const res = yield* Effect.promise(() => checkServerHealth(http))
              if (res.healthy) return true
              if (checkMode() === "background" || type === "http") return false
            }
          }).pipe(
            Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
            Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
            Effect.runPromise,
          ),
  )

  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))
  const [managing, setManaging] = createSignal(false)
  const gateway = typeof document !== "undefined" && !!document.querySelector('meta[name="opencode-gateway"]')

  const [form, setForm] = createStore({
    url: "",
    name: "",
    username: "opencode",
    password: "",
    error: "",
    busy: false,
    status: undefined as boolean | undefined,
  })

  async function submit() {
    const normalized = normalizeServerUrl(form.url)
    if (!normalized) return
    setForm("busy", true)
    setForm("error", "")

    if (gateway) {
      try {
        const res = await fetch("/gateway/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: normalized,
            name: form.name.trim() || undefined,
            username: form.username || undefined,
            password: form.password || undefined,
          }),
        })
        if (!res.ok) {
          setForm({ error: language.t("dialog.server.add.error"), busy: false })
          return
        }
        const data = await res.json() as { key: string; name?: string; healthy: boolean }
        const conn: ServerConnection.Http = {
          type: "http",
          displayName: data.name,
          http: { url: `${location.origin}/s/${data.key}` },
          gatewayKey: data.key,
        }
        server.add(conn)
        server.setActive(ServerConnection.key(conn))
      } catch {
        setForm({ error: language.t("dialog.server.add.error"), busy: false })
        return
      }
    } else {
      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (form.name.trim()) conn.displayName = form.name.trim()
      if (form.password) conn.http.password = form.password
      if (form.password && form.username) conn.http.username = form.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setForm({ error: language.t("dialog.server.add.error"), busy: false })
        return
      }
      server.add(conn)
    }
    setForm("busy", false)
    setManaging(false)
    props.onRetry?.()
  }

  const timer = setInterval(() => {
    if (!managing()) props.onRetry?.()
  }, 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <Show
      when={!managing()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
          <div class="flex flex-col items-center max-w-md text-center">
            <Splash class="w-12 h-15 mb-4" />
            <p class="text-14-medium text-text-strong">{language.t("app.server.manage")}</p>
          </div>
          <div class="w-full max-w-md">
            <ServerForm
              value={form.url}
              name={form.name}
              username={form.username}
              password={form.password}
              placeholder={language.t("dialog.server.add.placeholder")}
              busy={form.busy}
              error={form.error}
              status={form.status}
              onChange={(v) => setForm("url", v)}
              onNameChange={(v) => setForm("name", v)}
              onUsernameChange={(v) => setForm("username", v)}
              onPasswordChange={(v) => setForm("password", v)}
              onSubmit={submit}
              onBack={() => setManaging(false)}
            />
            <div class="px-5 mt-3">
              <Button
                variant="primary"
                size="large"
                onClick={submit}
                disabled={form.busy || !form.url.trim()}
                class="px-3 py-1.5"
              >
                {form.busy ? language.t("dialog.server.add.checking") : language.t("app.server.noServer.connect")}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
        <div class="flex flex-col items-center max-w-md text-center">
          <Splash class="w-12 h-15 mb-4" />
          <p class="text-14-regular text-text-base">
            {unreachable()[0]}
            <span class="text-text-strong font-medium">{name()}</span>
            {unreachable()[1]}
          </p>
          <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
          <button
            type="button"
            class="mt-4 px-4 py-2 rounded-md bg-surface-base hover:bg-surface-raised-base-hover text-14-regular text-text-strong transition-colors"
            onClick={() => setManaging(true)}
          >
            {language.t("app.server.manage")}
          </button>
        </div>
        <Show when={others().length > 0}>
          <div class="flex flex-col gap-2 w-full max-w-sm">
            <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
            <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
              <For each={others()}>
                {(conn) => {
                  const key = ServerConnection.key(conn)
                  return (
                    <button
                      type="button"
                      class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                      onClick={() => props.onServerSelected?.(key)}
                    >
                      <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.current && server.key} keyed>
      {props.children}
    </Show>
  )
}

function NoServer() {
  const server = useServer()
  const language = useLanguage()
  const checkServerHealth = useCheckServerHealth()
  const [form, setForm] = createStore({
    url: "",
    name: "",
    username: "opencode",
    password: "",
    error: "",
    busy: false,
    status: undefined as boolean | undefined,
  })

  const gateway = typeof document !== "undefined" && !!document.querySelector('meta[name="opencode-gateway"]')

  async function submit() {
    const normalized = normalizeServerUrl(form.url)
    if (!normalized) return
    setForm("busy", true)
    setForm("error", "")

    if (gateway) {
      try {
        const res = await fetch("/gateway/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: normalized,
            name: form.name.trim() || undefined,
            username: form.username || undefined,
            password: form.password || undefined,
          }),
        })
        if (!res.ok) {
          setForm({ error: language.t("dialog.server.add.error"), busy: false })
          return
        }
        const data = await res.json() as { key: string; name?: string; healthy: boolean }
        const conn: ServerConnection.Http = {
          type: "http",
          displayName: data.name,
          http: { url: `${location.origin}/s/${data.key}` },
          gatewayKey: data.key,
        }
        server.add(conn)
        server.setActive(ServerConnection.key(conn))
      } catch {
        setForm({ error: language.t("dialog.server.add.error"), busy: false })
        return
      }
    } else {
      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (form.name.trim()) conn.displayName = form.name.trim()
      if (form.password) conn.http.password = form.password
      if (form.password && form.username) conn.http.username = form.username

      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setForm({ error: language.t("dialog.server.add.error"), busy: false })
        return
      }
      server.add(conn)
    }
    setForm("busy", false)
  }

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-medium text-text-strong">{language.t("app.server.noServer.title")}</p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.noServer.description")}</p>
      </div>
      <div class="w-full max-w-md">
        <ServerForm
          value={form.url}
          name={form.name}
          username={form.username}
          password={form.password}
          placeholder={language.t("dialog.server.add.placeholder")}
          busy={form.busy}
          error={form.error}
          status={form.status}
          onChange={(v) => setForm("url", v)}
          onNameChange={(v) => setForm("name", v)}
          onUsernameChange={(v) => setForm("username", v)}
          onPasswordChange={(v) => setForm("password", v)}
          onSubmit={submit}
          onBack={() => {}}
        />
        <div class="px-5 mt-3">
          <Button
            variant="primary"
            size="large"
            onClick={submit}
            disabled={form.busy || !form.url.trim()}
            class="px-3 py-1.5"
          >
            {form.busy ? language.t("dialog.server.add.checking") : language.t("app.server.noServer.connect")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ServerGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  return (
    <Show
      when={server.loaded()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show when={server.list.length > 0} fallback={<NoServer />}>
        <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
          {props.children}
        </ConnectionGate>
      </Show>
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  seed?: string
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
      seed={props.seed}
    >
      <ServerGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
              >
                <Route path="/" component={HomeRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={SessionIndexRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                </Route>
              </Dynamic>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </ServerKey>
      </ServerGate>
    </ServerProvider>
  )
}
