import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type AgentSummary,
  type DeepDiveDetail,
  type DeepDiveReport,
  type Finding,
  type Opportunity,
  type ResearchRun,
  type Watchlist,
} from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  renderApp,
  runner,
  type Call,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

// The Research drawer's Deep dives tab (P1 wave 5). The deep-dive API is stubbed at fetch level, as in every web test.

const NOW = new Date().toISOString();
const DIVE = "44444444-4444-4444-8444-444444444444";
const OPP = "45454545-4545-4545-8545-454545454545";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const F1 = "cccccccc-cccc-4ccc-8ccc-000000000001";
const QUESTION = "Why do shoppers abandon carts at the shipping step?";

const researcher: AgentSummary = {
  agent: "AI_RESEARCHER",
  label: "AI researcher",
  description: "Searches the web and your watchlists.",
  effective: {
    agent: "AI_RESEARCHER",
    versionId: null,
    level: "DEFAULT",
    version: 0,
    settings: {
      engine: "MESSAGES_API",
      autonomy: "ACT_WITH_APPROVAL",
      tools: ["research.search", "research.run", "research.deep_dive", "github.issues.create"],
      maxCostUsdPerTask: 2,
      maxTurns: 30,
      responseDetail: "STANDARD",
    },
    ceilingApplied: [],
  },
  record: { stepsSucceeded: 0, stepsFailed: 0, lastActiveAt: null },
};

const report = (): DeepDiveReport => ({
  summary: "Surprise shipping costs drive most abandonment [0]; one blog says otherwise [1].",
  claims: [
    {
      id: 0,
      text: "Unexpected shipping costs are the top reason carts are abandoned.",
      basis: "OBSERVED",
      label: "PRIMARY",
      evidence: [
        {
          url: "https://research.example/carts",
          publisher: "research.example",
          tier: "PRIMARY",
          quote: "extra costs like shipping were the top reason for abandonment",
          verified: true,
          snapshotId: "46464646-4646-4646-8646-464646464646",
        },
      ],
    },
    {
      id: 1,
      text: "Abandonment is mostly caused by slow pages.",
      basis: "INFERRED",
      label: "UNVERIFIED",
      evidence: [
        {
          url: "https://blog.example/speed",
          publisher: "blog.example",
          tier: "COMMUNITY",
          quote: "speed is the only thing that matters for checkout",
          verified: false,
          snapshotId: null,
        },
      ],
    },
  ],
  contradictions: [{ claimIds: [0, 1], note: "The blog blames speed, the study blames cost." }],
  openQuestions: ["Does free-shipping threshold placement change this?"],
  confidence: "MEDIUM",
  opportunity: {
    kind: "OPPORTUNITY",
    title: "Show shipping costs on the product page",
    problem: "Shoppers meet shipping costs only at checkout.",
    targetUsers: "Small shops",
    impactEstimate: "fewer abandoned carts",
    confidence: "MEDIUM",
    claimIds: [0],
    validationSteps: [],
  },
});

const dive = (over: Partial<DeepDiveDetail> = {}): DeepDiveDetail => ({
  id: DIVE,
  projectId: PROJECT_ID,
  question: QUESTION,
  depth: "STANDARD",
  findingIds: [],
  status: "RUNNING",
  stoppedBy: null,
  limits: { maxCostUsd: 2, maxTurns: 30, maxSearches: 10, maxFetches: 16 },
  usage: { costUsd: 0.12, turns: 2, searches: 1, fetches: 0 },
  model: "claude-test-model",
  profileVersionId: null,
  report: null,
  opportunityId: null,
  error: null,
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: null,
  steps: [
    {
      index: 0,
      kind: "SEARCH",
      detail: "cart abandonment shipping costs",
      outcome: "OK",
      note: "8 results",
      at: NOW,
    },
  ],
  ...over,
});

const opportunity = (): Opportunity => ({
  id: OPP,
  projectId: PROJECT_ID,
  deepDiveId: DIVE,
  kind: "OPPORTUNITY",
  title: "Show shipping costs on the product page",
  problem: "Shoppers meet shipping costs only at checkout.",
  targetUsers: "Small shops",
  impactEstimate: "fewer abandoned carts",
  confidence: "MEDIUM",
  evidence: [report().claims[0]!],
  validationSteps: [],
  agents: ["AI_RESEARCHER", "PRODUCT"],
  status: "OPEN",
  issue: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const watchlist: Watchlist = {
  id: W1,
  projectId: PROJECT_ID,
  name: "Checkout",
  keywords: ["cart"],
  sources: [{ kind: "FEED", url: "https://news.example/feed.xml", tier: "SECONDARY" }],
  weights: { credibility: 25, relevance: 25, novelty: 20, impact: 15, opportunity: 15 },
  schedule: { localTime: "08:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], paused: false },
  nextRunAt: null,
  lastRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const run: ResearchRun = {
  id: R1,
  watchlistId: W1,
  trigger: "MANUAL",
  windowDate: null,
  status: "COMPLETED",
  startedAt: NOW,
  finishedAt: NOW,
  newFindings: 1,
  error: null,
  skippedSources: [],
};
const finding: Finding = {
  id: F1,
  projectId: PROJECT_ID,
  watchlistId: W1,
  title: "Shipping costs top abandonment survey",
  excerpt: "",
  canonicalUrl: "https://news.example/survey",
  label: "PRIMARY",
  score: 70,
  scoreBreakdown: { credibility: 1, relevance: 1, novelty: 1, impact: 0.5, opportunity: 0.5 },
  sources: [
    {
      url: "https://news.example/survey",
      publisher: "news.example",
      tier: "PRIMARY",
      title: "Shipping costs top abandonment survey",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ],
  publishedAt: NOW,
  firstSeenAt: NOW,
  firstRunId: R1,
  readAt: null,
};

let dives: DeepDiveDetail[];

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json({ configured: false }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/agents": () => json({ items: [researcher] }),
    "GET /v1/research/watchlists": () => json({ items: [watchlist] }),
    "GET /v1/research/runs": () => json({ items: [run] }),
    [`GET /v1/research/runs/${R1}`]: () => json({ run, findings: [finding] }),
    "GET /v1/research/findings": () => json({ items: [finding], nextCursor: null }),
    "GET /v1/research/search-provider": () => json({ configured: true, provider: "brave" }),
    // A list item is a DeepDive: the client's schema drops the detail's steps.
    "GET /v1/research/deep-dives": () => json({ items: dives, nextCursor: null }),
    [`GET /v1/research/deep-dives/${DIVE}`]: () => json(dives[0]),
    "GET /v1/research/opportunities": () => json({ items: [opportunity()] }),
    ...extra,
  });
}

beforeEach(() => {
  dives = [];
});

const drawer = () => screen.findByRole("dialog");
const IN_DRAWER = `${IN_PROJECT}&drawer=research`;
async function divesTab() {
  const d = await drawer();
  await userEvent.setup().click(within(d).getByRole("tab", { name: "Deep dives" }));
  return d;
}
const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/v1/research/deep-dives");

describe("Research drawer tabs", () => {
  it("Findings · Deep dives · Sources work from the keyboard (arrows, Home, End) and keep one tab stop", async () => {
    board();
    renderApp(IN_DRAWER);
    const d = await drawer();
    const tabs = within(d).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Findings", "Deep dives", "Sources"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    const user = userEvent.setup();
    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(d).getByRole("tab", { name: "Deep dives", selected: true })).toBe(document.activeElement);
    expect(within(d).getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[1]!.id);
    expect(await within(d).findByRole("form", { name: "Start a deep dive" })).toBeTruthy();
    await user.keyboard("{End}");
    expect(within(d).getByRole("tab", { name: "Sources", selected: true })).toBeTruthy();
    expect(within(d).getByRole("region", { name: "Sources" })).toBeTruthy();
    await user.keyboard("{Home}");
    expect(within(d).getByRole("tab", { name: "Findings", selected: true })).toBeTruthy();
  });
});

describe("start a deep dive", () => {
  it("prefills the researcher's cap, explains each depth and validates before sending", async () => {
    const calls = board();
    renderApp(IN_DRAWER);
    const d = await divesTab();
    const form = within(d).getByRole("form", { name: "Start a deep dive" });
    const cap = within(form).getByLabelText("Cost cap (USD)") as HTMLInputElement;
    await waitFor(() => expect(cap.value).toBe("2"));
    expect(form.textContent).toContain("The AI researcher's profile caps a task at $2 and 30 model turns");
    expect(within(form).getByLabelText("Quick: up to 4 web searches and 8 page reads")).toBeTruthy();
    expect(within(form).getByLabelText("Thorough: up to 20 web searches and 30 page reads")).toBeTruthy();
    expect((within(form).getByLabelText(/^Standard/) as HTMLInputElement).checked).toBe(true);

    const user = userEvent.setup();
    await user.type(within(form).getByLabelText("Question"), "carts?");
    await user.click(within(form).getByRole("button", { name: "Start deep dive" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Ask a question of at least 10 characters (up to 2000).",
    );
    await user.type(within(form).getByLabelText("Question"), " Why are they abandoned?");
    await user.clear(cap);
    await user.type(cap, "60");
    await user.click(within(form).getByRole("button", { name: "Start deep dive" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The cost cap must be more than $0 and at most $50.",
    );
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends one Idempotency-Key per request, reuses it on a retry, then shows the new dive live", async () => {
    let fail = true;
    const calls = board({
      "POST /v1/research/deep-dives": (c) => {
        if (fail) throw new TypeError("Failed to fetch");
        dives = [
          dive({ status: "QUEUED", depth: "THOROUGH", startedAt: null, steps: [], ...(c.body as object) }),
        ];
        return json(dives[0], 202);
      },
    });
    renderApp(IN_DRAWER);
    const d = await divesTab();
    const form = within(d).getByRole("form", { name: "Start a deep dive" });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText("Question"), QUESTION);
    await user.click(within(form).getByLabelText(/^Thorough/));
    const cap = within(form).getByLabelText("Cost cap (USD)");
    await waitFor(() => expect((cap as HTMLInputElement).value).toBe("2"));
    await user.clear(cap);
    await user.type(cap, "1.5");
    await user.click(within(form).getByRole("button", { name: "Start deep dive" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/Can't reach the NEXUS API/);
    fail = false;
    await user.click(within(form).getByRole("button", { name: "Start deep dive" }));

    const list = await within(d).findByRole("list", { name: "Deep dives" });
    expect(list.textContent).toContain(QUESTION);
    expect(within(list).getByText("Queued")).toBeTruthy();
    const sent = posts(calls);
    expect(sent.map((c) => c.body)).toEqual(
      Array(2).fill({
        projectId: PROJECT_ID,
        question: QUESTION,
        depth: "THOROUGH",
        findingIds: [],
        maxCostUsd: 1.5,
      }),
    );
    const keys = sent.map((c) => c.headers.get(IDEMPOTENCY_HEADER));
    expect(IdempotencyKey.safeParse(keys[0]).success).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect((within(form).getByLabelText("Question") as HTMLTextAreaElement).value).toBe("");
  });

  it("Investigate selected findings seeds the dive with them", async () => {
    const calls = board({
      "POST /v1/research/deep-dives": () => {
        dives = [dive({ findingIds: [F1] })];
        return json(dives[0], 202);
      },
    });
    renderApp(IN_DRAWER);
    const d = await drawer();
    const user = userEvent.setup();
    const brief = await within(d).findByRole("list", { name: "Brief findings" });
    await user.click(
      within(brief).getByRole("checkbox", {
        name: "Investigate in a deep dive: Shipping costs top abandonment survey",
      }),
    );
    expect(within(d).getByText("1 finding selected for a deep dive")).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Investigate selected findings" }));
    expect(within(d).getByRole("tab", { name: "Deep dives · 1", selected: true })).toBeTruthy();
    const form = within(d).getByRole("form", { name: "Start a deep dive" });
    const seeded = within(form).getByRole("list", { name: "Selected findings" });
    expect(seeded.textContent).toContain("Shipping costs top abandonment survey");
    await user.type(within(form).getByLabelText("Question"), QUESTION);
    await waitFor(() =>
      expect((within(form).getByLabelText("Cost cap (USD)") as HTMLInputElement).value).toBe("2"),
    );
    await user.click(within(form).getByRole("button", { name: "Start deep dive" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.body).toMatchObject({ findingIds: [F1], maxCostUsd: 2 });
  });

  it("says when web search isn't set up, with the runbook path", async () => {
    board({
      "GET /v1/research/search-provider": () =>
        json({
          configured: false,
          reason: "NEXUS has no web search key yet.",
          runbook: "docs/runbooks/web-search.md",
        }),
    });
    renderApp(IN_DRAWER);
    const d = await divesTab();
    const banner = await within(d).findByText("Web search isn't set up");
    expect(banner.parentElement!.textContent).toMatch(
      /NEXUS has no web search key yet\. Until it is, a deep dive can only read the findings you select\. Set it up on the home machine: docs\/runbooks\/web-search\.md\./,
    );
  });
});

describe("deep dive list and report", () => {
  it("is live while running (2 s refetch) and then shows the report with both evidence states", async () => {
    dives = [dive()];
    let reads = 0;
    board({
      [`GET /v1/research/deep-dives/${DIVE}`]: () => {
        if (++reads >= 2)
          dives = [
            dive({
              status: "COMPLETED",
              finishedAt: NOW,
              report: report(),
              opportunityId: OPP,
              usage: { costUsd: 0.84, turns: 9, searches: 3, fetches: 4 },
              steps: [
                ...dive().steps,
                {
                  index: 1,
                  kind: "FETCH",
                  detail: "https://research.example/carts",
                  outcome: "OK",
                  note: null,
                  at: NOW,
                },
                {
                  index: 2,
                  kind: "FETCH",
                  detail: "https://169.254.169.254/latest",
                  outcome: "BLOCKED",
                  note: "private address, not fetched",
                  at: NOW,
                },
              ],
            }),
          ];
        return json(dives[0]);
      },
    });
    const { router } = renderApp(`${IN_PROJECT}&drawer=research:${DIVE}`);
    const d = await drawer();
    expect(within(d).getByRole("tab", { name: "Deep dives", selected: true })).toBeTruthy();
    expect(await within(d).findByText(/Researching\. The report appears here/)).toBeTruthy();
    expect(within(d).getByRole("list", { name: "Step log" }).textContent).toContain(
      "cart abandonment shipping costs",
    );

    const r = await within(d).findByRole("region", { name: "Report" }, { timeout: 5000 });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(within(d).getAllByText("Completed").length).toBeGreaterThan(0);
    expect(
      within(r).getByText("AI inference: unverified · medium confidence · claude-test-model"),
    ).toBeTruthy();
    expect(r.textContent).toContain("Surprise shipping costs drive most abandonment [0]");
    const claims = within(r).getByRole("list", { name: "Claims" });
    const [first, second] = Array.from(claims.children) as HTMLElement[];
    expect(first!.textContent).toMatch(/\[0\]Primary sourcestated by its sources/);
    expect(within(first!).getByText("✓ found on page")).toBeTruthy();
    expect(
      within(first!)
        .getByRole("link", { name: /research\.example/ })
        .getAttribute("href"),
    ).toBe("https://research.example/carts");
    expect(second!.textContent).toMatch(/\[1\]UnverifiedAI inference: the researcher's reasoning/);
    expect(within(second!).getByText("not found on page")).toBeTruthy();
    expect(within(r).getByRole("list", { name: "Contradictions" }).textContent).toBe(
      "Claims [0], [1] disagree: The blog blames speed, the study blames cost.",
    );
    expect(within(r).getByRole("list", { name: "Open questions" }).textContent).toContain(
      "free-shipping threshold",
    );

    // The step log links only pages NEXUS read; a blocked URL stays text.
    const log = within(d).getByRole("list", { name: "Step log" });
    expect(
      within(log)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["https://research.example/carts"]);
    expect(log.textContent).toContain("blocked · https://169.254.169.254/latest");

    const navigate = vi.spyOn(router, "navigate");
    const user = userEvent.setup();
    await user.click(
      await within(r).findByRole("button", {
        name: "Opportunity noticed → Show shipping costs on the product page",
      }),
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ drawer: `opp:${OPP}` }) }),
    );
  });

  it("Cancel stops a running dive through the API and shows its own outcome", async () => {
    dives = [dive()];
    const calls = board({
      [`POST /v1/research/deep-dives/${DIVE}/cancel`]: () => {
        dives = [dive({ status: "CANCELLED", finishedAt: NOW, error: "Cancelled by the owner" })];
        return json(dives[0]);
      },
    });
    renderApp(`${IN_PROJECT}&drawer=research:${DIVE}`);
    const d = await drawer();
    const user = userEvent.setup();
    await user.click(await within(d).findByRole("button", { name: "Cancel deep dive" }));
    expect(await within(d).findByText("Cancelled by the owner")).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Cancel deep dive" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `/v1/research/deep-dives/${DIVE}/cancel`,
    ]);
  });

  it("All is read-only: every project's dives, no start form and no Cancel", async () => {
    dives = [dive()];
    const calls = board();
    renderApp(`/?drawer=research:${DIVE}`);
    const d = await drawer();
    expect(await within(d).findByText(PICK_PROJECT)).toBeTruthy();
    expect(within(d).queryByRole("form", { name: "Start a deep dive" })).toBeNull();
    const list = await within(d).findByRole("list", { name: "Deep dives" });
    expect(list.textContent).toMatch(/Home · standard/);
    expect(await within(d).findByText(/Researching/)).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Cancel deep dive" })).toBeNull();
    const asked = calls.filter((c) => c.path === "/v1/research/deep-dives");
    expect(asked.every((c) => !c.query.has("projectId"))).toBe(true);
  });

  it("an empty list and a failed load are said honestly", async () => {
    let down = false;
    board({
      "GET /v1/research/deep-dives": () =>
        down
          ? json({ error: { code: "INTERNAL", message: "Service unavailable" }, requestId: "r" }, 503)
          : json({ items: [], nextCursor: null }),
    });
    const { queryClient } = renderApp(IN_DRAWER);
    const d = await divesTab();
    expect(
      await within(d).findByText(/No deep dives yet\. Ask the AI researcher a question above\./),
    ).toBeTruthy();
    down = true;
    queryClient.removeQueries({ queryKey: ["research", "deep-dives"] });
    await userEvent.setup().click(within(d).getByRole("tab", { name: "Findings" }));
    await userEvent.setup().click(within(d).getByRole("tab", { name: "Deep dives" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("Service unavailable");
  });
});
