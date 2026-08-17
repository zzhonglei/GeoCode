export * as ConfigServerV1 from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"
import { Brand } from "../../brand" // GeoCode: the default quoted below is derived, never spelled

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    // GeoCode: this sentence quotes a default the user will compare against what
    // mdns.ts actually serves, so it is derived from the same constant rather
    // than spelled out — two literals would be two places to keep in step
    // (docs/PATHS.md §5).
    description: `Custom domain name for mDNS service (default: ${Brand.mdnsHost})`,
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>
