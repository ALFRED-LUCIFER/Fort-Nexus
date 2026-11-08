import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type IssuePreview,
  type Opportunity,
  type Repository,
} from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  PROJECT_ID,
  apiError,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const NOW = new Date().toISOString();
const OPP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DIVE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HASH = "a".repeat(64);

const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: OPP,
  projectId: PROJECT_ID,
  deepDiveId: DIVE,
  kind: "RISK",
  title: "Restore the payment provider timeout",
  problem: "Checkout fails more often since the timeout was lowered.",
  targetUsers: "Buyers paying with 3DS cards",
  impactEstimate: "fewer failed payments",
  confidence: "MEDIUM",
  evidence: [
    {
      id: 0,
      text: "Failures doubled after the release.",
      basis: "OBSERVED",
      label: "CORROBORATED",
      evidence: [
        {
          url: "https://acme.dev/post",
          publisher: "acme.dev",
          tier: "PRIMARY",
          quote: "Checkout failures doubled after the release.",
          verified: true,
          snapshotId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        },
        {
          url: "https://rumour.example/x",
          publisher: "rumour.example",
          tier: "COMMUNITY",
          quote: "Everyone is leaving.",
          verified: false,
          snapshotId: null,
        },
      ],
    },
    { id: 1, text: "The fix is reversible.", basis: "INFERRED", label: "CONTESTED", evidence: [] },
  ],
  validationSteps: ["Compare failure rates before and after the release."],
  agents: ["AI_RESEARCHER", "DEVOPS"],
  status: "OPEN",
  issue: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const repo: Repository = {
  id: "101",
  fullName: "acme/web",
  owner: "acme",
  name: "web",
  private: true,
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/web",
  pushedAt: null,
  updatedAt: null,
  installationId: 1,
};

const preview: IssuePreview = {
  opportunityId: OPP,
  repositoryId: "101",
  repositoryFullName: "acme/web",
  title: "Restore the payment provider timeout",
  body: "## Problem\n\nCheckout fails…\n\n<!-- nexus:opportunity:x -->",
  labels: [],
  rows: [
    { k: "does", v: "creates one GitHub issue with exactly the text below" },
    { k: "where", v: "acme/web" },
  ],
  actionHash: HASH,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

const created = opportunity({
  status: "ISSUE_CREATED",
  issue: { repositoryFullName: "acme/web", number: 7, url: "https://github.com/acme/web/issues/7" },
});

let items: Opportunity[];

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json({ configured: false }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/research/opportunities": () => json({ items }),
    [`GET /v1/research/opportunities/${OPP}`]: () => json(items[0] ?? opportunity()),
    "GET /v1/repositories": () => json({ items: [repo], syncedAt: NOW }),
    ...extra,
  });
}

beforeEach(() => {
  items = [opportunity()];
});

const zone = () => screen.findByRole("region", { name: "Noticed for you" });
const card = async () => within(await zone()).findByRole("article", { name: opportunity().title });
const why = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;

describe("Noticed for you on Today", () => {
  it("says what to do when nothing was noticed yet", async () => {
    items = [];
    board();
    renderApp(IN_PROJECT);
    // Nothing noticed: Today shrinks the section to one line.
    expect(
      await within(await zone()).findByText(
        /nothing yet: a deep dive turns what it verifies into cards here/,
      ),
    ).toBeTruthy();
  });

  it("shows the API's error, and the offline message when the API can't be reached", async () => {
    board({ "GET /v1/research/opportunities": () => apiError(409, "CONFLICT", "Something is off.") });
    renderApp(IN_PROJECT);
    expect(await within(await zone()).findByText("Something is off.")).toBeTruthy();
  });

  it("offline: says the API is unreachable", async () => {
    board({
      "GET /v1/research/opportunities": () => Promise.reject(new TypeError("Failed to fetch")),
    });
    renderApp(IN_PROJECT);
    expect(await within(await zone()).findByText(/Can't reach the NEXUS API/)).toBeTruthy();
  });

  it("asks for this project's opportunities only, and the All view for every project's", async () => {
    const calls = board();
    renderApp(IN_PROJECT);
    await card();
    localStorage.clear(); // a fresh browser: nothing remembered, so "/" is the All view
    renderApp("/");
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/research/opportunities").length).toBe(2));
    const asked = calls
      .filter((c) => c.path === "/v1/research/opportunities")
      .map((c) => c.query.get("projectId"));
    expect(asked).toEqual([PROJECT_ID, null]);
  });

  it("a card: kind tag in words, confidence as a label, impact est., one evidence line and agent chips", async () => {
    board();
    renderApp(IN_PROJECT);
    const c = await card();
    expect(within(c).getByText("Risk")).toBeTruthy();
    expect(within(c).getByText("medium confidence")).toBeTruthy();
    expect(c.textContent).toContain("fewer failed payments est.");
    expect(c.textContent).toContain("“Checkout failures doubled after the release.” — acme.dev");
    expect(c.textContent).not.toContain("Everyone is leaving"); // only verified quotes reach the card
    expect(c.textContent).not.toMatch(/\d%/);
    expect(
      within(within(c).getByRole("list", { name: "Agents" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["AI researcher", "DevOps"]);
  });

  it("the All view is read-only: Preview and Approve are disabled with the reason; Explain still opens", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const c = await card();
    const previewBtn = within(c).getByRole("button", { name: /^Preview/ });
    const approveBtn = within(c).getByRole("button", { name: /^Approve/ });
    expect((previewBtn as HTMLButtonElement).disabled).toBe(true);
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
    expect(why(approveBtn)).toBe(PICK_PROJECT);
    await user.click(within(c).getByRole("button", { name: /^Explain/ }));
    expect(router.state.location.search).toMatchObject({ drawer: `opp:${OPP}` });
  });

  it("Approve stays disabled until the issue was previewed", async () => {
    board();
    renderApp(IN_PROJECT);
    const approveBtn = within(await card()).getByRole("button", { name: /^Approve/ });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
    expect(why(approveBtn)).toMatch(/Preview the issue first/);
  });

  it("a created issue shows only its GitHub link from the API", async () => {
    items = [created];
    board();
    renderApp(IN_PROJECT);
    const link = await within(await zone()).findByRole("link", { name: /Created #7 on acme\/web/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/issues/7");
    expect(within(await zone()).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});

describe("opp drawer", () => {
  it("Explain: evidence claims with labels, quotes, found / not found on page, sources and contested", async () => {
    board();
    renderApp(`${IN_PROJECT}&drawer=opp:${OPP}`);
    const d = await screen.findByRole("dialog");
    expect(await within(d).findByRole("heading", { name: opportunity().title })).toBeTruthy();
    expect(within(d).getByText(/AI inference: unverified · medium confidence/)).toBeTruthy();
    const claims = within(within(d).getByRole("list", { name: "Evidence claims" })).getAllByRole("listitem", {
      name: "",
    });
    const first = claims[0]!;
    expect(within(first).getByText("Corroborated")).toBeTruthy();
    expect(within(first).getByText("✓ found on page")).toBeTruthy();
    expect(within(first).getByText("not found on page")).toBeTruthy();
    // Only the verified page is a link; the unverified URL stays text.
    expect(
      within(first)
        .getByRole("link", { name: /acme\.dev/ })
        .getAttribute("href"),
    ).toBe("https://acme.dev/post");
    expect(within(first).queryByRole("link", { name: /rumour/ })).toBeNull();
    expect(within(first).getByText("https://rumour.example/x")).toBeTruthy();
    expect(d.textContent).toContain("A verified source contradicts this claim");
    expect(d.textContent).toContain("the researcher's inference");
  });

  it("keyboard: Preview → bound repo → exactly what will happen → Approve sends the hash → Created #n", async () => {
    const calls = board({
      [`POST /v1/research/opportunities/${OPP}/issue-preview`]: () => json(preview),
      [`POST /v1/research/opportunities/${OPP}/issue`]: () => {
        items = [created];
        return json(created);
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    within(await card())
      .getByRole("button", { name: /^Preview/ })
      .focus();
    await user.keyboard("{Enter}");
    expect(router.state.location.search).toMatchObject({ drawer: `opp:${OPP}:preview` });
    const d = await screen.findByRole("dialog");
    const select = await within(d).findByRole("combobox", { name: /Repository/ });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a repository", "acme/web"]);
    await waitFor(() => expect(document.activeElement).toBe(select));
    await user.tab();
    await user.keyboard("{Enter}"); // Preview issue
    expect(await within(d).findByText("Exactly what will happen")).toBeTruthy();
    expect(d.textContent).toContain("creates one GitHub issue with exactly the text below");
    expect(calls.find((c) => c.path.endsWith("/issue-preview"))!.body).toEqual({ repositoryId: "101" });
    expect(calls.filter((c) => c.path.endsWith("/issue"))).toHaveLength(0);

    await user.click(within(d).getByRole("button", { name: "Approve: create issue on acme/web" }));
    const link = await within(d).findByRole("link", { name: /Created #7 on acme\/web/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/issues/7");
    const post = calls.filter((c) => c.method === "POST" && c.path.endsWith(`/${OPP}/issue`));
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toEqual({ repositoryId: "101", actionHash: HASH });
    expect(IdempotencyKey.safeParse(post[0]!.headers.get(IDEMPOTENCY_HEADER)).success).toBe(true);
  });

  it("after a preview the card's Approve sends that hash; a 409 from the API is shown", async () => {
    const calls = board({
      [`POST /v1/research/opportunities/${OPP}/issue-preview`]: () => json(preview),
      [`POST /v1/research/opportunities/${OPP}/issue`]: () =>
        apiError(409, "CONFLICT", "The issue changed since it was shown; preview it again."),
    });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=opp:${OPP}`);
    const d = await screen.findByRole("dialog");
    await within(d).findByRole("combobox", { name: /Repository/ });
    await user.click(within(d).getByRole("button", { name: "Preview issue" }));
    await within(d).findByText("Exactly what will happen");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const approveBtn = within(await card()).getByRole("button", { name: /^Approve/ });
    await waitFor(() => expect((approveBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(approveBtn);
    expect(await within(await card()).findByRole("alert")).toBeTruthy();
    expect((await card()).textContent).toContain("preview it again");
    expect(within(await card()).queryByRole("link", { name: /Created/ })).toBeNull();
    const post = calls.filter((c) => c.method === "POST" && c.path.endsWith(`/${OPP}/issue`));
    expect(post.map((c) => c.body)).toEqual([{ repositoryId: "101", actionHash: HASH }]);
  });

  it("Dismiss marks it dismissed", async () => {
    const dismiss = vi.fn(() => {
      items = [opportunity({ status: "DISMISSED" })];
      return json(items[0]);
    });
    board({ [`POST /v1/research/opportunities/${OPP}/dismiss`]: dismiss });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=opp:${OPP}`);
    const d = await screen.findByRole("dialog");
    await user.click(await within(d).findByRole("button", { name: "Dismiss" }));
    expect(await within(d).findByText(/Dismissed\. It no longer shows on Today\./)).toBeTruthy();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
