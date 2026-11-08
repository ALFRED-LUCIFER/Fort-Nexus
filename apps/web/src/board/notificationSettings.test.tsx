import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
  type PushDevice,
  type PushDeviceList,
} from "@nexus/contracts";
import { ME, apiError, json, mockFetch, renderApp, runner } from "../test/helpers.tsx";
import type { PushEnv } from "../lib/push.ts";

// Settings → Notifications against a mocked API; the browser's push machinery (service worker, PushManager,
// Notification permission) is faked at lib/push.ts, the module that wraps it.

const push = vi.hoisted(() => ({
  env: null as PushEnv | null,
  subscribe: vi.fn(),
  hash: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("../lib/push.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/push.ts")>();
  return {
    ...real,
    pushEnv: () => push.env!,
    subscribeThisBrowser: push.subscribe,
    thisBrowserEndpointHash: push.hash,
    unsubscribeThisBrowser: push.unsubscribe,
  };
});

const PHONE: PushEnv = {
  production: true,
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: "default",
  ios: true,
  standalone: true,
};
const VAPID = "B".repeat(87);
const device = (over: Partial<PushDevice> = {}): PushDevice => ({
  id: "99999999-9999-4999-8999-000000000001",
  label: "Alfred's iPhone",
  service: "APPLE",
  status: "ACTIVE",
  endpointHash: "0123456789abcdef",
  createdAt: "2026-11-08T10:00:00.000Z",
  lastSentAt: null,
  lastFailureAt: null,
  lastError: null,
  ...over,
});
const list = (items: PushDevice[], over: Partial<PushDeviceList> = {}): PushDeviceList => ({
  vapidPublicKey: VAPID,
  problem: null,
  items,
  ...over,
});
const SUB = {
  endpoint: "https://web.push.apple.com/abc",
  expirationTime: null,
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
};

let prefs: NotificationPreferences;
const base = (devices: () => Response) => ({
  "GET /v1/me": () => json(ME),
  "GET /v1/runners": () => json({ items: [runner()] }),
  "GET /v1/devices": devices,
  "GET /v1/notification-preferences": () => json(prefs),
  "PUT /v1/notification-preferences": (c: { body: unknown }) => {
    prefs = c.body as NotificationPreferences;
    return json(prefs);
  },
});
const open = () => renderApp("/?drawer=settings#notif");

beforeEach(() => {
  push.env = PHONE;
  push.subscribe.mockReset().mockResolvedValue(SUB);
  push.hash.mockReset().mockResolvedValue(null);
  push.unsubscribe.mockReset().mockResolvedValue(undefined);
  prefs = defaultNotificationPreferences("Asia/Dubai");
});

describe("Settings → Notifications", () => {
  it("turns push on for this phone with the owner's name for it", async () => {
    let items: PushDevice[] = [];
    const calls = mockFetch({
      ...base(() => json(list(items))),
      "POST /v1/devices": (c) => {
        items = [device({ label: (c.body as { label: string }).label })];
        push.hash.mockResolvedValue("0123456789abcdef");
        return json(items[0], 201);
      },
    });
    open();
    expect(await screen.findByText("No devices yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Turn on push" }));
    expect(await screen.findByText(/Give the device a name/)).toBeTruthy();
    expect(push.subscribe).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Name this device"), "Alfred's iPhone");
    await userEvent.click(screen.getByRole("button", { name: "Turn on push" }));
    expect(await screen.findByText(/Push is on for this device as/)).toBeTruthy();
    expect(push.subscribe).toHaveBeenCalledWith(VAPID);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      label: "Alfred's iPhone",
      subscription: SUB,
    });
    expect(screen.getByText("Alfred's iPhone · this device")).toBeTruthy();
  });

  it("says why push can't be turned on on an iPhone that hasn't added NEXUS to the Home Screen", async () => {
    mockFetch(base(() => json(list([]))));
    push.env = { ...PHONE, standalone: false };
    open();
    expect(await screen.findByText(/tap Share → Add to Home Screen/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on push" })).toBeNull();
  });

  it("says push needs HTTPS on a plain http origin", async () => {
    mockFetch(base(() => json(list([]))));
    push.env = { ...PHONE, ios: false, secure: false };
    open();
    expect(await screen.findByText(/Push needs HTTPS/)).toBeTruthy();
  });

  it("shows the home machine's push problem", async () => {
    mockFetch(
      base(() => json(list([], { vapidPublicKey: null, problem: "Push keys aren't set up: run nexus up." }))),
    );
    open();
    const alert = await screen.findByText("Push isn't available on the home machine");
    expect(within(alert.parentElement!).getByText(/Push keys aren't set up/)).toBeTruthy();
  });

  it("sends a test push with an idempotency key, and revokes after a confirm", async () => {
    let items = [
      device({ endpointHash: "aaaaaaaaaaaaaaaa" }),
      device({
        id: "99999999-9999-4999-8999-000000000002",
        label: "Office Chrome",
        service: "GOOGLE",
        status: "GONE",
        lastError:
          "The push service no longer knows this subscription (HTTP 410). Turn push on again on the device.",
      }),
    ];
    push.hash.mockResolvedValue("aaaaaaaaaaaaaaaa");
    const calls = mockFetch({
      ...base(() => json(list(items))),
      "POST /v1/devices/99999999-9999-4999-8999-000000000001/test": () =>
        json({ deliveryId: "99999999-9999-4999-8999-0000000000aa", status: "PENDING" }, 202),
      "DELETE /v1/devices/99999999-9999-4999-8999-000000000001": () => {
        items = [{ ...items[0]!, status: "REVOKED" }, items[1]!];
        return json(items[0]);
      },
    });
    open();
    expect(await screen.findByText(/HTTP 410/)).toBeTruthy();
    expect(screen.getByText("gone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a test push to Office Chrome" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Send a test push to Alfred's iPhone" }));
    expect(await screen.findByText(/Test push queued/)).toBeTruthy();
    const test = calls.find((c) => c.path.endsWith("/test"))!;
    expect(test.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);

    await userEvent.click(screen.getByRole("button", { name: "Revoke Alfred's iPhone" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke Alfred's iPhone" }));
    await waitFor(() => expect(push.unsubscribe).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Alfred's iPhone/)).toBeNull());
  });

  it("switches channels per category; approvals and security stay in the Inbox", async () => {
    mockFetch(base(() => json(list([]))));
    open();
    const approvals = await screen.findByRole("switch", { name: "Approvals waiting in the Inbox" });
    expect(approvals).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch", { name: "Security in the Inbox" })).toHaveProperty("disabled", true);

    const pushUpdates = screen.getByRole("switch", { name: "Updates as push" });
    expect(pushUpdates.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(pushUpdates);
    await waitFor(() => expect(prefs.categories.INFORMATIONAL.push).toBe(false));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Updates as push" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
  });

  it("saves quiet hours, refusing a fake time zone", async () => {
    mockFetch(base(() => json(list([]))));
    open();
    const form = await screen.findByRole("form", { name: "Quiet hours" });
    await userEvent.click(within(form).getByRole("switch", { name: "Quiet hours" }));
    const tz = within(form).getByLabelText("Time zone");
    await userEvent.clear(tz);
    await userEvent.type(tz, "+04:00");
    expect(await within(form).findByText(/IANA time zone/)).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Save quiet hours" })).toHaveProperty("disabled", true);

    await userEvent.clear(tz);
    await userEvent.type(tz, "Asia/Dubai");
    await userEvent.click(within(form).getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() =>
      expect(prefs.quietHours).toMatchObject({ enabled: true, start: "22:00", end: "07:00" }),
    );
    expect(within(form).getByText("Pushes wait until 07:00, then arrive as one summary.")).toBeTruthy();
  });

  it("the Inbox says where its notices are also pushed, linking to these settings", async () => {
    prefs.quietHours = { ...prefs.quietHours, enabled: true };
    mockFetch({
      ...base(() =>
        json(list([device(), device({ id: "99999999-9999-4999-8999-000000000003", status: "GONE" })])),
      ),
      "GET /v1/approvals": () => json({ items: [] }),
      "GET /v1/notifications": () => json({ items: [], unreadCount: 0 }),
    });
    renderApp("/?drawer=inbox");
    expect(
      await screen.findByText("Also pushed to 1 device · quiet 22:00–07:00 (Asia/Dubai), then one summary."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Change\s*in Settings → Notifications$/ }));
    expect(await screen.findByRole("region", { name: "What goes where" })).toBeTruthy();
  });

  it("shows a load error instead of the settings", async () => {
    mockFetch(base(() => apiError(500, "INTERNAL", "Internal server error")));
    open();
    expect(await screen.findByText("Internal server error")).toBeTruthy();
  });
});
