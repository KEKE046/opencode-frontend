import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

const gatewayEnabled = typeof document !== "undefined" && document.querySelector('meta[name="opencode-gateway"]')

export function createSdkForServer({
  server,
  gatewayKey,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
  gatewayKey?: string
}) {
  const inGatewayMode = gatewayEnabled && gatewayKey
  
  const auth = (() => {
    if (inGatewayMode) return // Gateway handles auth
    if (!server.password) return
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
    }
  })()

  const baseUrl = inGatewayMode ? `${location.origin}/s/${gatewayKey}` : server.url

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl,
  })
}
