import { Octokit } from "@octokit/rest"
import { describe, expect, test } from "bun:test"
import { setWorkflowState, type WorkflowAction } from "../src/ci-reads.js"

const ref = { owner: "o", repo: "r" }
const workflow = (state: string) => ({ id: 42, name: "Deploy", path: ".github/workflows/deploy.yml", state, html_url: "https://github.com/o/r/actions/workflows/deploy.yml" })

// All requests stop at this fetch boundary. Unexpected routes never reach the network.
const github = (initial: string, action: WorkflowAction, status = 200, readback?: string) => {
  const requests: string[] = []
  let state = initial
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const key = `${init?.method ?? "GET"} ${url.pathname}`
    requests.push(key)
    const base = "/repos/o/r/actions/workflows/"
    if (key === `PUT ${base}deploy.yml/${action}` || key === `PUT ${base}42/${action}`) {
      state = readback ?? (action === "enable" ? "active" : "disabled_manually")
      return new Response(null, { status: 204 })
    }
    if (key !== `GET ${base}deploy.yml` && key !== `GET ${base}42`) throw new Error(`Unexpected request: ${key}`)
    return new Response(JSON.stringify(status === 200 ? workflow(state) : { message: "Request refused" }), {
      status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
    })
  }
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  return { octokit: new Octokit({ request: { fetch }, log: quiet }), requests }
}

describe("workflow state", () => {
  for (const action of ["enable", "disable"] as const) {
    const target = action === "enable" ? "active" : "disabled_manually"
    const initial = action === "enable" ? "disabled_manually" : "active"
    test(`${action}: reads, writes and reads back`, async () => {
      const gh = github(initial, action)
      const id = action === "enable" ? "deploy.yml" : "42"
      const result = await setWorkflowState(gh.octokit, ref, id, action, false)
      expect(result.before.state).toBe(initial)
      expect(result.after.state).toBe(target)
      expect(result.changed).toBe(true)
      expect(gh.requests).toEqual([
        `GET /repos/o/r/actions/workflows/${id}`,
        `PUT /repos/o/r/actions/workflows/${id}/${action}`,
        `GET /repos/o/r/actions/workflows/${id}`,
      ])
    })
    test(`${action}: already in target state makes no write`, async () => {
      const gh = github(target, action)
      const result = await setWorkflowState(gh.octokit, ref, "deploy.yml", action, false)
      expect(result.changed).toBe(false)
      expect(result.before).toEqual(result.after)
      expect(gh.requests).toEqual(["GET /repos/o/r/actions/workflows/deploy.yml"])
    })
    test(`${action}: dry run makes no write`, async () => {
      const gh = github(initial, action)
      const result = await setWorkflowState(gh.octokit, ref, "deploy.yml", action, true)
      expect(result.changed).toBe(false)
      expect(result.target_state).toBe(target)
      expect(result.before.state).toBe(initial)
      expect(result.after).toEqual(result.before)
      expect(gh.requests).toEqual(["GET /repos/o/r/actions/workflows/deploy.yml"])
    })
  }
  test("reports actual readback rather than assuming the target state", async () => {
    const gh = github("disabled_manually", "enable", 200, "disabled_manually")
    const result = await setWorkflowState(gh.octokit, ref, "deploy.yml", "enable", false)
    expect(result.changed).toBe(true)
    expect(result.after.state).toBe("disabled_manually")
  })
  for (const [status, code] of [[404, "NOT_FOUND"], [403, "PERMISSION_DENIED"], [422, "INVALID_INPUT"]] as const) {
    test(`translates ${status} and writes nothing`, async () => {
      const gh = github("active", "enable", status)
      await expect(setWorkflowState(gh.octokit, ref, "deploy.yml", "enable", false)).rejects.toMatchObject({ code })
      expect(gh.requests).toEqual(["GET /repos/o/r/actions/workflows/deploy.yml"])
    })
  }
  for (const input of ["", "0", "-1", "1.5", "9007199254740992", ".github/workflows/deploy.yml", "no-workflow", "bad name.yml"]) {
    test(`rejects invalid input ${JSON.stringify(input)} before any request`, async () => {
      const gh = github("active", "enable")
      await expect(setWorkflowState(gh.octokit, ref, input, "enable", false)).rejects.toMatchObject({ code: "INVALID_INPUT" })
      expect(gh.requests).toEqual([])
    })
  }
})
