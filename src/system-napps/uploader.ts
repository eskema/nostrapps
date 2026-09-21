import { pool } from "@nostr/gadgets/global"
import { currentSigner } from "../signers/index.js"
import {
  areServersEqual,
  createUploadAuth,
  normalizeServerTag,
  uploadBlob
} from "@nostr/tools/nipb7"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export const id = "uploader"
export const title = "Uploader"
export const slash = "/upload"
export const singleton = false
// The folder it was opened with is read after mount, so there's nothing to
// measure then — and a publish form is never small anyway.
export const height = START_HEIGHT

// The app's own blossom server — every fetch path falls back to it, so a blob
// put here is one the launcher can always read back. The account's own list
// supplies the rest. Nothing asks whether an account may upload: a refusal just
// shows as a failed row.
const DEFAULT_BLOSSOM = ["https://relay.nostrapps.com"]

import type { AppType, SystemCtx } from "../types.js"
import { START_HEIGHT } from "../sandbox/napp-window.js"
import { normalizeServer, publishOutcomes } from "../utils.js"
import { onRelayAuth } from "../relay-auth.js"
import { NAPP_NAMED_KIND, NSITE_NAMED_KIND } from "../nsite/fetch.js"
import { NAPPLET_NAMED_KIND, computeAggregateHash, nappletMetaFromHtml } from "../nsite/napplet.js"
import { isIgnoredPath } from "../nsite/ignore.js"
import { guessMime } from "../nsite/mime.js"
import { resolveCardIcon } from "../nsite/icon.js"
import { permRow, unsupportedRequires } from "../napp-permissions.js"
import { slug } from "../nsite/local.js"
import { classifyEvent, computeNappId } from "../persistence.js"
import { addControl, button, check, details, item, itemList, overline } from "./ui.js"
import { code, detailField, renderAppCard } from "./card.js"

// A staged file. The blob hash is what the manifest carries, so hashing here —
// not waiting for a server to tell us — lets the whole event be previewed, and
// the targets edited, before anything leaves the machine.
interface Entry {
  path: string
  file: File
  hash: string
  /** Served content type — the path tag's 4th element (nsite/fetch.ts). */
  mime: string
}

// What's being published, resolved from the files alone.
interface Plan {
  napplet: boolean
  dTag: string
  title: string | null
  description: string | null
  icon: string | null
  actions: string[]
  requires: string[]
  singleton: boolean
  modes: string[]
  initialSize: { width: number; height: number } | null
  /** The files that become path tags — a napplet ships only its index.html. */
  upload: Entry[]
}

const host = (url: string) => url.replace(/^[a-z]+:\/\//, "")

// Per blob, per server. uploadBlob() passes no timeout of its own, so without
// this a server that accepts the connection and never answers hangs the whole
// run — every file waits for the slowest server.
const UPLOAD_TIMEOUT = 30_000

// Blossom endpoints are root-anchored, so a server is its origin — a path on
// one is dropped on the first request.
function serverOrigin(raw: string): string | null {
  try {
    return new URL(normalizeServer(raw)).origin
  } catch {
    return null
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} b`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kb`
  return `${(n / 1048576).toFixed(1)} mb`
}

// A section whose summary doubles as its status line: title + an overline badge
// (count, size, state) — the same shape as the store's relay editor.
function section(label: string, cls: string, open = false) {
  const el = details({ summary: "", open, class: cls })
  const sum = document.createElement("span")
  sum.className = "upload-sum"
  const name = document.createElement("span")
  name.textContent = label
  const badge = overline("")
  sum.append(name, badge)
  el.querySelector("summary")!.appendChild(sum)
  return { el, badge }
}

export function mount(
  container: HTMLElement,
  ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  let files: Entry[] = []
  let metadata: any = null
  let plan: Plan | null = null
  let eventTemplate: any = null
  let publishing = false
  let loadingServers = false
  let dirName: string | null = null // fallback napplet id when the html has no <meta name="id">
  // Set when the caller already knows the flavor/id (a local napplet's publish
  // button) — skips the html-marker guess entirely.
  let forceNapplet = false
  let forcedId: string | null = null
  // Count of OS/editor junk left out, reported in the files badge — silently
  // dropping files would be confusing when something expected doesn't publish.
  let skipped = 0

  // Publish targets, editable for this run only: blossom servers for the blobs,
  // relays for the event. Both seed themselves from the account's own lists —
  // its blossom servers, its write relays on top of the app's own. Unchecking
  // keeps a target listed without publishing to it.
  let servers: string[] = []
  let relays: string[] = ["wss://relay.nostrapps.com"]
  const offServers = new Set<string>()
  const offRelays = new Set<string>()
  const onServers = () => servers.filter(s => !offServers.has(s))
  const onRelays = () => relays.filter(r => !offRelays.has(r))

  // ─── panel ──────────────────────────────────────────────────────
  const panel = document.createElement("div")
  panel.className = "upload-panel"

  const head = document.createElement("div")
  head.className = "upload-head"
  head.hidden = true

  const filesSec = section("files", "upload-files")
  const filesList = itemList("upload-files-list")
  filesSec.el.appendChild(filesList)

  const serversSec = section("blossom servers", "upload-servers")
  const serversList = itemList("upload-servers-list")
  serversSec.el.append(
    serversList,
    addControl({
      label: "add a server",
      placeholder: "https://blossom.example.com",
      onAdd: addServer
    })
  )

  const relaysSec = section("relays", "upload-relays")
  const relaysList = itemList("upload-relays-list")
  const relaysActions = document.createElement("div")
  relaysActions.className = "upload-section-actions"
  relaysActions.appendChild(
    button({ label: "reset to defaults", variant: "ghost", onClick: () => void loadRelays() })
  )
  relaysSec.el.append(
    relaysList,
    addControl({ label: "add a relay", placeholder: "wss://relay.example.com", onAdd: addRelay }),
    relaysActions
  )

  const eventSec = section("event", "upload-event")
  const jsonEl = document.createElement("pre")
  jsonEl.className = "upload-json"
  eventSec.el.appendChild(jsonEl)

  const protectedCb = check({ onChange: () => render() })
  const protectedLabel = permRow(
    protectedCb,
    "protected",
    "prevents re-publishing by others (NIP-70)"
  )
  protectedLabel.classList.add("upload-protected")
  // Lives in the card's own button area (top right), where Apps puts install
  // and delete — so it's rebuilt into each new card rather than owned by the panel.
  const publishBtn = button({ label: "upload & publish", variant: "primary", disabled: true })

  // Only a hard failure speaks up — nothing to publish, or a run that broke.
  // Everything else is legible from the button, the badges and the result rows.
  const errorEl = document.createElement("div")
  errorEl.className = "upload-error"

  const resultsEl = itemList("upload-results")
  resultsEl.hidden = true

  panel.append(head, errorEl, filesSec.el, serversSec.el, relaysSec.el, eventSec.el, resultsEl)
  container.replaceChildren(panel)

  // Shown in the panel and logged, so a failure survives the window being closed.
  function fail(msg: string) {
    errorEl.textContent = msg
    ctx.setStatus(`Uploader: ${msg}`)
  }

  // One row per server (blobs) and per relay (the event): which got everything,
  // which failed and why — the n/m summaries alone don't say who is missing what.
  function resultRow(
    kind: "server" | "relay",
    label: string,
    state: string,
    ok: boolean,
    title: string
  ) {
    const row = item({ label, title }, overline(state))
    row.dataset.kind = kind
    if (!ok) row.classList.add("is-fail")
    resultsEl.appendChild(row)
    resultsEl.hidden = false
  }
  function clearRows(kind: "server" | "relay") {
    for (const el of resultsEl.querySelectorAll(`[data-kind="${kind}"]`)) el.remove()
    resultsEl.hidden = !resultsEl.childElementCount
  }

  // ─── target lists ───────────────────────────────────────────────
  // Both are the editable-list shape: a row per target with a checkbox and a
  // remove, plus an add control. Returns an inline error, or nothing on success
  // (the addControl contract).
  function addServer(raw: string): string | void {
    const trimmed = raw.trim().replace(/\/+$/, "")
    if (!trimmed) return
    let url: URL
    try {
      url = new URL(normalizeServer(trimmed))
    } catch {
      return "not a url"
    }
    // Typed with a path: say so instead of quietly taking it as the root.
    if (url.pathname !== "/") return "blossom servers live at the root of a host"
    if (servers.some(s => areServersEqual(s, url.origin))) return "already in list"
    servers.push(url.origin)
    renderServers()
  }

  function addRelay(raw: string): string | void {
    let url = raw.trim().replace(/\/+$/, "")
    if (!url) return
    if (!/^wss?:\/\//.test(url)) url = `wss://${url}`
    if (relays.includes(url)) return "already in list"
    relays.push(url)
    renderRelays()
  }

  function toggle(off: Set<string>, url: string, on: boolean, repaint: () => void) {
    if (on) off.delete(url)
    else off.add(url)
    repaint()
  }

  function renderServers() {
    serversList.replaceChildren()
    for (const url of servers) {
      const row = item(
        { label: host(url), title: url },
        check({
          checked: !offServers.has(url),
          title: "upload blobs here",
          onChange: on => toggle(offServers, url, on, renderServers)
        }),
        button({
          label: "remove",
          variant: "danger",
          onClick: () => {
            servers = servers.filter(s => s !== url)
            offServers.delete(url)
            renderServers()
          }
        })
      )
      if (offServers.has(url)) row.classList.add("disabled")
      serversList.appendChild(row)
    }
    serversSec.badge.textContent = servers.length
      ? `${onServers().length}/${servers.length}`
      : "none"
    render()
  }

  function renderRelays() {
    relaysList.replaceChildren()
    for (const url of relays) {
      const row = item(
        { label: host(url), title: url },
        check({
          checked: !offRelays.has(url),
          title: "publish the event here",
          onChange: on => toggle(offRelays, url, on, renderRelays)
        }),
        button({
          label: "remove",
          variant: "danger",
          onClick: () => {
            relays = relays.filter(r => r !== url)
            offRelays.delete(url)
            renderRelays()
          }
        })
      )
      if (offRelays.has(url)) row.classList.add("disabled")
      relaysList.appendChild(row)
    }
    relaysSec.badge.textContent = `${onRelays().length}/${relays.length}`
    render()
  }

  function renderFiles() {
    filesList.replaceChildren()
    let total = 0
    for (const f of files) {
      total += f.file.size
      const carried = !plan || plan.upload.includes(f)
      const row = item(
        {
          label: f.path,
          title: carried ? `${f.path}\n${f.mime}\n${f.hash}` : `${f.path} — not published`
        },
        overline(fmtSize(f.file.size))
      )
      if (!carried) row.classList.add("disabled")
      filesList.appendChild(row)
    }
    filesSec.badge.textContent =
      `${files.length} · ${fmtSize(total)}` + (skipped ? ` · ${skipped} skipped` : "")
  }

  // The tier the rest of the app names this: napplet by kind, and an nsite that
  // declares capabilities is a napp, not an nsite. Same classifier the Apps
  // window filters by, fed the tags this publish will carry.
  function flavor(): AppType {
    return classifyEvent({
      kind: plan!.napplet
        ? NAPPLET_NAMED_KIND
        : plan!.actions.length || plan!.requires.length
          ? NAPP_NAMED_KIND
          : NSITE_NAMED_KIND,
      tags: [...plan!.actions.map(a => ["action", a]), ...plan!.requires.map(r => ["requires", r])]
    })
  }

  // Blob URLs minted for the preview icon, revoked when it's replaced.
  const iconUrls: string[] = []
  function dropIconUrls() {
    for (const u of iconUrls.splice(0)) URL.revokeObjectURL(u)
  }

  // The icon Apps will show, resolved the way Apps resolves it — the declared
  // tag, else a conventional filename among the path tags — then mapped back
  // from its sha to the local file, since the blob isn't uploaded yet. A
  // placeholder here means a placeholder there.
  function previewIcon(): string | null {
    if (!eventTemplate) return null
    const { sha, url } = resolveCardIcon(eventTemplate)
    if (url) return url // data:/https: — a napplet's inline icon, or an absolute one
    const f = sha ? plan!.upload.find(x => x.hash === sha) : null
    if (!f) return null
    const objUrl = URL.createObjectURL(f.file)
    iconUrls.push(objUrl)
    return objUrl
  }

  // The head is the Apps window's own card at detail size: same renderer, same
  // icon resolution, so it previews how this publish will look once installed.
  // The d tag rides underneath — publish identity, not part of the Apps look.
  function renderHead() {
    if (!plan) return
    buildTemplate()
    dropIconUrls()
    const card = renderAppCard({
      nappId: plan.dTag,
      title: plan.title || plan.dTag,
      type: flavor(),
      description: plan.description,
      iconUrl: previewIcon(),
      authorPubkey: ctx.account.getPubkey(),
      createdAt: eventTemplate?.created_at ?? null,
      actions: plan.actions,
      search: "",
      buttons: [publishBtn]
    })
    // Requires ride with the action chips, red when this launcher can't provide
    // them — same as the detail view, which is why no warning line is passed.
    if (plan.requires.length) {
      const unsupported = new Set(unsupportedRequires(plan.requires))
      let chips = card.querySelector<HTMLElement>(".apps-handlers")
      if (!chips) {
        chips = document.createElement("div")
        chips.className = "apps-handlers"
        card.appendChild(chips)
      }
      for (const r of plan.requires) {
        const c = document.createElement("span")
        c.className = unsupported.has(r) ? "apps-handler is-unsupported" : "apps-handler"
        c.textContent = r
        chips.appendChild(c)
      }
    }
    // The napp id as Apps spells it — <pubkey>~<d tag> — which needs the
    // pubkey, so it appears once a signer is connected.
    const idBlock = document.createElement("div")
    idBlock.className = "apps-detail-idblock"
    if (eventTemplate) idBlock.appendChild(detailField("id", code(computeNappId(eventTemplate))))
    head.replaceChildren(card, idBlock, protectedLabel)
    head.hidden = false
  }

  // ─── event ──────────────────────────────────────────────────────
  // Built from the local hashes, so the preview is accurate before anything is
  // uploaded. `okServers`, passed after the upload, narrows a napplet's server
  // tags to the ones that actually took the blob.
  function buildTemplate(okServers?: Set<string>) {
    const pubkey = ctx.account.getPubkey()
    if (!plan || !pubkey) {
      eventTemplate = null
      jsonEl.textContent = ""
      return
    }
    const tags: string[][] = []
    // ["path", <path>, <sha256>, <mime>] — the serving worker reads the 4th
    // element and only falls back to guessing from the extension, which knows
    // nothing about .webmanifest, .avif and friends. A napplet's index.html is
    // inlined as srcdoc, never served, so its tag stays the bare 3-element form.
    for (const f of plan.upload)
      tags.push(plan.napplet ? ["path", "/index.html", f.hash] : ["path", f.path, f.hash, f.mime])
    if (plan.napplet) {
      tags.push(["x", computeAggregateHash(tags), "aggregate"])
      for (const s of okServers ? [...okServers] : onServers()) tags.push(["server", s])
    }
    if (protectedCb.checked) tags.push(["-"])
    if (plan.title) tags.push(["title", plan.title])
    if (plan.description) tags.push(["description", plan.description])
    if (plan.icon) tags.push(["icon", plan.icon])
    // Actions ride the napp bridge, which a napplet doesn't have.
    for (const a of plan.actions) tags.push(["action", a])
    // The authored requires list becomes the manifest's ["requires", "<domain>"]
    // tags. `ui`, `network` and the NAP domains all ride the same list.
    for (const r of plan.requires) tags.push(["requires", r])
    // Presentation modes ride as one ["mode", "<mode>"] tag per mode; the
    // preferred auxiliary-window size as ["initial_size", w, h].
    for (const m of plan.modes) tags.push(["mode", m])
    if (plan.initialSize)
      tags.push(["initial_size", String(plan.initialSize.width), String(plan.initialSize.height)])
    // Valueless flag tag — storeInstalledEvent reads its mere presence.
    if (plan.singleton) tags.push(["singleton"])
    tags.push(["d", plan.dTag])

    eventTemplate = {
      kind: plan.napplet
        ? NAPPLET_NAMED_KIND
        : plan.actions.length || plan.requires.length
          ? NAPP_NAMED_KIND
          : NSITE_NAMED_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
      pubkey
    }
    jsonEl.textContent = JSON.stringify(eventTemplate, null, 2)
  }

  // Rebuild the event and gate the button, whose tooltip carries whatever is
  // stopping it — the section badges say the same thing in their own terms.
  function render() {
    buildTemplate()
    const blocker = !plan
      ? null
      : !ctx.account.getPubkey()
        ? "No signer connected."
        : loadingServers
          ? "Loading blossom servers…"
          : onServers().length === 0
            ? "No blossom server picked — add one to publish."
            : onRelays().length === 0
              ? "No relay picked."
              : null
    publishBtn.disabled = publishing || !eventTemplate || !!blocker
    publishBtn.title = blocker || ""
  }

  // ─── reading the input ──────────────────────────────────────────
  async function readDir(dirHandle: any, path: string) {
    for await (const entry of dirHandle.values()) {
      if (isIgnoredPath(path + entry.name)) {
        skipped++
        continue // a directory here takes its whole subtree with it
      }
      if (entry.kind === "file") {
        const file = await entry.getFile()
        const full = path + entry.name
        files.push({ path: full, file, hash: "", mime: file.type || guessMime(full) })
        if (path + entry.name === "metadata.json") {
          try {
            metadata = JSON.parse(await file.text())
          } catch {}
        }
      } else if (entry.kind === "directory") {
        await readDir(entry, path + entry.name + "/")
      }
    }
  }

  // Flavor, d tag and the metadata that becomes tags — all from the files, no
  // network. Returns an error message when there's nothing publishable.
  async function resolve(): Promise<string | null> {
    if (files.length === 0) return "No files selected."

    // A lone index.html publishes as a napplet (kind 35129, metadata read from
    // the html) when the caller said so, or when the html carries a
    // napplet/napplet-* meta as a default.
    const single =
      !metadata && files.length === 1 && files[0].path.replace(/^\//, "") === "index.html"
    const meta = single ? nappletMetaFromHtml(await files[0].file.text()) : null
    const napplet = single && (forceNapplet || !!meta?.napplet)

    let dTag: string | null = metadata?.id || null
    if (napplet) {
      dTag = forcedId || meta!.id || slug(dirName || meta!.title || "") || null
      if (!dTag) return `napplet needs <meta name="napplet-id" content="…"> in its index.html`
    } else if (!dTag) {
      return `metadata.json is missing the "id"`
    }

    const requires = new Set<string>(napplet ? meta!.requires : [])
    if (!napplet && Array.isArray(metadata?.requires)) {
      for (const r of metadata.requires) if (typeof r === "string" && r) requires.add(r)
    }
    // Back-compat: the retired `ui: "wrapper"` field becomes requires: ["ui"].
    if (metadata?.ui === "wrapper") requires.add("ui")

    plan = {
      napplet,
      dTag,
      // Napplet metadata comes from the html; nsite metadata from metadata.json.
      title: napplet ? meta!.title : metadata?.title || metadata?.name || null,
      description: napplet ? meta!.description : metadata?.description || null,
      icon: napplet ? meta!.icon : metadata?.icon || null,
      actions: !napplet && Array.isArray(metadata?.actions) ? metadata.actions : [],
      requires: [...requires],
      // One window at a time. A napplet has no way to declare it (its metadata
      // is read from <meta> tags, which have no singleton spelling), so it's
      // nsite-only — same as actions.
      singleton: !napplet && metadata?.singleton === true,
      // Presentation modes — nsite-only, like actions.
      modes:
        !napplet && Array.isArray(metadata?.modes)
          ? [...new Set<string>(metadata.modes)].filter(
              m => m === "normal" || m === "auxiliary" || m === "headless"
            )
          : [],
      initialSize: (() => {
        if (napplet) return null
        const iz = metadata?.initial_size ?? metadata?.initialSize
        const w = Math.round(Number(iz?.width))
        const h = Math.round(Number(iz?.height))
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
        return { width: Math.min(2000, w), height: Math.min(2000, h) }
      })(),
      // A napplet event carries only /index.html; metadata.json is authoring
      // input. nsites ship metadata.json as a real file alongside its derived
      // tags: the serving worker reads /metadata.json from the installed files.
      upload: napplet ? files.filter(f => f.path.replace(/^\//, "") === "index.html") : files
    }
    return null
  }

  // Both seeds come from the account's own published lists — its blossom list
  // (kind 10063) and its write relays (kind 10002). Editing either here never
  // rewrites the list itself.
  async function loadServers() {
    const pubkey = ctx.account.getPubkey()
    let own: string[] = []
    if (pubkey) {
      loadingServers = true
      serversSec.badge.textContent = "loading…"
      try {
        own = (await loadBlossomServers(pubkey)).items ?? []
      } catch {
        // an unreachable list leaves the app's own server to publish to
      } finally {
        loadingServers = false
      }
    }
    // Origins keyed by host, as the BUD server-list reader treats them.
    const seen = new Set<string>()
    servers = []
    for (const raw of [...DEFAULT_BLOSSOM, ...own]) {
      const origin = serverOrigin(raw)
      if (!origin) continue
      const key = normalizeServerTag(origin)
      if (seen.has(key)) continue
      seen.add(key)
      servers.push(origin)
    }
    offServers.clear()
    renderServers()
  }

  // The app's own relays plus wherever this account publishes, so an app lands
  // in the launcher's discovery AND in the author's outbox.
  async function loadRelays() {
    const pubkey = ctx.account.getPubkey()
    let write: string[] = []
    let isMember = false
    if (pubkey) {
      try {
        const membership = await pool.querySync(
          ["wss://relay.nostrapps.com"],
          { kinds: [13534], limit: 1 },
          { maxWait: 1000 }
        )
        isMember = membership.some(event =>
          event.tags.some(([name, member]) => name === "member" && member === pubkey)
        )
      } catch {}
    }
    if (pubkey) {
      try {
        write = (await loadRelayList(pubkey)).items
          .filter(r => r.write)
          .map(r => r.url.replace(/\/+$/, ""))
      } catch {}
    }
    relays = [
      ...new Set([
        ...(isMember
          ? ["wss://relay.nostrapps.com"]
          : ["wss://relay.nostrapps.com/public", "wss://relay.nostrapps.com/network"]),
        ...write
      ])
    ]
    offRelays.clear()
    renderRelays()
  }

  ;(async () => {
    const initial = opts.params
    if (!initial) {
      fail("No data provided.")
      return
    }

    if (typeof initial.getDirectoryHandle === "function") {
      // FileSystemDirectoryHandle for dev~ apps
      dirName = typeof initial.name === "string" ? initial.name : null
      await readDir(initial, "")
    } else if (Array.isArray(initial) || Array.isArray(initial?.files)) {
      // Pre-read files array. Already filtered on the way in by
      // collectLocalFolder, but a caller assembling its own list shouldn't be
      // able to slip junk past the publish path. The object form carries an
      // explicit napplet flag + id (a local napplet's publish button).
      const list: Array<{ path: string; file: File }> = Array.isArray(initial)
        ? initial
        : initial.files
      forceNapplet = !Array.isArray(initial) && !!initial.napplet
      forcedId = (!Array.isArray(initial) && initial.id) || null
      files = list
        .filter(f => !isIgnoredPath(f.path))
        .map(f => ({ ...f, hash: "", mime: f.file?.type || guessMime(f.path) }))
      skipped = list.length - files.length
      const metaEntry = list.find(f => f.path === "metadata.json")
      if (metaEntry) {
        try {
          const blob = metaEntry.file instanceof Blob ? metaEntry.file : new Blob([metaEntry.file])
          metadata = JSON.parse(await blob.text())
        } catch {}
      }
    } else {
      fail("Invalid data provided.")
      return
    }

    const problem = await resolve()
    if (problem) {
      renderFiles()
      fail(problem)
      return
    }

    for (const f of plan!.upload) {
      f.hash = bytesToHex(sha256(new Uint8Array(await f.file.arrayBuffer())))
    }

    renderHead()
    renderFiles()
    renderRelays() // the app's own relays show at once; the account's join them
    await Promise.all([loadServers(), loadRelays()])
  })()

  // ─── publishing ─────────────────────────────────────────────────
  // Uploaded with the type we resolved, not whatever the OS attached: the blob
  // is stored under it, and it's the one the manifest's path tag names.
  const blobFor = (f: Entry) =>
    f.file.type === f.mime ? f.file : new File([f.file], f.file.name, { type: f.mime })

  // Every blob to every picked server. A file no server took aborts the run —
  // a manifest whose blobs are nowhere installs as a broken app.
  async function upload(signer: any, targets: string[]): Promise<Set<string>> {
    // One auth event for the whole run — an x tag per blob, a server tag per
    // target — so the signer is asked once instead of once per blob per server.
    // Its default expiration is an hour, which has to outlast the upload.
    const auth = await createUploadAuth(
      draft => signer.signEvent(draft),
      plan!.upload.map(f => f.hash),
      { servers: targets }
    )
    const okServers = new Set<string>()
    // Per-server tallies, rendered as result rows — counts reflect attempts, so
    // an aborted run still shows how far each server got.
    const stats = new Map(targets.map(s => [s, { ok: 0, fail: 0, why: "" }]))
    const paint = () => {
      clearRows("server")
      for (const [url, st] of stats)
        resultRow(
          "server",
          host(url),
          `${st.ok}/${st.ok + st.fail} blobs`,
          st.fail === 0,
          st.why ? `${url} — ${st.why}` : url
        )
    }

    // Up front, so the run opens with the servers it is about to use rather
    // than an empty box.
    paint()

    // A server that times out has answered about itself, not about that blob —
    // keep it out of the remaining files rather than paying the wait again.
    const dead = new Set<string>()

    for (const [i, f] of plan!.upload.entries()) {
      publishBtn.textContent = `uploading ${i + 1}/${plan!.upload.length}…`
      const live = targets.filter(s => !dead.has(s))
      if (live.length === 0) {
        paint()
        throw new Error(`No server left to upload ${f.path} to`)
      }
      ctx.setStatus(`Uploader: uploading ${f.path}…`)
      const results = await Promise.allSettled(
        live.map(s =>
          uploadBlob(s, blobFor(f), { auth, signal: AbortSignal.timeout(UPLOAD_TIMEOUT) })
        )
      )
      let stored = 0
      results.forEach((r, i) => {
        const st = stats.get(live[i])!
        // A server that stored the blob under a different hash doesn't have it
        // under the one the manifest names — that's a failure, not a success.
        if (r.status === "fulfilled" && r.value?.sha256 === f.hash) {
          okServers.add(live[i])
          st.ok++
          stored++
        } else {
          st.fail++
          if (r.status === "rejected" && r.reason?.name === "TimeoutError") {
            dead.add(live[i])
            st.why = `no answer in ${UPLOAD_TIMEOUT / 1000}s`
          } else {
            st.why =
              r.status === "rejected"
                ? r.reason?.message || String(r.reason)
                : `hash mismatch (${String(r.value?.sha256).slice(0, 8)}…)`
          }
        }
      })
      if (stored === 0) {
        paint()
        throw new Error(
          `Upload failed for ${f.path}: ${[...stats.values()].map(s => s.why).join("; ")}`
        )
      }
      ctx.setStatus(`Uploaded ${f.path} (${f.hash.slice(0, 8)}…)`)
      paint() // every file, so a slow run shows where it is
    }
    return okServers
  }

  function reset() {
    publishing = false
    publishBtn.textContent = "upload & publish"
    render()
  }

  publishBtn.addEventListener("click", async () => {
    if (publishing || !eventTemplate || !plan) return
    const signer = currentSigner()
    if (!signer) {
      fail("No signer connected.")
      return
    }
    const targets = onServers()
    const relayList = onRelays()
    publishing = true
    publishBtn.disabled = true
    errorEl.textContent = ""
    resultsEl.replaceChildren()
    resultsEl.hidden = true
    // Collapse everything: the result rows are the last thing in the panel, and
    // an open file list puts them a screenful down.
    for (const s of [filesSec, serversSec, relaysSec, eventSec]) s.el.open = false

    try {
      publishBtn.textContent = "authorizing…"
      const okServers = await upload(signer, targets)
      // A napplet's server tags name the servers that actually took the blob.
      buildTemplate(okServers)

      publishBtn.textContent = "signing…"
      const signed = await signer.signEvent(eventTemplate)

      publishBtn.textContent = "publishing…"
      ctx.setStatus("Publishing app event…")
      const outcomes = await publishOutcomes(
        relayList,
        pool.publish(relayList, signed, { onauth: onRelayAuth })
      )
      const okCount = outcomes.filter(o => o.ok).length
      const missing = outcomes.filter(o => !o.ok).map(o => host(o.relay))
      for (const o of outcomes)
        resultRow("relay", host(o.relay), o.ok ? "ok" : o.reason || "failed", o.ok, o.relay)
      ctx.setStatus(
        missing.length
          ? `Published app event to ${okCount}/${relayList.length} relays — missing: ${missing.join(", ")}`
          : `Published app event to all ${relayList.length} relays`
      )
      // The per-relay rows below carry the detail; the log keeps the summary.
      publishBtn.textContent = "published"
      setTimeout(reset, 3000)
    } catch (err) {
      fail((err as any).message)
      publishBtn.textContent = "error"
      setTimeout(reset, 3000)
    }
  })

  const unsubAccount = ctx.account.subscribe(() => {
    void loadServers()
    void loadRelays()
    renderHead()
    render()
  })

  return {
    unmount() {
      unsubAccount()
      dropIconUrls()
    }
  }
}
