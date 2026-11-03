import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ResearchDomain, SearchProviderStatus } from "@nexus/contracts";
import { apiError, json, mockFetch } from "../test/helpers.tsx";
import { ResearchSources } from "./researchSources.tsx";

const WS = "99999999-9999-4999-8999-999999999991";
const T0 = "2026-11-03T10:00:00.000Z";
const rule = (over: Partial<ResearchDomain> = {}): ResearchDomain => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: WS,
  domain: "acme.dev",
  tier: "PRIMARY",
  blocked: false,
  note: "vendor docs",
  updatedAt: T0,
  ...over,
});
const FARM = rule({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  domain: "content-farm.example",
  tier: "COMMUNITY",
  blocked: true,
  note: null,
});
const CONFIGURED: SearchProviderStatus = { configured: true, provider: "brave" };
const MISSING: SearchProviderStatus = {
  configured: false,
  reason: "Web search isn't set up. On the home machine create ~/.nexus/search.json with mode 0600.",
  runbook: "docs/runbooks/web-search.md",
};

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ResearchSources workspaceId={WS} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

afterEach(() => onlineManager.setOnline(true));

describe("Research → Sources", () => {
  it("lists rules with tier and blocked state as text, and the configured provider", async () => {
    const calls = mockFetch({
      "GET /v1/research/domains": () => json({ items: [rule(), FARM] }),
      "GET /v1/research/search-provider": () => json(CONFIGURED),
    });
    mount();
    const rules = await screen.findByRole("region", { name: "Domain rules" });
    const items = await within(rules).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("acme.dev")).toBeTruthy();
    expect(within(items[0]!).getByText("primary")).toBeTruthy();
    expect(within(items[0]!).getByText("vendor docs")).toBeTruthy();
    expect(within(items[0]!).queryByText("blocked")).toBeNull();
    expect(within(items[1]!).getByText("blocked")).toBeTruthy();
    expect(within(items[1]!).getByText("community")).toBeTruthy();
    const provider = screen.getByRole("region", { name: "Web search provider" });
    expect(await within(provider).findByText("configured")).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/research/domains")!.query.get("workspaceId")).toBe(WS);
  });

  it("shows the honest empty state and the runbook when search isn't configured", async () => {
    mockFetch({
      "GET /v1/research/domains": () => json({ items: [] }),
      "GET /v1/research/search-provider": () => json(MISSING),
    });
    mount();
    expect(await screen.findByText(/No domain rules yet/)).toBeTruthy();
    const provider = screen.getByRole("region", { name: "Web search provider" });
    expect(await within(provider).findByText("not configured")).toBeTruthy();
    expect(within(provider).getByText(MISSING.reason)).toBeTruthy();
    expect(within(provider).getByText("docs/runbooks/web-search.md")).toBeTruthy();
  });

  it("validates before saving, then PUTs the rule and reloads the list", async () => {
    let items: ResearchDomain[] = [];
    const calls = mockFetch({
      "GET /v1/research/domains": () => json({ items }),
      "GET /v1/research/search-provider": () => json(CONFIGURED),
      "PUT /v1/research/domains": (c) => {
        items = [rule({ ...(c.body as Partial<ResearchDomain>), note: null })];
        return json(items[0]);
      },
    });
    const { user } = mount();
    const form = await screen.findByRole("form", { name: "Add a rule" });
    const domain = within(form).getByLabelText("Domain (covers its subdomains)");
    await user.type(domain, "https://acme.dev/path");
    await user.click(within(form).getByRole("button", { name: "Save rule" }));
    expect(domain.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByText(/no https:\/\/, path or port/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.clear(domain);
    await user.type(domain, "Blog.Acme.dev");
    await user.click(within(form).getByLabelText(/^Community/));
    await user.click(within(form).getByLabelText(/^Block this domain/));
    await user.click(within(form).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      workspaceId: WS,
      domain: "blog.acme.dev",
      tier: "COMMUNITY",
      blocked: true,
    });
    expect(await screen.findByText("blog.acme.dev")).toBeTruthy();
    expect((domain as HTMLInputElement).value).toBe("");
  });

  it("edits a rule from the keyboard: the domain is fixed, the tier changes, cancel restores the add form", async () => {
    const calls = mockFetch({
      "GET /v1/research/domains": () => json({ items: [rule()] }),
      "GET /v1/research/search-provider": () => json(CONFIGURED),
      "PUT /v1/research/domains": (c) => json(rule(c.body as Partial<ResearchDomain>)),
    });
    const { user } = mount();
    const edit = await screen.findByRole("button", { name: "Edit rule for acme.dev" });
    edit.focus();
    await user.keyboard("{Enter}");
    const form = screen.getByRole("form", { name: "Edit acme.dev" });
    const domain = within(form).getByLabelText<HTMLInputElement>("Domain (covers its subdomains)");
    expect(domain.value).toBe("acme.dev");
    expect(domain.readOnly).toBe(true);
    expect(within(form).getByLabelText<HTMLInputElement>(/^Primary/).checked).toBe(true);
    expect(within(form).getByLabelText<HTMLInputElement>(/^Note/).value).toBe("vendor docs");
    await user.click(within(form).getByLabelText(/^Secondary/));
    await user.click(within(form).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      domain: "acme.dev",
      tier: "SECONDARY",
      note: "vendor docs",
    });
    expect(await screen.findByRole("form", { name: "Add a rule" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit rule for acme.dev" }));
    await user.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.getByRole("form", { name: "Add a rule" })).toBeTruthy();
  });

  it("removes a rule only after confirming", async () => {
    const calls = mockFetch({
      "GET /v1/research/domains": () => json({ items: [rule()] }),
      "GET /v1/research/search-provider": () => json(CONFIGURED),
      [`DELETE /v1/research/domains/${rule().id}`]: () => new Response(null, { status: 204 }),
    });
    const { user } = mount();
    await user.click(await screen.findByRole("button", { name: "Remove rule for acme.dev" }));
    expect(screen.getByText(/goes back to Community/)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep" }));
    await user.click(screen.getByRole("button", { name: "Remove rule for acme.dev" }));
    await user.click(screen.getByRole("button", { name: "Confirm remove acme.dev" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
  });

  it("shows load and save errors from the API as alerts", async () => {
    mockFetch({
      "GET /v1/research/domains": () => apiError(404, "NOT_FOUND", "Workspace not found"),
      "GET /v1/research/search-provider": () => apiError(500, "INTERNAL", "boom"),
      "PUT /v1/research/domains": () => apiError(404, "NOT_FOUND", "Workspace not found"),
    });
    const { user } = mount();
    const rules = await screen.findByRole("region", { name: "Domain rules" });
    expect((await within(rules).findByRole("alert")).textContent).toBe("Workspace not found");
    const provider = screen.getByRole("region", { name: "Web search provider" });
    expect((await within(provider).findByRole("alert")).textContent).toMatch(
      /Couldn't check web search: boom/,
    );
    const form = screen.getByRole("form", { name: "Add a rule" });
    await user.type(within(form).getByLabelText("Domain (covers its subdomains)"), "acme.dev");
    await user.click(within(form).getByRole("button", { name: "Save rule" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Workspace not found");
  });

  it("says when the API is unreachable, and when the browser is offline", async () => {
    mockFetch({
      "GET /v1/research/domains": () => Promise.reject(new TypeError("Failed to fetch")),
      "GET /v1/research/search-provider": () => Promise.reject(new TypeError("Failed to fetch")),
    });
    mount();
    const rules = await screen.findByRole("region", { name: "Domain rules" });
    expect((await within(rules).findByRole("alert")).textContent).toMatch(/Can't reach the NEXUS API/);
  });

  it("offline: queries wait and say so instead of loading forever", async () => {
    onlineManager.setOnline(false);
    const calls = mockFetch({
      "GET /v1/research/domains": () => json({ items: [] }),
      "GET /v1/research/search-provider": () => json(CONFIGURED),
    });
    mount();
    expect(await screen.findAllByText(/You're offline/)).toHaveLength(2);
    expect(calls.filter((c) => c.path.startsWith("/v1/research"))).toHaveLength(0);
    onlineManager.setOnline(true);
    expect(await screen.findByText(/No domain rules yet/)).toBeTruthy();
  });
});
