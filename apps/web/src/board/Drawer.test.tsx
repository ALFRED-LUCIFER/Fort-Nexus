import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, json, mockFetch, renderApp, runner } from "../test/helpers.tsx";

// Own file: Motion reads prefers-reduced-motion once per module instance.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/approvals": () => json({ items: [] }),
  });
});

describe("drawer with prefers-reduced-motion", () => {
  it("skips the slide (no transform) but still opens and closes", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/?drawer=inbox");
    const drawer = await screen.findByRole("dialog", { name: "What needs you" });
    // The transform snaps to rest at once while the opacity fade is still running.
    await waitFor(() => expect(drawer.style.transform).toBe("none"));
    expect(Number(drawer.style.opacity)).toBeLessThan(1);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({});
  });
});
