import * as settings from "./settings.js"
import * as logs from "./logs.js"
import * as apps from "./apps.js"
import * as uploader from "./uploader.js"

import type { SystemNappDef } from "../types.js"

const napps = [settings, logs, apps] satisfies SystemNappDef[]

// Slash actions are like system napps but they fire a one-shot side effect
// (e.g. opening a file picker) instead of mounting a window.
const actions = [
  {
    id: "folder",
    title: "Load folder",
    slash: "/folder",
    run(ctx: any) {
      ctx.loadFolder()
    }
  },
  {
    id: "dev",
    title: "Load dev app",
    slash: "/dev",
    run(ctx: any) {
      ctx.installDevApp()
    }
  }
]

export type { SystemNappDef as SystemNapp }

export const registry: Record<string, SystemNappDef> = Object.fromEntries(napps.map(s => [s.id, s]))
registry[uploader.id] = uploader
export const list = napps

export const actionRegistry = Object.fromEntries(actions.map(a => [a.id, a]))
export const actionList = actions

export const slashCommands: Record<string, string> = Object.fromEntries(
  napps.map(s => [s.slash, s.id])
)
export const slashActions: Record<string, string> = Object.fromEntries(
  actions.map(a => [a.slash, a.id])
)
