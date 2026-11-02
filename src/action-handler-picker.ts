import { openDialog } from "./dialog.js"
import { buildHandlerBody } from "./system-napps/handler.js"
import { discoverIntents, mountIntentHandlerChoices } from "./intents/manager.js"
import type { IntentRequest } from "./intents/catalog.js"
import type { NappWindowState } from "./types.js"
import type { ActionTarget } from "./handlers.js"
import * as persist from "./persistence.js"

export type HandlerSelection = ActionTarget | { intent: IntentRequest }

// The source determines the primary section; action calls never consult intent defaults.
export async function pickActionHandler(
  callerLabel: string,
  actionName: string,
  payload: unknown,
  candidates: string[],
  openCandidates: NappWindowState[],
  compatibleIntent?: IntentRequest
): Promise<HandlerSelection> {
  type Choice = ActionTarget | { intent: IntentRequest } | null
  const lifetime = new AbortController()
  let unsubscribe = () => {}
  const build = (resolve: (choice: Choice) => void) => {
    const root = document.createElement("div")
    root.className = "intent-chooser"
    const napps = buildHandlerBody({
      showRequest: false,
      actionName,
      payload,
      candidates,
      openCandidates,
      apps: { list: persist.getInstalledApps, get: persist.getInstalledApp },
      onSelect: (nappId, instanceId) => resolve({ nappId, instanceId })
    })
    const section = (title: string, body: HTMLElement) => {
      const node = document.createElement("section")
      node.className = "intent-handler-section"
      const heading = document.createElement("h4")
      heading.textContent = title
      node.append(heading, body)
      return node
    }
    root.append(section("Napps", napps))
    if (compatibleIntent) {
      const choices = mountIntentHandlerChoices(compatibleIntent, handler =>
        resolve({ intent: { ...compatibleIntent, handler } })
      )
      root.append(section("Napplets", choices.element))
      unsubscribe = choices.dispose
      // Show installed handlers immediately and fill in remote alternatives as they arrive.
      void discoverIntents(compatibleIntent.convention).catch(() => {})
    }
    return root
  }
  try {
    const choice = await openDialog<Choice>({
      title: "Open with",
      class: "app-dialog-handler",
      queue: { kind: "action", name: callerLabel },
      signal: lifetime.signal,
      build,
      dismissValue: null,
      actions: [{ label: "Cancel", value: null }]
    })
    if (!choice) throw new Error("Action handler selection cancelled")
    return choice
  } finally {
    lifetime.abort()
    unsubscribe()
  }
}
