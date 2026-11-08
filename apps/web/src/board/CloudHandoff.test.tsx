import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type CloudHandoff,
  type CloudHandoffPreview,
  type CloudHandoffState,
  type GithubStatus,
  type IssueDetail,
  type Repository,
} from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { polls } from "./CloudHandoff.tsx";

const NOW = new Date().toISOString();
const STATE_PATH = "/v1/repositories/101/issues/42/cloud-handoff";
const ROUTINE = "trig_01AbC";
const HASH = `5d1e77a0${"0".repeat(52)}9b21`;
const SESSION = "https://claude.ai/code/session_01XyZ";
const ISSUE_URL = "https://github.com/acme/web/issues/42";

const installed: GithubStatus = {
  configured: true,
  appSlug: "nexus-test",
  installUrl: "https://github.com/apps/nexus-test/installations/new",
  syncedAt: NOW,
  installations: [
    {
      id: 1,
      account: { login: "acme", type: "Organization" },
      repositorySelection: "selected",
      suspended: false,
      permissions: { issues: "read", pull_requests: "write" },
    },
  ],
};
const REPO: Repository = {
  id: "101",
  fullName: "acme/web",
  owner: "acme",
  name: "web",
  private: true,
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/web",
  pushedAt: NOW,
  updatedAt: NOW,
  installationId: 1,
};
const DETAIL: IssueDetail = {
  issue: {
    number: 42,
    title: "Cart totals round wrong",
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    author: "reporter",
    comments: 0,
    createdAt: NOW,
    updatedAt: NOW,
    htmlUrl: ISSUE_URL,
  },
  body: "Totals are wrong.",
  comments: [],
  acceptanceCriteria: ["Rounds per currency minor unit"],
  missingAcceptanceCriteria: false,
  syncedAt: NOW,
};

const handoff = (over: Partial<CloudHandoff> = {}): CloudHandoff => ({
  id: "55555555-5555-4555-8555-555555555555",
  projectId: PROJECT_ID,
  repositoryId: "101",
  repositoryFullName: "acme/web",
  issueNumber: 42,
  routineId: ROUTINE,
  status: "STARTED",
  sessionUrl: SESSION,
  error: null,
  retryAfterSeconds: null,
  pullRequest: null,
  pullRequestCheck: "OK",
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const configured = (latest: CloudHandoff | null = null): CloudHandoffState => ({
  routine: { configured: true, routineId: ROUTINE },
  latest,
});
const preview = (over: Partial<CloudHandoffPreview> = {}): CloudHandoffPreview => ({
  projectId: PROJECT_ID,
  repositoryId: "101",
  repositoryFullName: "acme/web",
  issueNumber: 42,
  routineId: ROUTINE,
  text: `Implement acme/web#42: Cart totals round wrong\n\n\`\`\`\nTotals are wrong. <img src=x onerror=alert(1)>\n\`\`\``,
  rows: [
    { k: "Does", v: "Starts one Claude Code session on claude.ai" },
    { k: "Won't do", v: "Push to main, merge or close the issue" },
  ],
  actionHash: HASH,
  // 3h30m: until() floors hours, so "in 3h" holds however slowly the suite runs.
  expiresAt: new Date(Date.now() + 3.5 * 3600_000).toISOString(),
  ...over,
});
const failure = (status: number, code: string, message: string, details?: unknown) =>
  json(
    { error: { code, message, ...(details !== undefined && { details }) }, requestId: "req-test" },
    status,
  );

function open(
  state: () => CloudHandoffState,
  extra: Parameters<typeof mockFetch>[0] = {},
  path = IN_PROJECT,
) {
  const calls = mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json(installed),
    "GET /v1/repositories": () => json({ items: [REPO], syncedAt: NOW }),
    "GET /v1/repositories/101/issues/42": () => json(DETAIL),
    [`GET ${STATE_PATH}`]: () => json(state()),
    [`POST ${STATE_PATH}/preview`]: () => json(preview()),
    ...extra,
  });
  renderApp(`${path}&drawer=issue:101:42`);
  return calls;
}

const posts = (calls: ReturnType<typeof mockFetch>) =>
  calls.filter((c) => c.method === "POST" && c.path === STATE_PATH);
const handOff = () => screen.findByRole("button", { name: "Hand off to Claude (cloud)" });
const card = () => screen.findByRole("region", { name: "Here’s exactly what Claude will receive." });
const status = () => screen.findByRole("region", { name: /^Claude cloud handoff · sent/ });

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("Claude cloud handoff in the issue drawer", () => {
  it("isn't offered without a routine: says what to do on the home machine instead", async () => {
    const calls = open(() => ({
      routine: {
        configured: false,
        reason: "NO_ROUTINE_FOR_REPO",
        detail: "No routine for acme/web in ~/.nexus/claude-cloud.json.",
        runbook: "docs/runbooks/claude-cloud.md",
      },
      latest: null,
    }));
    expect(
      await screen.findByText(/No routine for acme\/web in ~\/\.nexus\/claude-cloud\.json\./),
    ).toBeTruthy();
    expect(screen.getByText("docs/runbooks/claude-cloud.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hand off to Claude (cloud)" })).toBeNull();
    expect(calls.find((c) => c.path === STATE_PATH)!.query.get("projectId")).toBe(PROJECT_ID);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("needs a Dev project, like Start run, and asks nothing of the API without one", async () => {
    const calls = open(() => configured(), {}, "/?ws=all");
    const button = await handOff();
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /Pick a project first/,
    );
    expect(calls.some((c) => c.path === STATE_PATH)).toBe(false);
  });

  it("previews the exact text, approves it with one key reused on retry, then shows the session", async () => {
    let state = configured();
    let attempts = 0;
    const calls = open(() => state, {
      [`POST ${STATE_PATH}`]: () => {
        if (++attempts === 1) throw new TypeError("network down");
        state = configured(handoff());
        return json(state.latest);
      },
    });
    const user = userEvent.setup();
    const button = await handOff();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);

    const c = await card();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const fact = (k: string) => within(c).getByText(k, { selector: "dt" }).nextElementSibling!.textContent;
    expect(await within(c).findByText("Does", { selector: "dt" })).toBeTruthy();
    expect(document.activeElement).toBe(within(c).getByRole("heading"));
    expect(fact("Won't do")).toBe("Push to main, merge or close the issue");
    expect(fact("Routine")).toBe(ROUTINE);
    expect(fact("Action hash")).toBe("5d1e77a0…9b21");
    expect(fact("Expires")).toBe("in 3h");
    // The text is shown exactly, as text: the HTML in the issue is never rendered.
    const text = within(c).getByLabelText(/Exact text NEXUS will send/);
    expect(text.textContent).toBe(preview().text);
    expect(c.querySelector("img")).toBeNull();
    expect(calls.find((x) => x.path === `${STATE_PATH}/preview`)!.body).toEqual({ projectId: PROJECT_ID });

    await user.click(within(c).getByRole("button", { name: "Approve and send" }));
    expect((await within(c).findByRole("alert")).textContent).toMatch(/Can't reach the NEXUS API/);
    expect(within(c).getByText(/approving again returns that handoff instead/)).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Approve and send" }));

    const s = await status();
    expect(within(s).getByText("Session started")).toBeTruthy();
    const link = within(s).getByRole("link", { name: /Open the session on claude\.ai\s?\(new tab\)/ });
    expect(link.getAttribute("href")).toBe(SESSION);
    expect(link.getAttribute("target")).toBe("_blank");
    const steps = within(within(s).getByRole("list", { name: "Progress" })).getAllByRole("listitem");
    expect(steps.map((li) => li.textContent)).toEqual([
      "✓Sent · session started, done",
      "○PR opened, not yet",
      "○Merged, not yet",
    ]);
    expect(within(s).getByText(/GitHub shows no PR for it yet/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Here’s exactly what Claude will receive." })).toBeNull(),
    );
    expect(document.activeElement).toBe(button);

    const sent = posts(calls);
    expect(sent).toHaveLength(2);
    const key = sent[0]!.headers.get(IDEMPOTENCY_HEADER);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(sent[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    expect(sent[1]!.body).toEqual({ projectId: PROJECT_ID, actionHash: HASH, confirmResend: false });
  });

  it("asks before starting a second session when Claude is already on the issue", async () => {
    const running = handoff();
    const calls = open(() => configured(running), {
      [`POST ${STATE_PATH}`]: (c) =>
        (c.body as { confirmResend: boolean }).confirmResend
          ? json(handoff({ id: "66666666-0000-4000-8000-000000000001", sessionUrl: `${SESSION}2` }))
          : failure(409, "CONFLICT", "Claude is already on this issue; confirm to start another session.", {
              needsConfirmResend: true,
            }),
    });
    const user = userEvent.setup();
    await user.click(await handOff());
    const c = await card();
    await user.click(await within(c).findByRole("button", { name: "Approve and send" }));

    const alert = await within(c).findByRole("alert");
    expect(within(alert).getByText("Claude is already on this issue")).toBeTruthy();
    expect(
      within(alert)
        .getByRole("link", { name: /Open the session/ })
        .getAttribute("href"),
    ).toBe(SESSION);
    expect(within(c).queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(document.activeElement).toBe(within(c).getByRole("button", { name: "Cancel" }));
    await user.click(within(c).getByRole("button", { name: "Confirm: start another session" }));

    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [first, second] = posts(calls);
    expect(second!.body).toEqual({ projectId: PROJECT_ID, actionHash: HASH, confirmResend: true });
    // A different body is a different request: it gets its own key.
    expect(second!.headers.get(IDEMPOTENCY_HEADER)).not.toBe(first!.headers.get(IDEMPOTENCY_HEADER));
  });

  it("shows a changed or expired preview's reason and gives a new key to the next preview", async () => {
    let attempts = 0;
    const calls = open(() => configured(), {
      [`POST ${STATE_PATH}`]: () =>
        ++attempts === 1
          ? failure(409, "CONFLICT", "The issue changed since it was shown; preview it again.")
          : json(handoff()),
    });
    const user = userEvent.setup();
    await user.click(await handOff());
    const c = await card();
    await user.click(await within(c).findByRole("button", { name: "Approve and send" }));
    expect((await within(c).findByRole("alert")).textContent).toBe(
      "The issue changed since it was shown; preview it again.",
    );
    expect(within(c).queryByRole("button", { name: "Approve and send" })).toBeNull();
    await user.click(within(c).getByRole("button", { name: "Preview again" }));
    await user.click(await within(c).findByRole("button", { name: "Approve and send" }));

    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(calls.filter((x) => x.path === `${STATE_PATH}/preview`)).toHaveLength(2);
    const [first, second] = posts(calls);
    expect(second!.headers.get(IDEMPOTENCY_HEADER)).not.toBe(first!.headers.get(IDEMPOTENCY_HEADER));
  });

  it("says when to try again after a rate limit, and doesn't offer the same approval", async () => {
    open(() => configured(), {
      [`POST ${STATE_PATH}`]: () =>
        failure(429, "RATE_LIMITED", "The routine's hourly limit is reached.", { retryAfterSeconds: 600 }),
    });
    const user = userEvent.setup();
    await user.click(await handOff());
    const c = await card();
    await user.click(await within(c).findByRole("button", { name: "Approve and send" }));
    expect((await within(c).findByRole("alert")).textContent).toBe("The routine's hourly limit is reached.");
    expect(within(c).getByText(/You can hand off again in (9|10)m \(at /)).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(within(c).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("an unclear answer from Anthropic: may have started, check claude.ai; the status turns UNKNOWN", async () => {
    let state = configured();
    open(() => state, {
      [`POST ${STATE_PATH}`]: () => {
        state = configured(handoff({ status: "UNKNOWN", sessionUrl: null, pullRequestCheck: "OK" }));
        return failure(502, "UPSTREAM", "Anthropic didn't answer in time.");
      },
    });
    const user = userEvent.setup();
    await user.click(await handOff());
    const c = await card();
    await user.click(await within(c).findByRole("button", { name: "Approve and send" }));
    const alert = await within(c).findByRole("alert");
    expect(alert.textContent).toMatch(
      /Couldn't confirm the session.*Anthropic didn't answer in time\. It may have started/,
    );
    expect(
      within(alert)
        .getByRole("link", { name: /claude\.ai/ })
        .getAttribute("href"),
    ).toBe("https://claude.ai/code/routines");
    expect(within(c).queryByRole("button", { name: "Approve and send" })).toBeNull();

    const s = await status();
    expect(within(s).getByRole("note").textContent).toMatch(
      /Couldn't confirm the session.*A session may exist.*NEXUS never retries on its own/,
    );
    expect(within(s).queryByText("Session started")).toBeNull();
  });

  it("a failed handoff shows the reason and, after a rate limit, when to try again", async () => {
    open(() =>
      configured(
        handoff({
          status: "FAILED",
          sessionUrl: null,
          error: "Rate limited: the routine's hourly limit is reached.",
          retryAfterSeconds: 1800,
          pullRequestCheck: "NOT_APPLICABLE",
        }),
      ),
    );
    const s = await status();
    expect(
      within(s).getByText("Not sent: Rate limited: the routine's hourly limit is reached."),
    ).toBeTruthy();
    expect(within(s).getByText(/Rate limited: you can hand off again in (29|30)m \(at /)).toBeTruthy();
    expect(within(s).queryByRole("list", { name: "Progress" })).toBeNull();
    expect(within(s).queryByRole("link")).toBeNull();
  });

  it("shows the PR GitHub has for the handoff, with its state", async () => {
    open(() =>
      configured(
        handoff({
          pullRequest: {
            number: 7,
            url: "https://github.com/acme/web/pull/7",
            title: "Round per currency",
            branch: "claude/issue-42",
            state: "OPEN",
            draft: true,
          },
        }),
      ),
    );
    const s = await status();
    const pr = within(s).getByRole("link", { name: /PR #7\s?\(new tab\)/ });
    expect(pr.getAttribute("href")).toBe("https://github.com/acme/web/pull/7");
    expect(pr.parentElement!.textContent).toMatch(/PR #7 \(new tab\) ↗ · Draft · Round per currency/);
    const steps = within(within(s).getByRole("list", { name: "Progress" })).getAllByRole("listitem");
    expect(steps.map((li) => li.textContent?.endsWith(", done"))).toEqual([true, true, false]);
  });

  it("never says 'no PR' when GitHub couldn't be read", async () => {
    open(() => configured(handoff({ pullRequestCheck: "UNAVAILABLE" })));
    const s = await status();
    expect(within(s).getByText("Couldn't check GitHub for the PR right now.")).toBeTruthy();
    expect(within(s).queryByText(/no PR/i)).toBeNull();
  });

  it("shows why the status can't be read, and tries again on request", async () => {
    let fail = true;
    open(() => configured(), {
      [`GET ${STATE_PATH}`]: () =>
        fail ? failure(500, "INTERNAL", "Something broke on the home machine.") : json(configured()),
    });
    const user = userEvent.setup();
    expect((await screen.findByText(/Can't check the Claude cloud handoff/)).textContent).toMatch(
      /Something broke on the home machine\./,
    );
    expect(screen.queryByRole("button", { name: "Hand off to Claude (cloud)" })).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await handOff()).toBeTruthy();
  });
});

describe("polling", () => {
  const pr = (state: "OPEN" | "CLOSED" | "MERGED") => ({
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    title: "t",
    branch: "claude/x",
    state,
    draft: false,
  });
  it("polls only a live session with no merged or closed PR", () => {
    expect(polls(null)).toBe(false);
    expect(polls(handoff())).toBe(true);
    expect(polls(handoff({ status: "UNKNOWN" }))).toBe(true);
    expect(polls(handoff({ pullRequest: pr("OPEN") }))).toBe(true);
    expect(polls(handoff({ pullRequest: pr("MERGED") }))).toBe(false);
    expect(polls(handoff({ pullRequest: pr("CLOSED") }))).toBe(false);
    expect(polls(handoff({ status: "FAILED" }))).toBe(false);
  });
});
