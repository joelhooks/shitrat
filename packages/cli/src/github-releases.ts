import type { GitHubOctokit, RepoRef } from "./github-app.js"

export class GitHubReleaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "GitHubReleaseError"
  }
}

function fail(code: string, message: string): never {
  throw new GitHubReleaseError(code, message)
}
const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && error.status === 404

// Never surface SDK request objects, response bodies, or credentials in the envelope.
const request = async <A>(operation: string, run: () => Promise<A>): Promise<A> => {
  try { return await run() } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined
    throw new GitHubReleaseError("GITHUB_REQUEST_FAILED", `${operation} failed${typeof status === "number" ? ` (HTTP ${status})` : ""}. Inspect repository state before retrying; a write may have succeeded.`)
  }
}

const optionalRead = async <A>(operation: string, run: () => Promise<A>): Promise<A | undefined> =>
  request(operation, async () => {
    try { return await run() } catch (error) { if (isNotFound(error)) return undefined; throw error }
  })

const validateTag = (tag: string) => {
  // Git check-ref-format rules, applied to refs/tags/<tag>; no subprocess or shell interpolation.
  if (!tag || tag === "@" || /[\x00-\x20\x7f~^:?*\[\\]/.test(tag) || tag.includes("..") || tag.includes("@{") ||
    tag.endsWith(".") || tag.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    fail("INVALID_TAG", "Use a valid tag name, without the refs/tags/ prefix.")
  }
  if (tag.startsWith("refs/")) fail("INVALID_TAG", "Pass the tag name, not a full ref.")
}

export const createAnnotatedTag = async (
  octokit: GitHubOctokit,
  repo: RepoRef,
  input: { name: string; target: string; message?: string | undefined },
  dryRun: boolean,
) => {
  validateTag(input.name)
  if (!/^[a-fA-F0-9]{40}$/.test(input.target)) fail("INVALID_TARGET_SHA", "--target must be a full 40-character commit SHA.")
  const target = input.target.toLowerCase()
  const ref = { owner: repo.owner, repo: repo.repo, ref: `tags/${input.name}` }
  const existing = await optionalRead("Read tag ref", () => octokit.rest.git.getRef(ref))
  if (existing) fail("TAG_EXISTS", `Tag ${input.name} already exists. Tags are never moved or overwritten.`)
  const commit = await optionalRead("Read target commit", () => octokit.rest.git.getCommit({ owner: repo.owner, repo: repo.repo, commit_sha: target }))
  if (!commit || commit.data.sha !== target) fail("TARGET_NOT_FOUND", "The full target commit SHA does not exist in this repository.")
  const payload = {
    tag: input.name, message: input.message ?? input.name, object: target, type: "commit" as const,
    tagger: { name: "shitratgit[bot]", email: "286405550+shitratgit[bot]@users.noreply.github.com", date: new Date().toISOString() },
  }
  const refPayload = { ref: `refs/tags/${input.name}`, sha: "<created-tag-object-sha>" }
  if (dryRun) return { created: false, tag: input.name, target, tag_object_payload: payload, ref_payload: refPayload }

  const created = await request("Create annotated tag object", () => octokit.rest.git.createTag({ owner: repo.owner, repo: repo.repo, ...payload }))
  // createRef is create-only. A competing writer gets a 422, never an updateRef.
  const writtenRef = { ...refPayload, sha: created.data.sha }
  await request("Create tag ref", () => octokit.rest.git.createRef({ owner: repo.owner, repo: repo.repo, ...writtenRef }))
  const readRef = await request("Read back tag ref", () => octokit.rest.git.getRef(ref))
  const readTag = await request("Read back annotated tag", () => octokit.rest.git.getTag({ owner: repo.owner, repo: repo.repo, tag_sha: created.data.sha }))
  if (readRef.data.ref !== writtenRef.ref || readRef.data.object.type !== "tag" || readRef.data.object.sha !== created.data.sha ||
    readTag.data.sha !== created.data.sha || readTag.data.tag !== payload.tag ||
    // GitHub normalizes tag annotations with a trailing newline; ignore exactly one, not arbitrary whitespace.
    readTag.data.message.replace(/\n$/, "") !== payload.message.replace(/\n$/, "") ||
    readTag.data.object.type !== "commit" || readTag.data.object.sha !== target) {
    fail("TAG_READBACK_MISMATCH", "Tag read-back did not match the requested annotation and target. Inspect the tag; no rollback was attempted.")
  }
  return { created: true, tag: input.name, target, tag_object_sha: created.data.sha, tag_object_payload: payload, ref_payload: writtenRef }
}

export const createGitHubRelease = async (
  octokit: GitHubOctokit,
  repo: RepoRef,
  input: { tag: string; title?: string | undefined; notes?: string | undefined; generateNotes: boolean; draft: boolean; prerelease: boolean },
  dryRun: boolean,
) => {
  validateTag(input.tag)
  if (input.notes !== undefined && input.generateNotes) fail("INVALID_RELEASE_NOTES", "Use either --notes-file or --generate-notes, not both.")
  const repository = { owner: repo.owner, repo: repo.repo }
  const tag = await optionalRead("Read release tag", () => octokit.rest.git.getRef({ ...repository, ref: `tags/${input.tag}` }))
  if (!tag) fail("TAG_NOT_FOUND", "The release tag must already exist. Create it separately with tag before releasing.")
  // Include drafts: getReleaseByTag only guarantees published releases. Installation contents:write can list drafts.
  const releases = await request("List existing releases", () => octokit.paginate(octokit.rest.repos.listReleases, { ...repository, per_page: 100 }))
  if (releases.some((release) => release.tag_name === input.tag)) fail("RELEASE_EXISTS", `A release for ${input.tag} already exists, including drafts.`)
  const payload = {
    tag_name: input.tag, name: input.title ?? input.tag,
    ...(input.notes !== undefined ? { body: input.notes } : {}),
    generate_release_notes: input.generateNotes, draft: input.draft, prerelease: input.prerelease,
  }
  if (dryRun) return { created: false, tag: input.tag, payload }
  // Narrow the read/write race after pagination. GitHub offers no atomic require-existing-tag precondition.
  const currentTag = await optionalRead("Recheck release tag", () => octokit.rest.git.getRef({ ...repository, ref: `tags/${input.tag}` }))
  if (!currentTag || currentTag.data.object.sha !== tag.data.object.sha || currentTag.data.object.type !== tag.data.object.type) {
    fail("TAG_CHANGED", "The tag disappeared or changed during release preflight. Inspect it before retrying.")
  }
  const created = await request("Create release", () => octokit.rest.repos.createRelease({ ...repository, ...payload }))
  const read = await request("Read back release", () => octokit.rest.repos.getRelease({ ...repository, release_id: created.data.id }))
  if (read.data.id !== created.data.id || read.data.tag_name !== payload.tag_name || read.data.name !== payload.name ||
    read.data.draft !== payload.draft || read.data.prerelease !== payload.prerelease ||
    read.data.body !== created.data.body || (input.notes !== undefined && read.data.body !== input.notes)) {
    fail("RELEASE_READBACK_MISMATCH", "Release read-back did not match the requested release. Inspect it; no rollback was attempted.")
  }
  return { created: true, tag: input.tag, payload, id: read.data.id, url: read.data.html_url }
}
