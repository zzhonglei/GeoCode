import path from "node:path"
import { Library } from "../src/gee/library.ts"

// One self-contained ESM file: the app loads it in an Electron utility process, which runs Node, not Bun.
const root = path.resolve(import.meta.dirname, "..")

const result = await Bun.build({
  entrypoints: [path.join(root, "src/main.ts")],
  outdir: path.join(root, "dist"),
  target: "node",
  format: "esm",
  naming: "geoengine.mjs",
  // GeoCode's Python package, inlined: the app keeps the engine in its archive, where a Python could not read the files.
  define: { "globalThis.GEOCODE_PACKAGE": JSON.stringify(Library.read(path.join(root, "python"))) },
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
