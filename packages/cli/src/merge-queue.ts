export type GraphqlClient = <T>(query: string, variables: Record<string, unknown>) => Promise<T>

export type QueueMethod = "merge" | "squash" | "rebase"

export interface PullRequestQueueState {
  id: string
  number: number
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  headRefOid: string
  baseRefName: string
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus: string
  isMergeQueueEnabled: boolean
  isInMergeQueue: boolean
  mergeQueueEntry: { position: number; state: string } | null
}

export interface MergeQueueConfig {
  url: string
  mergeMethod: string | null
}

const PULL_REQUEST_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id number url state isDraft headRefOid baseRefName mergeable mergeStateStatus
      isMergeQueueEnabled isInMergeQueue
      mergeQueueEntry { position state }
    }
  }
}`

const MERGE_QUEUE_QUERY = `query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: $branch) { url configuration { mergeMethod } }
  }
}`

const READY_MUTATION = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { isDraft url }
  }
}`

const DRAFT_MUTATION = `mutation($id: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $id }) {
    pullRequest { isDraft url }
  }
}`

const ENQUEUE_MUTATION = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) {
    mergeQueueEntry { position state }
  }
}`

interface PullRequestRef {
  owner: string
  repo: string
  number: number
}

export const readPullRequestQueueState = async (
  graphql: GraphqlClient,
  ref: PullRequestRef,
): Promise<PullRequestQueueState> => {
  const data = await graphql<{ repository: { pullRequest: PullRequestQueueState | null } | null }>(
    PULL_REQUEST_QUERY,
    { owner: ref.owner, repo: ref.repo, number: ref.number },
  )
  const pull = data.repository?.pullRequest
  if (!pull) throw new Error(`Pull request ${ref.owner}/${ref.repo}#${ref.number} was not found.`)
  return pull
}

const readMergeQueueConfig = async (
  graphql: GraphqlClient,
  ref: PullRequestRef,
  branch: string,
): Promise<MergeQueueConfig | null> => {
  const data = await graphql<{
    repository: { mergeQueue: { url: string; configuration: { mergeMethod: string | null } | null } | null } | null
  }>(MERGE_QUEUE_QUERY, { owner: ref.owner, repo: ref.repo, branch })
  const queue = data.repository?.mergeQueue
  return queue ? { url: queue.url, mergeMethod: queue.configuration?.mergeMethod ?? null } : null
}

export const enqueueRefusal = (
  pull: PullRequestQueueState,
  queue: MergeQueueConfig | null,
  method: QueueMethod | undefined,
): string | undefined => {
  if (pull.state !== "OPEN") return `Pull request #${pull.number} is ${pull.state.toLowerCase()}, not open.`
  if (pull.isDraft) return `Pull request #${pull.number} is a draft. Run ready-pr first.`
  if (!pull.isMergeQueueEnabled || queue === null) {
    return `${pull.baseRefName} has no merge queue. Use merge-pr instead.`
  }
  if (pull.mergeable === "CONFLICTING" || pull.mergeStateStatus === "DIRTY") {
    return `Pull request #${pull.number} is not mergeable: it conflicts with ${pull.baseRefName}.`
  }
  if (method !== undefined && queue.mergeMethod !== null && queue.mergeMethod !== method.toUpperCase()) {
    return `The ${pull.baseRefName} merge queue merges with ${queue.mergeMethod.toLowerCase()}, not ${method}. GitHub cannot override the queue's method per pull request; drop --method or change the queue's ruleset.`
  }
  return undefined
}

export const readyPullRequest = async (
  graphql: GraphqlClient,
  ref: PullRequestRef,
  dryRun: boolean,
) => {
  const pull = await readPullRequestQueueState(graphql, ref)
  if (pull.state !== "OPEN") throw new Error(`Pull request #${pull.number} is ${pull.state.toLowerCase()}, not open.`)
  const base = { number: pull.number, url: pull.url, head: pull.headRefOid }
  if (!pull.isDraft) return { ...base, was_draft: false, is_draft: false, changed: false }
  if (dryRun) return { ...base, was_draft: true, is_draft: true, changed: false }
  const data = await graphql<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean; url: string } } }>(
    READY_MUTATION,
    { id: pull.id },
  )
  return { ...base, was_draft: true, is_draft: data.markPullRequestReadyForReview.pullRequest.isDraft, changed: true }
}

export const convertPullRequestToDraft = async (
  graphql: GraphqlClient,
  ref: PullRequestRef,
  dryRun: boolean,
) => {
  const pull = await readPullRequestQueueState(graphql, ref)
  if (pull.state !== "OPEN") throw new Error(`Pull request #${pull.number} is ${pull.state.toLowerCase()}, not open.`)
  // GitHub drops a pull request from its merge queue when it becomes a draft.
  const base = { number: pull.number, url: pull.url, head: pull.headRefOid, was_queued: pull.isInMergeQueue }
  if (pull.isDraft) return { ...base, was_draft: true, is_draft: true, changed: false }
  if (dryRun) return { ...base, was_draft: false, is_draft: false, changed: false }
  const data = await graphql<{ convertPullRequestToDraft: { pullRequest: { isDraft: boolean; url: string } } }>(
    DRAFT_MUTATION,
    { id: pull.id },
  )
  return { ...base, was_draft: false, is_draft: data.convertPullRequestToDraft.pullRequest.isDraft, changed: true }
}

export const enqueuePullRequest = async (
  graphql: GraphqlClient,
  ref: PullRequestRef,
  method: QueueMethod | undefined,
  dryRun: boolean,
) => {
  const pull = await readPullRequestQueueState(graphql, ref)
  const base = { number: pull.number, url: pull.url, base: pull.baseRefName, head: pull.headRefOid }
  if (pull.isInMergeQueue && pull.mergeQueueEntry) {
    return { ...base, already_queued: true, enqueued: false, position: pull.mergeQueueEntry.position, state: pull.mergeQueueEntry.state }
  }
  const queue = pull.isMergeQueueEnabled ? await readMergeQueueConfig(graphql, ref, pull.baseRefName) : null
  const refusal = enqueueRefusal(pull, queue, method)
  if (refusal) throw new Error(refusal)
  const queueMethod = queue?.mergeMethod?.toLowerCase() ?? null
  if (dryRun) {
    return { ...base, already_queued: false, enqueued: false, queue_method: queueMethod, merge_state: pull.mergeStateStatus }
  }
  const data = await graphql<{ enqueuePullRequest: { mergeQueueEntry: { position: number; state: string } | null } }>(
    ENQUEUE_MUTATION,
    { id: pull.id, head: pull.headRefOid },
  )
  const entry = data.enqueuePullRequest.mergeQueueEntry
  if (!entry) throw new Error(`GitHub accepted the enqueue of #${pull.number} but returned no queue entry; check the queue before retrying.`)
  return { ...base, already_queued: false, enqueued: true, queue_method: queueMethod, position: entry.position, state: entry.state }
}

export const isMergeQueueRequired = (error: unknown): boolean => {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)
  return status === 405 && /merge queue/i.test(message)
}
