export type HarnessTarget = "codex-desktop" | "pi" | "claude"

export type ModuleFormat = "md" | "mdx" | "svx"

export interface FamiliarIdentity {
  readonly name: string
  readonly emoji?: string
  readonly voice?: string
}

export interface PromptModule {
  readonly id: string
  readonly title: string
  readonly format: ModuleFormat
  readonly body: string
  readonly scope?: "global" | HarnessTarget
  readonly tags?: readonly string[]
  readonly sourcePath?: string
  readonly priority?: number
}

export interface SemanticComponent {
  readonly type: string
  readonly id: string
  readonly body: string
  readonly attrs?: Readonly<Record<string, string>>
  readonly sourceModuleId?: string
}

export interface FamiliarProfile {
  readonly identity: FamiliarIdentity
  readonly modules: readonly PromptModule[]
  readonly components?: readonly SemanticComponent[]
}

export interface FamiliarProfileOverlay {
  readonly identity?: Partial<FamiliarIdentity>
  readonly modules?: readonly PromptModule[]
  readonly components?: readonly SemanticComponent[]
}

export interface CompiledPrompt {
  readonly target: HarnessTarget
  readonly text: string
  readonly receipts: readonly string[]
  readonly componentTypes: readonly string[]
}

export const hardLawIds = [
  "receipt-first",
  "preserve-user-work",
  "public-private-boundary",
  "harness-honesty",
  "familiar-consistency",
  "brain-first-context",
] as const

export type HardLawId = (typeof hardLawIds)[number]

export interface ValidationIssue {
  readonly code: string
  readonly message: string
  readonly moduleId?: string
}

export const formatFromPath = (path: string): ModuleFormat => {
  if (path.endsWith(".mdx")) return "mdx"
  if (path.endsWith(".svx")) return "svx"
  return "md"
}

export const createPromptModule = (input: {
  readonly id: string
  readonly title?: string
  readonly body: string
  readonly sourcePath?: string
  readonly scope?: "global" | HarnessTarget
  readonly tags?: readonly string[]
  readonly priority?: number
}): PromptModule => {
  const module: PromptModule = {
    id: input.id,
    title: input.title ?? input.id,
    format: input.sourcePath ? formatFromPath(input.sourcePath) : "md",
    body: input.body.trim(),
    scope: input.scope ?? "global",
  }

  return {
    ...module,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  }
}

export const composeProfiles = (
  base: FamiliarProfile,
  overlay?: FamiliarProfileOverlay,
): FamiliarProfile => {
  const overlayModules = overlay?.modules ?? []
  const baseModules = base.modules.filter(
    (module) => !overlayModules.some((overlayModule) => overlayModule.id === module.id),
  )

  return {
    identity: {
      ...base.identity,
      ...overlay?.identity,
    },
    modules: [...baseModules, ...overlayModules].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id),
    ),
    components: [...(base.components ?? []), ...(overlay?.components ?? [])],
  }
}

export const parseSemanticComponents = (module: PromptModule): readonly SemanticComponent[] => {
  const components: SemanticComponent[] = []
  const pattern = /<([A-Z][A-Za-z0-9]*)\s+([^>]*)>([\s\S]*?)<\/\1>/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(module.body)) !== null) {
    const [, rawType, attrsText = "", body = ""] = match
    const type = rawType ?? "Component"
    const attrs = Object.fromEntries(
      [...attrsText.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)].map((attrMatch) => [
        attrMatch[1] ?? "",
        attrMatch[2] ?? "",
      ]),
    )
    components.push({
      type,
      id: attrs.id || `${module.id}:${components.length + 1}`,
      attrs,
      body: body.trim(),
      sourceModuleId: module.id,
    })
  }

  return components
}

export const collectComponents = (profile: FamiliarProfile): readonly SemanticComponent[] => [
  ...(profile.components ?? []),
  ...profile.modules.flatMap((module) => parseSemanticComponents(module)),
]

export const validateHardLaws = (profile: FamiliarProfile): readonly ValidationIssue[] => {
  const text = profile.modules.map((module) => `${module.id}\n${module.body}`).join("\n").toLowerCase()

  return hardLawIds.flatMap((id) =>
    text.includes(id)
      ? []
      : [
          {
            code: "MISSING_HARD_LAW",
            message: `Missing hard law coverage: ${id}`,
          },
        ],
  )
}

export const validateProfile = (profile: FamiliarProfile): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  if (!profile.identity.name.trim()) {
    issues.push({ code: "MISSING_IDENTITY_NAME", message: "Familiar identity requires a name." })
  }

  const seen = new Set<string>()
  for (const module of profile.modules) {
    if (seen.has(module.id)) {
      issues.push({
        code: "DUPLICATE_MODULE",
        message: `Duplicate module id: ${module.id}`,
        moduleId: module.id,
      })
    }
    seen.add(module.id)
  }

  issues.push(...validateHardLaws(profile))
  return issues
}

export const compilePrompt = (profile: FamiliarProfile, target: HarnessTarget): CompiledPrompt => {
  const targetModules = profile.modules.filter(
    (module) => module.scope === "global" || module.scope === target,
  )
  const receipts = targetModules
    .map((module) => module.sourcePath)
    .filter((sourcePath): sourcePath is string => Boolean(sourcePath))
  const components = collectComponents({ ...profile, modules: targetModules })

  const header = [`# ${profile.identity.emoji ? `${profile.identity.emoji} ` : ""}${profile.identity.name}`, ""]
  const sections = targetModules.flatMap((module) => [
    `## ${module.title}`,
    "",
    module.body,
    "",
  ])

  return {
    target,
    text: [...header, ...sections].join("\n").trim(),
    receipts,
    componentTypes: [...new Set(components.map((component) => component.type))].sort(),
  }
}

export const parityReport = (
  profile: FamiliarProfile,
  targets: readonly HarnessTarget[],
): Readonly<Record<HarnessTarget, readonly ValidationIssue[]>> =>
  Object.fromEntries(
    targets.map((target) => {
      const scopedProfile: FamiliarProfile = {
        ...profile,
        modules: profile.modules.filter((module) => module.scope === "global" || module.scope === target),
      }
      return [target, validateProfile(scopedProfile)]
    }),
  ) as Readonly<Record<HarnessTarget, readonly ValidationIssue[]>>
