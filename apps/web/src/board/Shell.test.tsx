import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type Job,
  type MonitoredApp,
  type Runner,
} from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  PROJECT_ID,
  ME,
  apiError,
  job,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  setViewport,
  workspaces,
} from "../test/helpers.tsx";

function board(runners: Runner[], jobs: Job[] = [], extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: runners }),
    "GET /v1/jobs": (c) =>
      json({
        items: jobs.filter((j) => !c.query.get("status") || j.status === c.query.get("status")),
        nextCursor: null,
      }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(job()),
    ...extra,
  });
}

const INC = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";
const failingApp: MonitoredApp = {
  id: "eeeeeeee-eeee-4eee-8eee-000000000001",
  projectId: PROJECT_ID,
  name: "checkout-api",
  environment: "PROD",
  healthUrl: "https://shop.example.com/health",
  repositoryId: null,
  intervalSeconds: 300,
  timeoutMs: 5000,
  failureThreshold: 3,
  disabled: false,
  health: "DOWN",
  consecutiveFailures: 3,
  lastCheckedAt: new Date().toISOString(),
  openIncidentId: INC,
  createdAt: new Date().toISOString(),
};

const areasNav = () => screen.findByRole("navigation", { name: "Areas" });
const runnerDot = (name: string) => screen.findByRole("img", { name });

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
});

describe("shell", () => {
  it("queues the previewed diagnostic with an Idempotency-Key and reuses it on retry", async () => {
    let attempts = 0;
    const calls = board([runner()], [], {
      "POST /v1/jobs": () =>
        ++attempts === 1
          ? apiError(503, "RUNNER_UNAVAILABLE", "Queue is busy, try again.")
          : json({ jobId: JOB_ID, status: "QUEUED", streamUrl: `/v1/jobs/${JOB_ID}/events` }, 202),
    });
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    await runnerDot("Runner test-host: online");

    await user.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "Execute preview" });
    expect(within(preview).getByText("Not required")).toBeTruthy();
    await user.selectOptions(within(preview).getByLabelText("Preset"), "git-version");
    await user.click(within(preview).getByRole("button", { name: "Queue on test-host" }));
    expect((await within(preview).findByRole("alert")).textContent).toBe("Queue is busy, try again.");
    await user.click(within(preview).getByRole("button", { name: "Queue on test-host" }));

    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/jobs");
    expect(posts).toHaveLength(2);
    const key = posts[0]!.headers.get(IDEMPOTENCY_HEADER);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(posts[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    expect(posts[0]!.body).toEqual({
      jobType: "RUNNER_DIAGNOSTIC",
      preset: "git-version",
      projectId: PROJECT_ID,
    });
    // The run drawer opens on the new job.
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("says a job will be held when no runner is online", async () => {
    board([runner({ status: "OFFLINE", name: "home-box" })]);
    const user = userEvent.setup();
    renderApp("/");
    await runnerDot("Runner home-box: offline");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText(/home-box is offline\. The job will be queued and held, not lost/)).toBeTruthy();
  });

  it("shows the offline banner with the real held-job count", async () => {
    const lastSeen = "2026-10-28T09:00:00.000Z";
    const other = "44444444-4444-4444-8444-444444444444";
    const done = "55555555-5555-4555-8555-555555555555";
    board(
      [runner({ status: "OFFLINE", name: "home-box", lastHeartbeatAt: lastSeen })],
      [job(), job({ id: other }), job({ id: done, status: "COMPLETED" })],
    );
    renderApp("/");
    expect(await screen.findByText("home-box is offline. 2 queued jobs are held, not lost.")).toBeTruthy();
  });

  it("shows the offline banner inside an open run drawer", async () => {
    const held = job();
    board([runner({ status: "OFFLINE", name: "home-box" })], [held], {
      [`GET /v1/jobs/${JOB_ID}`]: () => json(held),
    });
    renderApp(`/?drawer=run:${JOB_ID}`);
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByText("home-box is offline. 1 queued job is held, not lost."),
    ).toBeTruthy();
    expect(screen.getAllByText(/home-box is offline\./)).toHaveLength(1);
  });

  it("has no offline banner while a runner is online", async () => {
    board([runner()]);
    renderApp("/");
    await runnerDot("Runner test-host: online");
    expect(screen.queryByText(/is offline/)).toBeNull();
  });

  it("Plan in the All view asks for a project and sends nothing (Plan is covered in plans.test.tsx)", async () => {
    const calls = board([runner()]);
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Plan", pressed: false }));
    await user.type(screen.getByRole("textbox", { name: "Command" }), "check the runner{Enter}");
    const panel = await screen.findByRole("region", { name: "Plan" });
    expect(within(panel).getByRole("status").textContent).toMatch(/^Pick a project first/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("pairs a runner from the Systems page when none is paired", async () => {
    board([], [], {
      "POST /v1/runners/pair": () => json({ code: "ABC123", expiresAt: "2026-10-28T10:10:00.000Z" }),
    });
    const user = userEvent.setup();
    renderApp("/?area=systems");
    await user.click(await screen.findByRole("button", { name: "Pair a runner" }));
    expect(await screen.findByText("node apps/runner/src/main.ts pair --code ABC123")).toBeTruthy();
  });

  it("slides a drawer in, keeps focus inside it and closes it on Esc after the exit animation", async () => {
    board([runner()], [], { "GET /v1/approvals": () => json({ items: [] }) });
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const inbox = await screen.findByRole("button", { name: /^Inbox/ });
    await user.click(inbox);

    const drawer = await screen.findByRole("dialog", { name: "What needs you" });
    expect(drawer.style.transform).toMatch(/translateX/);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    for (const shift of [true, true, false, false, false]) {
      await user.tab({ shift });
      expect(drawer.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");
    // The URL (and the drawer) clear only once the exit animation has played.
    expect(router.state.location.search).toEqual({ drawer: "inbox" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({});
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.activeElement).toBe(inbox);
  });
});

describe("sidebar", () => {
  it("lists the areas with their live status in words; an open incident is said, not only coloured", async () => {
    board([runner()], [job({ status: "RUNNING" })], {
      "GET /v1/monitoring/apps": () => json({ items: [failingApp] }),
    });
    renderApp(IN_PROJECT);
    const areas = await areasNav();
    const link = (name: string) => within(areas).getByRole("link", { name: new RegExp(`^${name}`) });
    const labels = within(areas)
      .getAllByRole("link")
      .map((l) => l.firstElementChild?.firstElementChild?.textContent);
    expect(labels).toEqual(["Today", "Code", "Systems", "Business", "Research", "Agents", "Plans"]);
    await waitFor(() => expect(link("Code").textContent).toBe("Code1 running"));
    await waitFor(() => expect(link("Systems").textContent).toBe("Systems1 open incident"));
    expect(link("Today").getAttribute("aria-current")).toBe("page");
    expect(link("Code").getAttribute("aria-current")).toBeNull();
    // Knowledge and Phone were placeholders of the old board; the emergency stop is always in reach.
    expect(screen.queryByRole("button", { name: "Knowledge" })).toBeNull();
    expect(screen.getByRole("button", { name: "STOP ALL" })).toBeTruthy();
  });

  it("an area opens as the page in the middle, in the URL, and keeps it while drawers and scope change", async () => {
    board([runner()]);
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    const areas = await areasNav();
    expect(await screen.findByRole("main", { name: "Today" })).toBeTruthy();

    await user.click(within(areas).getByRole("link", { name: /^Systems/ }));
    const main = await screen.findByRole("main", { name: "Systems" });
    expect(within(main).getByRole("heading", { level: 2, name: "Systems" })).toBeTruthy();
    expect(await within(main).findByText("Home host · ONLINE")).toBeTruthy();
    expect(router.state.location.search).toEqual({ ws: "dev", project: PROJECT_ID, area: "systems" });
    expect(
      within(areas)
        .getByRole("link", { name: /^Systems/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(areas)
        .getByRole("link", { name: /^Today/ })
        .getAttribute("aria-current"),
    ).toBeNull();

    // A drawer opens over the page and closes back to it.
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(router.state.location.search).toMatchObject({ area: "systems", drawer: "settings" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({ ws: "dev", project: PROJECT_ID, area: "systems" });

    // Switching scope keeps the page.
    const scope = screen.getByRole("navigation", { name: "Scope" });
    await user.click(within(scope).getByRole("button", { name: /Switch project/ }));
    await user.click(within(scope).getByRole("button", { name: /Decoy/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ area: "systems" }));
    expect(screen.getByRole("main", { name: "Systems" })).toBeTruthy();
  });

  it("waits for the workspaces before showing a scope or areas, then opens straight on Dev's only project", async () => {
    let answer: (r: Response) => void = () => undefined;
    board([runner()], [], {
      "GET /v1/workspaces": () => new Promise<Response>((resolve) => (answer = resolve)),
      "GET /v1/agents": () => json({ items: [] }),
    });
    const { router } = renderApp("/");
    expect(await screen.findByText("Loading workspaces…")).toBeTruthy();
    expect(screen.getByText("Loading areas…")).toBeTruthy();
    // Nothing of a scope that may not exist: no aggregate, no Business area, no "pick a project".
    expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull();
    expect(screen.queryByText(/All workspaces|cross-project/)).toBeNull();
    expect(screen.queryByText("pick a project")).toBeNull();
    expect(screen.queryByText(/all installed/)).toBeNull();
    expect(screen.getByRole("main", { name: "Today" })).toBeTruthy();

    answer(json(workspaces([project()], [], false)));
    const scope = await screen.findByRole("navigation", { name: "Scope" });
    // The first scope shown is already the project, not "Dev · all repos · read-only" a moment before it.
    expect(within(scope).getByRole("button", { name: "Project: Home. Switch project" })).toBeTruthy();
    expect(scope.textContent).not.toMatch(/read-only/);
    const areas = await areasNav();
    expect(within(areas).queryByRole("link", { name: /^Business/ })).toBeNull();
    await waitFor(() => expect(router.state.location.search).toEqual({ project: PROJECT_ID }));
  });

  it("an area in the URL waits for the workspaces instead of flashing a page that may be hidden", async () => {
    let answer: (r: Response) => void = () => undefined;
    board([runner()], [], {
      "GET /v1/workspaces": () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    renderApp("/?area=business");
    const main = await screen.findByRole("main", { name: "Loading" });
    expect(within(main).getByRole("status").textContent).toBe("Loading…");
    answer(json(workspaces([project()], [], false)));
    expect(await screen.findByRole("main", { name: "Today" })).toBeTruthy();
  });

  it("an old board bookmark lands on Today with its drawer and without view", async () => {
    board([runner()], [], { "GET /v1/jobs": () => json({ items: [], nextCursor: null }) });
    const { router } = renderApp("/?view=board&drawer=jobs");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(router.state.location.search).toEqual({ drawer: "jobs" });
    expect(screen.getByRole("main", { name: "Today", hidden: true })).toBeTruthy();
  });
});

describe("phone", () => {
  it("has the bottom navigation instead of the sidebar, Stop in the header, and the areas under Workspaces", async () => {
    setViewport(390);
    board([runner()]);
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    const nav = await screen.findByRole("navigation", { name: "Phone" });
    expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull();
    expect([...nav.querySelectorAll("a, button")].map((el) => el.textContent)).toEqual([
      "Home",
      "Inbox",
      "Talk",
      "Workspaces",
      "Settings",
    ]);
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "STOP ALL" })).toBeTruthy();

    await user.click(within(nav).getByRole("link", { name: "Workspaces" }));
    const main = await screen.findByRole("main", { name: "Workspaces" });
    expect(within(main).getByRole("navigation", { name: "Scope" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Workspaces" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
    // Each area with its status line, in words.
    const list = within(main).getByRole("navigation", { name: "Areas" });
    await waitFor(() =>
      expect(within(list).getByRole("link", { name: /^Systems/ }).textContent).toBe(
        "Systems1 runner · 1 online",
      ),
    );
    await user.click(
      within(within(main).getByRole("navigation", { name: "Areas" })).getByRole("link", { name: /^Code/ }),
    );
    expect(await screen.findByRole("main", { name: "Code" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ area: "code" });
    expect(within(nav).getByRole("link", { name: "Workspaces" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("phone command bar", () => {
  it("has the command field with its mode as one select and the action as a named button", async () => {
    setViewport(320);
    board([runner()]);
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    const header = await screen.findByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "nexus" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "STOP ALL" })).toBeTruthy();
    const command = within(header).getByRole("textbox", { name: "Command" });
    const mode = within(header).getByRole("combobox", { name: "Command mode" });
    expect((mode as HTMLSelectElement).value).toBe("Execute");
    expect(within(header).getByRole("button", { name: "Preview" })).toBeTruthy();

    // The select and the segmented control are one mode: a narrow bar shows the select, a wide one the buttons.
    await user.selectOptions(mode, "Plan");
    expect(within(header).getByRole("button", { name: "Plan", pressed: true })).toBeTruthy();
    // ...and the action button now says Plan too.
    expect(within(header).getAllByRole("button", { name: "Plan" })).toHaveLength(2);
    await user.type(command, "tidy the backlog");
    expect((command as HTMLInputElement).value).toBe("tidy the backlog");
    await user.click(within(header).getByRole("button", { name: "Ask", pressed: false }));
    expect((mode as HTMLSelectElement).value).toBe("Ask");
  });
});

describe("Cofounder panel dock", () => {
  it("one toggle names what it hides, says whether it is expanded, controls the panel and keeps focus", async () => {
    setViewport(1280);
    board([runner()]);
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    await screen.findByRole("complementary", { name: "Cofounder" });
    const toggle = screen.getByRole("button", { name: "Hide cofounder panel" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel?.contains(screen.getByRole("complementary", { name: "Cofounder" }))).toBe(true);

    await user.click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show cofounder panel");
    expect(panel?.hidden).toBe(true);

    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("complementary", { name: "Cofounder" })).toBeTruthy();
  });

  it("is docked on a wide screen; hiding it is remembered on this device", async () => {
    setViewport(1440);
    board([runner()]);
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    expect(await screen.findByRole("complementary", { name: "Cofounder" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Hide cofounder panel" }));
    expect(screen.queryByRole("complementary", { name: "Cofounder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show cofounder panel" }).getAttribute("aria-expanded")).toBe(
      "false",
    );

    cleanup();
    renderApp(IN_PROJECT);
    expect(await screen.findByRole("button", { name: "Show cofounder panel" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Cofounder" })).toBeNull();
  });

  it("still docks and toggles when the browser blocks storage", async () => {
    setViewport(1440);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    board([runner()]);
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    expect(await screen.findByRole("complementary", { name: "Cofounder" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Hide cofounder panel" }));
    expect(screen.getByRole("button", { name: "Show cofounder panel" })).toBeTruthy();
  });

  it("isn't docked below the wide breakpoint: Talk opens the drawer", async () => {
    setViewport(1100);
    board([runner()]);
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    await areasNav();
    expect(screen.queryByRole("complementary", { name: "Cofounder" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Talk" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: "talk" }));
  });
});
