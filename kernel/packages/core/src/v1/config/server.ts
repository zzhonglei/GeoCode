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
    // GeoCode: quotes Brand.mdnsHost, the default actually served, rather than a second literal (docs/PATHS.md §5)
    description: `Custom domain name for mDNS service (default: ${Brand.mdnsHost})`,
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>
