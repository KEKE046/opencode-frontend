import { Component, Match, Show, Switch, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"

export const DialogSettings: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const desktop = createMediaQuery("(min-width: 640px)")
  const [active, setActive] = createSignal<string | undefined>(undefined)

  const title = () => {
    const a = active()
    if (a === "general") return language.t("settings.tab.general")
    if (a === "shortcuts") return language.t("settings.tab.shortcuts")
    if (a === "providers") return language.t("settings.providers.title")
    if (a === "models") return language.t("settings.models.title")
    return ""
  }

  const item = (id: string, icon: IconProps["name"], label: string) => (
    <button
      class="flex items-center gap-3 px-3 py-2.5 rounded-md active:bg-surface-base w-full text-left"
      onClick={() => setActive(id)}
    >
      <Icon name={icon} class="text-text-weak" />
      <span class="text-14-regular text-text-strong">{label}</span>
    </button>
  )

  return (
    <Dialog size="x-large" transition>
      <Show
        when={desktop()}
        fallback={
          <div class="flex flex-col h-full">
            <Show
              when={active()}
              fallback={
                <>
                  <div class="flex items-center h-10 px-4 shrink-0 border-b border-border-weak-base">
                    <span class="flex-1 text-14-medium text-text-strong">
                      {language.t("sidebar.settings")}
                    </span>
                    <IconButton icon="close-small" variant="ghost" onClick={() => dialog.close()} />
                  </div>
                  <div class="flex-1 overflow-auto px-2 py-3">
                    <div class="flex flex-col gap-4">
                      <div class="flex flex-col gap-0.5">
                        <div class="px-3 pb-1 text-12-medium text-text-weak">
                          {language.t("settings.section.desktop")}
                        </div>
                        {item("general", "sliders", language.t("settings.tab.general"))}
                        {item("shortcuts", "keyboard", language.t("settings.tab.shortcuts"))}
                      </div>
                      <div class="flex flex-col gap-0.5">
                        <div class="px-3 pb-1 text-12-medium text-text-weak">
                          {language.t("settings.section.server")}
                        </div>
                        {item("providers", "providers", language.t("settings.providers.title"))}
                        {item("models", "models", language.t("settings.models.title"))}
                      </div>
                    </div>
                    <div class="flex flex-col gap-1 px-3 pt-6 text-12-medium text-text-weak">
                      <span>{language.t("app.name.desktop")}</span>
                      <span class="text-11-regular">v{platform.version}</span>
                    </div>
                  </div>
                </>
              }
            >
              <div class="flex items-center h-10 px-3 shrink-0 border-b border-border-weak-base">
                <IconButton icon="arrow-left" variant="ghost" onClick={() => setActive(undefined)} />
                <span class="flex-1 text-14-medium text-text-strong ml-1 truncate">{title()}</span>
                <IconButton icon="close-small" variant="ghost" onClick={() => dialog.close()} />
              </div>
              <div class="flex-1 min-h-0 overflow-auto">
                <Switch>
                  <Match when={active() === "general"}><SettingsGeneral /></Match>
                  <Match when={active() === "shortcuts"}><SettingsKeybinds /></Match>
                  <Match when={active() === "providers"}><SettingsProviders /></Match>
                  <Match when={active() === "models"}><SettingsModels /></Match>
                </Switch>
              </div>
            </Show>
          </div>
        }
      >
        <Tabs orientation="vertical" variant="settings" defaultValue="general" class="h-full settings-dialog">
          <Tabs.List>
            <div class="flex flex-col justify-between h-full w-full">
              <div class="flex flex-col gap-3 w-full pt-3">
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="general">
                        <Icon name="sliders" />
                        {language.t("settings.tab.general")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="shortcuts">
                        <Icon name="keyboard" />
                        {language.t("settings.tab.shortcuts")}
                      </Tabs.Trigger>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="providers">
                        <Icon name="providers" />
                        {language.t("settings.providers.title")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="models">
                        <Icon name="models" />
                        {language.t("settings.models.title")}
                      </Tabs.Trigger>
                    </div>
                  </div>
                </div>
              </div>
              <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
                <span>{language.t("app.name.desktop")}</span>
                <span class="text-11-regular">v{platform.version}</span>
              </div>
            </div>
          </Tabs.List>
          <Tabs.Content value="general" class="no-scrollbar">
            <SettingsGeneral />
          </Tabs.Content>
          <Tabs.Content value="shortcuts" class="no-scrollbar">
            <SettingsKeybinds />
          </Tabs.Content>
          <Tabs.Content value="providers" class="no-scrollbar">
            <SettingsProviders />
          </Tabs.Content>
          <Tabs.Content value="models" class="no-scrollbar">
            <SettingsModels />
          </Tabs.Content>
        </Tabs>
      </Show>
    </Dialog>
  )
}
