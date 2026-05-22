import * as settings from "./settings.js"
import * as logs from "./logs.js"
import * as permissions from "./permissions.js"
import * as store from "./store.js"
import * as apps from "./apps.js"
import * as database from "./database.js"
import * as appInfo from "./app-info.js"
import * as uploader from "./uploader.js"

const napps = [settings, logs, permissions, store, apps, database, uploader]

// Slash actions are like system napps but they fire a one-shot side effect
// (e.g. opening a file picker) instead of mounting a window.
const actions = [
  {
    id: "folder",
    title: "Load folder",
    slash: "/folder",
    run(ctx) {
      ctx.loadFolder()
    }
  }
]

export const registry = Object.fromEntries(napps.map(s => [s.id, s]))
registry[appInfo.id] = appInfo
export const list = napps

export const actionRegistry = Object.fromEntries(actions.map(a => [a.id, a]))
export const actionList = actions

export const slashCommands = Object.fromEntries(napps.map(s => [s.slash, s.id]))
export const slashActions = Object.fromEntries(actions.map(a => [a.slash, a.id]))
