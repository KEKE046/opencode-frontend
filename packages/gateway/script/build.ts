import path from "node:path"
import { $ } from "bun"

const root = path.resolve(import.meta.dirname, "../../..")
const app = path.join(root, "packages/app")
const dist = path.join(app, "dist")
const dir = path.resolve(import.meta.dirname, "..")

// 1. build frontend
console.log("building frontend...")
await $`bun run --cwd ${app} build`

// 2. generate asset map (same pattern as opencode createEmbeddedWebUIBundle)
console.log("generating asset map...")
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
  .map((f) => f.replaceAll("\\", "/"))
  .sort()

const imports = files.map((f, i) => {
  const spec = path.relative(dir, path.join(dist, f)).replaceAll("\\", "/")
  return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
})
const entries = files.map((f, i) => `  ${JSON.stringify(f)}: file_${i},`)
const gen = [...imports, `export default {`, ...entries, `}`].join("\n")

// 3. compile single binary
console.log("compiling binary...")
await $`rm -rf ${path.join(dir, "dist")}`
await $`mkdir -p ${path.join(dir, "dist")}`

await Bun.build({
  entrypoints: ["./src/index.ts", "gateway-assets.gen.ts"],
  files: { "gateway-assets.gen.ts": gen },
  compile: {
    target: `bun-${process.platform}-${process.arch}` as any,
    outfile: "dist/opencode-gateway",
  },
})

console.log("done: dist/opencode-gateway")
