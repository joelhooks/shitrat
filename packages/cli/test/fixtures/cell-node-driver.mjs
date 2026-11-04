// Run the adapter under actual Node, with no Bun global or runtime shim.
const { GitHubCellError, prepareCell, withCellForward } = await import(process.argv[2])
const errors = []
for (const run of [() => prepareCell("example"), () => withCellForward({ host: "api.github.com", run: async () => {} })]) {
  try { await run() } catch (error) {
    if (!(error instanceof GitHubCellError)) throw error
    errors.push({ reason: error.reason, message: error.message })
  }
}
process.stdout.write(JSON.stringify({ errors }))
