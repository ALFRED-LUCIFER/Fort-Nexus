import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GITHUB_SETUP_COMMAND } from "@nexus/contracts";
import { apiError, json, mockFetch, renderApp } from "./test/helpers.tsx";

const CONFIGURED = { github: { configured: true, ownerLogin: "octo-owner" } };
const status = (body: unknown = CONFIGURED) => ({ "GET /v1/auth/status": () => json(body) });
const continueButton = () => screen.findByRole("button", { name: "Continue with GitHub" });

afterEach(() => {
  window.location.hash = "";
});

describe("login", () => {
  it("sends unauthenticated visitors to Continue with GitHub", async () => {
    mockFetch({ "GET /v1/me": () => apiError(401, "UNAUTHENTICATED", "Sign in first."), ...status() });
    renderApp("/");
    expect(await continueButton()).toBeTruthy();
    expect(screen.getByText(/Only @octo-owner can sign in/)).toBeTruthy();
  });

  it("starts Better Auth's GitHub sign-in and follows its redirect", async () => {
    const calls = mockFetch({
      ...status(),
      // Same-document URL: jsdom can't leave the page, a hash change proves the redirect was followed.
      "POST /api/auth/sign-in/social": () =>
        json({ url: `${window.location.origin}/#github`, redirect: true }),
    });
    renderApp("/login");
    await userEvent.setup().click(await continueButton());
    expect(await screen.findByRole("button", { name: "Opening GitHub…" })).toHaveProperty("disabled", true);
    expect(calls.find((c) => c.path === "/api/auth/sign-in/social")?.body).toEqual({
      provider: "github",
      callbackURL: "/",
    });
    expect(window.location.hash).toBe("#github");
  });

  it("shows the setup command when GitHub isn't configured", async () => {
    mockFetch(status({ github: { configured: false } }));
    renderApp("/login");
    expect((await screen.findByText(GITHUB_SETUP_COMMAND)).tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
  });

  it.each([
    ["not_owner", "This GitHub account isn't the owner of this NEXUS."],
    ["access_denied", "GitHub sign-in was cancelled."],
    ["state_mismatch", "GitHub sign-in didn't complete (state_mismatch). Try again."],
  ])("explains a sign-in sent back with ?error=%s", async (code, message) => {
    mockFetch(status());
    renderApp(`/login?error=${code}`);
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(await continueButton()).toBeTruthy();
  });

  it("ignores an ?error= that isn't a plain code", async () => {
    mockFetch(status());
    renderApp(`/login?error=${encodeURIComponent("Call +1 555 0100 now")}`);
    expect(await continueButton()).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [429, "Too many sign-in attempts. Wait a minute, then try again."],
    [502, "Can't reach the NEXUS API. Check that it is running on the home machine."],
  ])("explains HTTP %i from sign-in", async (code, message) => {
    mockFetch({ ...status(), "POST /api/auth/sign-in/social": () => json({ message: "raw" }, code) });
    renderApp("/login");
    await userEvent.setup().click(await continueButton());
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect((await continueButton()).hasAttribute("disabled")).toBe(false);
  });

  it("says when the API is unreachable and retries on request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderApp("/login");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Can't reach the NEXUS API/);
    mockFetch(status());
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await continueButton()).toBeTruthy();
  });

  it("says when the status check is rate limited", async () => {
    mockFetch({ "GET /v1/auth/status": () => apiError(429, "RATE_LIMITED", "Too many requests") });
    renderApp("/login");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many sign-in attempts. Wait a minute, then try again.",
    );
  });
});
