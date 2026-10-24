import path from "node:path"
import { Geocodekit } from "../src/python/geocodekit.ts"

// One self-contained ESM file: the app loads it in an Electron utility process, which runs Node, not Bun.
const root = path.resolve(import.meta.dirname, "..")

const result = await Bun.build({
  entrypoints: [path.join(root, "src/main.ts")],
  outdir: path.join(root, "dist"),
  target: "node",
  format: "esm",
  naming: "geoengine.mjs",
  // GeoCode's Python package and version number, inlined: the app keeps the engine in its archive, where nothing could
  // read the package's files, and has no desktop folder to read the version from.
  define: { "globalThis.GEOCODEKIT": JSON.stringify(Geocodekit.read(root)) },
  plugins: [
    {
      // Its default entry is UMD, which loads its own files through a `require` the bundler cannot follow; Node
      // still needs that entry, since the ESM build imports without file extensions.
      name: "jsonc-parser-esm",
      setup: (build) =>
        void build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: path.join(root, "node_modules/jsonc-parser/lib/esm/main.js"),
        })),
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`built ${path.join(root, "dist/geoengine.mjs")}`)
