export const id = "logs"
export const title = "Logs"
export const slash = "/logs"

export function mount(container, ctx) {
  container.innerHTML = `<ul class="logs-view"></ul>`
  const list = container.querySelector(".logs-view")

  function fmtTime(at) {
    return new Date(at).toLocaleTimeString(undefined, { hour12: false })
  }

  function render() {
    list.innerHTML = ""
    for (const entry of ctx.logs.history()) {
      const li = document.createElement("li")
      const time = document.createElement("time")
      const d = new Date(entry.at)
      time.dateTime = d.toISOString()
      time.textContent = fmtTime(entry.at)
      const pre = document.createElement("pre")
      pre.textContent = entry.msg
      li.append(time, pre)
      list.appendChild(li)
    }
    const scroller = list.closest(".napp-body")
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  render()
  const unsub = ctx.logs.subscribe(render)

  return {
    unmount() {
      unsub()
    }
  }
}
