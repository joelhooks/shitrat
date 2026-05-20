#!/usr/bin/env bun

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { commentCmd, installationsCmd, reviewCmd, statusCmd } from "./commands/github.js"
import { json, success } from "./response.js"

const root = Command.make("shitrat", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      json(
        success(
          "",
          {
            description:
              "ShitRat CLI — GitHub App bot actions for agent-owned comments, PR reviews, and repo work.",
            actor: "shitratgit[bot]",
            github_app: "https://github.com/apps/shitratgit",
            commands: {
              installations: "shitrat installations",
              status: "shitrat status <owner/repo>",
              comment: "shitrat comment <owner/repo> <issue-or-pr-number> --body-file <path>",
              review:
                "shitrat review <owner/repo> <pull-number> --event APPROVE|REQUEST_CHANGES|COMMENT --body-file <path>",
            },
            secrets: [
              "shitrat_github_app_id",
              "shitrat_github_private_key",
              "shitrat_github_installations_json",
              "shitrat_github_installation_id_<owner_key>",
            ],
          },
          [
            {
              command: "installations",
              description: "List installed accounts for the ShitRat GitHub App",
            },
            {
              command: "status <repo>",
              description: "Verify ShitRat can access a repository",
              params: {
                repo: {
                  required: true,
                  description: "Repository in owner/repo form",
                  value: "skillrecordings/migrate-egghead",
                },
              },
            },
            {
              command: "comment <repo> <number> --body-file <path>",
              description: "Post an issue or PR conversation comment as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                number: { required: true, description: "Issue or PR number" },
                path: { required: true, description: "Markdown body file" },
              },
            },
            {
              command: "review <repo> <number> --event <event> --body-file <path>",
              description: "Create a pull request review as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                number: { required: true, description: "PR number" },
                event: {
                  enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
                  default: "COMMENT",
                },
                path: { required: true, description: "Markdown body file" },
              },
            },
          ],
        ),
      ),
    )
  }),
).pipe(Command.withSubcommands([installationsCmd, statusCmd, commentCmd, reviewCmd]))

const cli = Command.run(root, {
  name: "shitrat",
  version: "0.1.0",
})

// Compatibility no-ops. JSON is the only output format.
const argv = process.argv.filter((arg) => arg !== "--json" && arg !== "--toon")

cli(argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
