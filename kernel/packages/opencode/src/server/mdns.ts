import { Bonjour } from "bonjour-service"
import { Brand } from "@opencode-ai/core/brand" // GeoCode: own module

let bonjour: Bonjour | undefined
let currentPort: number | undefined

export function publish(port: number, domain?: string) {
  if (currentPort === port) return
  if (bonjour) unpublish()

  try {
    // GeoCode: branded mDNS identity
    const host = domain ?? Brand.mdnsHost
    const name = Brand.mdnsService(port)
    bonjour = new Bonjour()
    const service = bonjour.publish({
      name,
      type: "http",
      host,
      port,
      txt: { path: "/" },
    })

    service.on("error", () => {})

    currentPort = port
  } catch {
    if (bonjour) {
      try {
        bonjour.destroy()
      } catch {}
    }
    bonjour = undefined
    currentPort = undefined
  }
}

export function unpublish() {
  if (bonjour) {
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    } catch {}
    bonjour = undefined
    currentPort = undefined
  }
}

export * as MDNS from "./mdns"
