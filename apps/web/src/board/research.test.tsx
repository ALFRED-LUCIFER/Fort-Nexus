import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type Finding,
  type ResearchBrief,
  type ResearchRun,
  type Watchlist,
} from "@nexus/contracts";
import { keys } from "../lib/api.ts";
import {
  BIZ_PROJECT_ID,
  IN_PROJECT,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  WORKSPACES,
  apiError,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
  type Call,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const NOW = new Date().toISOString();
const SOON = new Date(Date.now() + 3 * 3600_000).toISOString();
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const watchlist = (over: Partial<Watchlist> = {}): Watchlist => ({
  id: W1,
  projectId: PROJECT_ID,
  name: "AI SDKs",
  keywords: ["sdk"],
  sources: [
    { kind: "FEED", url: "https://news.example/feed.xml", tier: "SECONDARY" },
    { kind: "GITHUB_RELEASES", repo: "acme/sdk", tier: "PRIMARY" },
  ],
  weights: { credibility: 25, relevance: 25, novelty: 20, impact: 15, opportunity: 15 },
  schedule: { localTime: "08:00", timezone: "Asia/Dubai", days: [0, 1, 2, 3, 4, 5, 6], paused: false },
  nextRunAt: SOON,
  lastRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

let n = 0;
const finding = (over: Partial<Finding> = {}): Finding => {
  const id = `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, "0")}`;
  return {
    id,
    projectId: PROJECT_ID,
    watchlistId: W1,
    title: "Acme SDK 2.0 released",
    excerpt: "Streaming support lands.",
    canonicalUrl: "https://acme.dev/blog/sdk-2",
    label: "PRIMARY",
    score: 80,
    scoreBreakdown: { credibility: 1, relevance: 1, novelty: 1, impact: 0.5, opportunity: 0 },
    sources: [
      {
        url: "https://acme.dev/blog/sdk-2",
        publisher: "acme.dev",
        tier: "PRIMARY",
        title: "Acme SDK 2.0 released",
        publishedAt: NOW,
        fetchedAt: NOW,
      },
    ],
    publishedAt: NOW,
    firstSeenAt: NOW,
    firstRunId: R1,
    readAt: null,
    ...over,
  };
};

const claim = () =>
  finding({
    title: "AI agent market will reach $1T by 2027",
    label: "UNVERIFIED",
    score: 40,
    sources: [
      {
        url: "https://blog.example/market",
        publisher: "blog.example",
        tier: "SECONDARY",
        title: "AI agent market will reach $1T by 2027",
        publishedAt: null,
        fetchedAt: NOW,
      },
    ],
  });

const run = (over: Partial<ResearchRun> = {}): ResearchRun => ({
  id: R1,
  watchlistId: W1,
  trigger: "MANUAL",
  windowDate: null,
  status: "PARTIAL",
  startedAt: NOW,
  finishedAt: NOW,
  newFindings: 2,
  error: null,
  skippedSources: [
    {
      source: "https://blocked.example/feed.xml",
      reason: "ROBOTS_DISALLOWED",
      detail: "robots.txt on blocked.example disallows /feed.xml",
    },
    {
      source: "https://private.example/feed.xml",
      reason: "AUTH_REQUIRED",
      detail: "HTTP 401: the source requires access NEXUS doesn't have",
    },
  ],
  ...over,
});

let lists: Watchlist[];
let runs: ResearchRun[];
let brief: ResearchBrief;
let findings: Finding[];

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json({ configured: false }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/research/watchlists": () => json({ items: lists }),
    "GET /v1/research/runs": () => json({ items: runs }),
    [`GET /v1/research/runs/${R1}`]: () => json(brief),
    "GET /v1/research/findings": () => json({ items: findings, nextCursor: null }),
    ...extra,
  });
}

beforeEach(() => {
  lists = [watchlist()];
  runs = [run()];
  findings = [finding(), claim()];
  brief = { run: run(), findings };
});

const drawer = () => screen.findByRole("dialog");
/** The research drawer in the Dev project "home", where watchlists can be created and run. */
const IN_DRAWER = `${IN_PROJECT}&drawer=research`;
const why = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;

describe("Research zone", () => {
  it("invites the owner to create a watchlist when there is none", async () => {
    lists = [];
    board();
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const zone = await screen.findByRole("region", { name: "Research" });
    expect(await within(zone).findByText("no watchlists")).toBeTruthy();
    await user.click(await within(zone).findByRole("button", { name: "Create a watchlist" }));
    expect(router.state.location.search).toMatchObject({ drawer: "research" });
    expect(within(await drawer()).getByRole("heading", { name: "Research" })).toBeTruthy();
  });

  it("shows top findings with label chips and the next brief; unverified ones as claims", async () => {
    board();
    renderApp("/");
    const zone = await screen.findByRole("region", { name: "Research" });
    expect(await within(zone).findByText(/1 watchlist · next brief/)).toBeTruthy();
    const cards = await within(zone).findAllByRole("button", { name: /score/ });
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringMatching(/^Primary sourceAcme SDK 2\.0 released1 source · score 80/),
      expect.stringMatching(
        /^Unverified claimblog\.example claims: “AI agent market will reach \$1T by 2027”/,
      ),
    ]);
  });

  it("the Brief button opens the research drawer", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Brief" }));
    expect(router.state.location.search).toMatchObject({ drawer: "research" });
  });
});

describe("research drawer", () => {
  it("lists watchlists with schedule, next run and sources", async () => {
    board();
    renderApp("/?drawer=research");
    const list = await within(await drawer()).findByRole("list", { name: "Watchlists" });
    expect(list.textContent).toMatch(/next brief in \d+h · 08:00 Asia\/Dubai · daily · last run never/);
    expect(list.textContent).toMatch(/2 sources: news\.example, acme\/sdk · keywords: sdk/);
  });

  it("RES-G03/G04: the latest brief shows unverified findings as claims and every skipped source with its reason", async () => {
    board();
    renderApp("/?drawer=research");
    const d = await drawer();
    const items = within(await within(d).findByRole("list", { name: "Brief findings" })).getAllByRole(
      "listitem",
      { name: "" },
    );
    const text = items.map((i) => i.textContent ?? "").join("\n");
    expect(text).toContain("blog.example claims: “AI agent market will reach $1T by 2027”");
    expect(text).toContain("Unverified claim");
    expect(within(d).getByText(/Run on demand · Completed, some sources skipped/)).toBeTruthy();

    const skipped = within(d).getByRole("list", { name: "Skipped sources" });
    expect(
      within(skipped)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Blocked by robots.txt · https://blocked.example/feed.xmlrobots.txt on blocked.example disallows /feed.xml",
      "Needs sign-in, not attempted · https://private.example/feed.xmlHTTP 401: the source requires access NEXUS doesn't have",
    ]);
    const link = within(d).getAllByRole("link", { name: /acme\.dev/ })[0]!;
    expect(link.getAttribute("href")).toBe("https://acme.dev/blog/sdk-2");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("Run now sends one Idempotency-Key per click and shows the running brief", async () => {
    runs = [];
    const calls = board({
      [`POST /v1/research/watchlists/${W1}/run`]: () => {
        runs = [run({ status: "RUNNING", finishedAt: null, newFindings: 0, skippedSources: [] })];
        brief = { run: runs[0]!, findings: [] };
        return json(runs[0], 202);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    expect(
      await within(d).findByText(/No brief yet\. Run it now, or wait for the scheduled one in/),
    ).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Run now, AI SDKs" }));
    expect(await within(d).findByText(/Reading sources/)).toBeTruthy();
    const post = calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(IdempotencyKey.safeParse(post[0]!.headers.get(IDEMPOTENCY_HEADER)).success).toBe(true);
  });

  it("pauses the schedule and saves weights with PATCH", async () => {
    const patches: Call[] = [];
    board({
      [`PATCH /v1/research/watchlists/${W1}`]: (c) => {
        patches.push(c);
        const body = c.body as Partial<Watchlist>;
        lists = [watchlist({ ...body, nextRunAt: body.schedule?.paused ? null : SOON })];
        return json(lists[0]);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Pause schedule, AI SDKs" }));
    expect(await within(d).findByRole("button", { name: "Resume schedule, AI SDKs" })).toBeTruthy();
    expect(within(d).getByRole("list", { name: "Watchlists" }).textContent).toMatch(/paused · 08:00/);

    await user.click(within(d).getByText("Scoring weights"));
    const novelty = within(d).getByRole("slider", { name: /Novelty/ });
    fireEvent.change(novelty, { target: { value: "30" } }); // user-event has no range-input keyboard support
    await user.click(within(d).getByRole("button", { name: "Save weights" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[0]!.body).toEqual({ schedule: { ...watchlist().schedule, paused: true } });
    expect(patches[1]!.body).toEqual({
      weights: { credibility: 25, relevance: 25, novelty: 30, impact: 15, opportunity: 15 },
    });
  });

  it("creates a watchlist from feeds and GitHub repos", async () => {
    lists = [];
    const calls = board({
      "POST /v1/research/watchlists": (c) => {
        lists = [watchlist({ name: "Agents" })];
        return json({ ...lists[0], ...(c.body as object) }, 201);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "New watchlist" }));
    const form = within(d).getByRole("form", { name: "New watchlist" });
    await user.type(within(form).getByLabelText("Name"), "Agents");
    await user.type(within(form).getByLabelText(/Keywords/), "agents, mcp");
    await user.type(within(form).getByLabelText(/Feeds/), "https://news.example/feed.xml");
    await user.selectOptions(within(form).getByLabelText(/How credible/), "COMMUNITY");
    await user.type(within(form).getByLabelText(/GitHub releases/), "acme/sdk");
    await user.clear(within(form).getByLabelText(/Time zone/));
    await user.type(within(form).getByLabelText(/Time zone/), "Asia/Dubai");
    await user.click(within(form).getByLabelText("Sun"));
    await user.click(within(form).getByRole("button", { name: "Create watchlist" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      projectId: PROJECT_ID,
      name: "Agents",
      keywords: ["agents", "mcp"],
      sources: [
        { kind: "FEED", url: "https://news.example/feed.xml", tier: "COMMUNITY" },
        { kind: "GITHUB_RELEASES", repo: "acme/sdk", tier: "PRIMARY" },
      ],
      weights: { credibility: 25, relevance: 25, novelty: 20, impact: 15, opportunity: 15 },
      schedule: { localTime: "08:00", timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5, 6], paused: false },
    });
    expect(await within(d).findByRole("button", { name: /AI SDKs|Agents/, pressed: true })).toBeTruthy();
  });

  it("explains invalid input before sending anything", async () => {
    lists = [];
    const calls = board();
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "New watchlist" }));
    const form = within(d).getByRole("form", { name: "New watchlist" });
    await user.type(within(form).getByLabelText("Name"), "x");
    await user.click(within(form).getByRole("button", { name: "Create watchlist" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Add at least one feed or GitHub repository.",
    );
    await user.type(within(form).getByLabelText(/Feeds/), "http://insecure.example/feed");
    await user.click(within(form).getByRole("button", { name: "Create watchlist" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/^Sources: /);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("searches with filters and pages with the cursor; marks a finding read", async () => {
    const calls = board({
      "GET /v1/research/findings": (c) =>
        c.query.get("cursor")
          ? json({ items: [finding({ title: "Older finding" })], nextCursor: null })
          : json({ items: findings, nextCursor: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      [`POST /v1/research/findings/${findings[0]!.id}/read`]: () => {
        findings = [{ ...findings[0]!, readAt: NOW }, findings[1]!];
        return json(findings[0]);
      },
    });
    const user = userEvent.setup();
    renderApp("/?drawer=research");
    const d = await drawer();
    const form = await within(d).findByRole("search", { name: "Search findings" });
    await user.type(within(form).getByLabelText("Search text"), "sdk");
    await user.selectOptions(within(form).getByLabelText("Label"), "UNVERIFIED");
    await user.click(within(form).getByLabelText("Unread only"));
    await user.click(within(form).getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/v1/research/findings" && c.query.get("q") === "sdk")).toBe(true),
    );
    const searched = calls.filter((c) => c.path === "/v1/research/findings" && c.query.get("q")).at(-1)!;
    expect(Object.fromEntries(searched.query)).toEqual({
      q: "sdk",
      label: "UNVERIFIED",
      unread: "true",
      limit: "20",
    });

    const results = await within(d).findByRole("list", { name: "Search results" });
    await user.click(within(d).getByRole("button", { name: "Load more" }));
    expect(await within(results).findByText("Older finding")).toBeTruthy();
    expect(calls.at(-1)!.query.get("cursor")).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");

    await user.click(within(results).getAllByRole("button", { name: "Mark read" })[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/read"))).toBe(true),
    );
  });

  it("shows an error when watchlists can't load, and a stale notice when a refresh fails", async () => {
    let down = true;
    board({
      "GET /v1/research/watchlists": () =>
        down ? apiError(503, "INTERNAL", "Service unavailable") : json({ items: lists }),
    });
    const { queryClient } = renderApp("/?drawer=research");
    const d = await drawer();
    expect((await within(d).findByRole("alert")).textContent).toBe("Service unavailable");

    down = false;
    await act(() => queryClient.refetchQueries({ queryKey: keys.watchlists }));
    await within(d).findByRole("list", { name: "Watchlists" });
    down = true;
    await act(() => queryClient.refetchQueries({ queryKey: keys.watchlists }));
    expect(
      await within(d).findByText(/Can't refresh: Service unavailable Showing what NEXUS had at/),
    ).toBeTruthy();
    expect(within(d).getByRole("list", { name: "Watchlists" })).toBeTruthy();
  });
});

describe("research scope", () => {
  const research = (c: Call) => c.path.startsWith("/v1/research/") && c.method === "GET";

  it("All is read-only: create, run, pause and weights are disabled with the reason; each watchlist names its project", async () => {
    const calls = board();
    renderApp("/?drawer=research");
    const d = await drawer();
    const list = await within(d).findByRole("list", { name: "Watchlists" });
    expect(list.textContent).toMatch(/AI SDKsHome · next brief/);
    for (const name of ["New watchlist", "Run now, AI SDKs", "Pause schedule, AI SDKs", "Save weights"]) {
      const btn = within(d).getByRole("button", { name }) as HTMLButtonElement;
      expect(btn.disabled, name).toBe(true);
      expect(why(btn), name).toBe(PICK_PROJECT);
    }
    expect(calls.filter(research).every((c) => !c.query.has("projectId"))).toBe(true);
  });

  it("NFR-CNV-05: lists and search are asked for the current project only; the decoy project shows none of home's", async () => {
    const calls = board({
      "GET /v1/research/watchlists": (c) =>
        json({ items: c.query.get("projectId") === PROJECT_ID ? lists : [] }),
      "GET /v1/research/findings": (c) =>
        json({ items: c.query.get("projectId") === PROJECT_ID ? findings : [], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderApp(`/?ws=dev&project=${OTHER_PROJECT_ID}&drawer=research`);
    const d = await drawer();
    expect(await within(d).findByText(/No watchlists yet/)).toBeTruthy();
    expect(within(d).queryByText("AI SDKs")).toBeNull();
    const asked = calls.filter((c) => c.path === "/v1/research/watchlists");
    expect(asked.map((c) => c.query.get("projectId"))).toEqual(asked.map(() => OTHER_PROJECT_ID));

    await user.click(within(d).getByRole("button", { name: "New watchlist" })); // enabled in a project
    expect(within(d).getByRole("form", { name: "New watchlist" })).toBeTruthy();
  });

  it("a Business project can research: its controls are enabled", async () => {
    board();
    renderApp(`/?ws=business&project=${BIZ_PROJECT_ID}&drawer=research`);
    const run = await within(await drawer()).findByRole("button", { name: "Run now, AI SDKs" });
    expect((run as HTMLButtonElement).disabled).toBe(false);
  });

  it("an archived project keeps its research readable but can't create or run", async () => {
    board({
      "GET /v1/workspaces": () =>
        json(
          workspaces([project({ archivedAt: "2026-10-28T10:00:00.000Z" })], WORKSPACES.items[1]!.projects),
        ),
    });
    renderApp(IN_DRAWER);
    const d = await drawer();
    const run = (await within(d).findByRole("button", { name: "Run now, AI SDKs" })) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(true));
    expect(why(run)).toMatch(/^Home is archived/);
    expect((within(d).getByRole("button", { name: "New watchlist" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(await within(d).findByRole("list", { name: "Brief findings" })).toBeTruthy();
  });
});
