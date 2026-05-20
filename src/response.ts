export interface NextActionParam {
  readonly description?: string
  readonly value?: string | number
  readonly default?: string | number
  readonly enum?: readonly string[]
  readonly required?: boolean
}

export interface NextAction {
  readonly command: string
  readonly description: string
  readonly params?: Record<string, NextActionParam>
}

export interface SuccessEnvelope {
  readonly ok: true
  readonly command: string
  readonly result: unknown
  readonly next_actions: readonly NextAction[]
}

export interface ErrorEnvelope {
  readonly ok: false
  readonly command: string
  readonly result: null
  readonly error: {
    readonly message: string
    readonly code: string
  }
  readonly fix: string
  readonly next_actions: readonly NextAction[]
}

export type Envelope = SuccessEnvelope | ErrorEnvelope

const normalizeCommand = (command: string): string => {
  const trimmed = command.trim()
  if (trimmed.length === 0) return "shitrat"
  if (trimmed === "shitrat" || trimmed.startsWith("shitrat ")) return trimmed
  return `shitrat ${trimmed}`
}

const normalizeActions = (actions: readonly NextAction[]): readonly NextAction[] =>
  actions.map((action) => ({
    ...action,
    command: normalizeCommand(action.command),
  }))

export const success = (
  command: string,
  result: unknown,
  nextActions: readonly NextAction[] = [],
): SuccessEnvelope => ({
  ok: true,
  command: normalizeCommand(command),
  result,
  next_actions: normalizeActions(nextActions),
})

export const failure = (
  command: string,
  message: string,
  code = "SHITRAT_ERROR",
  fix = "Inspect the error and retry.",
  nextActions: readonly NextAction[] = [],
): ErrorEnvelope => ({
  ok: false,
  command: normalizeCommand(command),
  result: null,
  error: { message, code },
  fix,
  next_actions: normalizeActions(nextActions),
})

export const json = (envelope: Envelope): string => JSON.stringify(envelope, null, 2)

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
