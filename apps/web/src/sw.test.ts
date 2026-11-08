import { describe, expect, it, vi } from "vitest";
import source from "../public/sw.js?raw";

// public/sw.js runs as-is in the browser (never bundled); here it runs against a fake ServiceWorkerGlobalScope.

type Listener = (event: unknown) => void;
type Client = { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };

function load(clients: Client[] = []) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: NotificationOptions & { data?: { url: string } } }[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL("https://nexus.tailnet.ts.net/"),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    registration: {
      showNotification: vi.fn(async (title: string, options: NotificationOptions) => {
        shown.push({ title, options });
      }),
    },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async (url: string) => {
        opened.push(url);
      }),
    },
  };
  new Function("self", source)(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const push = (data: unknown) =>
    fire("push", {
      data:
        data === undefined
          ? null
          : {
              json: () => {
                if (typeof data === "string") return JSON.parse(data);
                return data;
              },
            },
    });
  const click = (url: unknown) => {
    const close = vi.fn();
    return fire("notificationclick", { notification: { close, data: { url } } }).then(() => close);
  };
  return { self, shown, opened, fire, push, click };
}

const client = (url: string): Client => {
  const c: Client = { url, focus: vi.fn(async () => c), navigate: vi.fn(async () => c) };
  return c;
};

describe("service worker", () => {
  it("shows the push's title and body, keeping its tag and deep link", async () => {
    const sw = load();
    await sw.push({
      title: "Run failed · tts-test#1",
      body: "Restart the runner.",
      url: "/?drawer=run:abc",
      tag: "n-1",
    });
    expect(sw.shown).toEqual([
      {
        title: "Run failed · tts-test#1",
        options: {
          body: "Restart the runner.",
          tag: "n-1",
          icon: "/icons/icon-192.png",
          data: { url: "/?drawer=run:abc" },
        },
      },
    ]);
  });

  it("still shows something for an empty or broken push, and never links off-site", async () => {
    const sw = load();
    await sw.push(undefined);
    await sw.push("{not json");
    await sw.push({ title: "Hi", body: "x", url: "https://evil.example/phish" });
    await sw.push({ title: "Hi", body: "x", url: "//evil.example/phish" });
    expect(sw.shown.map((s) => s.title)).toEqual(["NEXUS", "NEXUS", "Hi", "Hi"]);
    expect(sw.shown.map((s) => s.options.data!.url)).toEqual(Array(4).fill("/?drawer=inbox"));
  });

  it("focuses an open NEXUS window and takes it to the deep link", async () => {
    const other = client("https://example.com/");
    const mine = client("https://nexus.tailnet.ts.net/?area=code");
    const sw = load([other, mine]);
    const close = await sw.click("/?ws=dev&drawer=incident:1#x");
    expect(close).toHaveBeenCalled();
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.navigate).toHaveBeenCalledWith("/?ws=dev&drawer=incident:1#x");
    expect(other.focus).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it("opens a new window when none is open, or when the open one can't be navigated", async () => {
    const none = load();
    await none.click("/?drawer=plan:9");
    expect(none.opened).toEqual(["/?drawer=plan:9"]);

    const stuck = client("https://nexus.tailnet.ts.net/");
    stuck.navigate.mockRejectedValue(new TypeError("not controlled"));
    const sw = load([stuck]);
    await sw.click("javascript:alert(1)");
    expect(sw.opened).toEqual(["/?drawer=inbox"]);
  });

  it("takes over at once so the first push after install is handled", async () => {
    const sw = load();
    await sw.fire("install", {});
    await sw.fire("activate", {});
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});
