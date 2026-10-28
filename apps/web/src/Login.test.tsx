import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ME, apiError, json, mockFetch, renderApp } from "./test/helpers.tsx";

async function submit() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), "secret-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("login", () => {
  it("sends unauthenticated visitors to the login page", async () => {
    mockFetch({ "GET /v1/me": () => apiError(401, "UNAUTHENTICATED", "Sign in first.") });
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it.each([
    [401, "That email and password don't match. Try again."],
    [429, "Too many sign-in attempts. Wait a minute, then try again."],
    [502, "Can't reach the NEXUS API. Check that it is running on the home machine."],
  ])("explains HTTP %i", async (status, message) => {
    mockFetch({ "POST /api/auth/sign-in/email": () => json({ code: "X", message: "raw" }, status) });
    renderApp("/login");
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderApp("/login");
    await submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Can't reach the NEXUS API/);
  });

  it("opens the board after signing in", async () => {
    mockFetch({
      "POST /api/auth/sign-in/email": () => json({ token: "t", user: ME }),
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    });
    renderApp("/login");
    await submit();
    expect(await screen.findByRole("heading", { name: "Systems" })).toBeTruthy();
  });
});
