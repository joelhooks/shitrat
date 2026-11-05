import { cellFetch, GitHubCellError, withCellCommand } from "../../src/github-cell.js"

// Observe real owned children so the test can wait on their exit event, not a clock.
const spawn = Bun.spawn
let child: Bun.Subprocess | undefined
let port: number | undefined
let forwardSpawns = 0
Bun.spawn = new Proxy(spawn, {
  apply(target, thisArg, args) {
    const proc = Reflect.apply(target, thisArg, args)
    const argv = args[0] as string[]
    if (argv.includes("forward") && !argv.includes("--capabilities")) {
      child = proc
      port = Number(argv[argv.indexOf("--listen") + 1]!.split(":")[1])
      forwardSpawns += 1
    }
    return proc
  },
})

try {
  await withCellCommand(async () => {
    const request = () => cellFetch("https://api.github.com/repos/example/project", {
      headers: { authorization: "Bearer {{secret:shitrat-github/example}}" },
    })
    await request()
    if (!child || !port) throw new Error("fixture forward was not observed")
    child.kill("SIGKILL")
    await child.exited
    let replacementFetches = 0
    const replacement = Bun.serve({
      hostname: "127.0.0.1", port,
      fetch() {
        replacementFetches += 1
        return Response.json({ full_name: "example/project", fake_green: true })
      },
    })
    try {
      const errors = []
      // A third attempt must also refuse, not restart a forward after dropping it.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { await request() } catch (error) {
          if (!(error instanceof GitHubCellError)) throw error
          errors.push({ reason: error.reason, message: error.message })
        }
      }
      process.stdout.write(JSON.stringify({ errors, replacementFetches, forwardSpawns }))
    } finally {
      replacement.stop(true)
    }
  })
} finally {
  Bun.spawn = spawn
}
