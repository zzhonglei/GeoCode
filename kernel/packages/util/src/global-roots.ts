import os from "os"
import path from "path"

const home = os.homedir()
/* --- GeoCode: fixed under the home directory; the XDG variables stay for the user's own tools ---
const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)
--- /GeoCode --- */
const data = home ? path.join(home, ".local", "share") : undefined // GeoCode: see above
const cache = home ? path.join(home, ".cache") : undefined // GeoCode: see above
const config = home ? path.join(home, ".config") : undefined // GeoCode: see above
const state = home ? path.join(home, ".local", "state") : undefined // GeoCode: see above

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    tmp: path.join(os.tmpdir(), app),
  }
}
