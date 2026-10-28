import { z } from "zod";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { LazyMotion, MotionConfig } from "motion/react";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { ApiRequestError, api, keys } from "./lib/api.ts";
import { Login } from "./Login.tsx";
import { Board } from "./board/Board.tsx";

export const Workspace = z.enum(["all", "dev", "business"]);
export type Workspace = z.infer<typeof Workspace>;

// The router JSON-parses search values, so a hand-typed `q=123` arrives as a number.
const text = (max: number) =>
  z
    .preprocess((v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v), z.string().max(max))
    .optional()
    .catch(undefined);

// Deep-linkable board state: `/?ws=dev&project=<uuid>&drawer=run:<uuid>`, `drawer=repo:<repoId>` (with issue filters),
// `drawer=issue:<repoId>:<number>`, `drawer=inbox`, `drawer=settings`, `drawer=business`, `drawer=research`, `drawer=talk` (threads) / `drawer=talk:<uuid>` (one thread), `drawer=systems`, `drawer=incident:<uuid>`. Bad values fall back instead of erroring.
export const BoardSearch = z.object({
  ws: Workspace.optional().catch(undefined),
  // The selected project of `ws` (FR-WKS-02); without one the board is a read-only aggregate.
  project: z.uuid().optional().catch(undefined),
  drawer: z
    .string()
    .regex(
      /^(run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|repo:[1-9]\d{0,19}|issue:[1-9]\d{0,19}:[1-9]\d{0,9}|incident:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|inbox|settings|business|research|systems|talk(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/i,
    )
    .optional()
    .catch(undefined),
  state: z.enum(["open", "closed", "all"]).optional().catch(undefined),
  labels: text(500),
  assignee: text(39),
  q: text(256),
  page: z.int().min(1).max(40).optional().catch(undefined),
});
export type BoardSearch = z.infer<typeof BoardSearch>;

const motionFeatures = () => import("./lib/motionFeatures.ts").then((mod) => mod.default);

// Every page animates through `m` (strict); transforms are skipped for prefers-reduced-motion.
function Root() {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={motionFeatures} strict>
        <Outlet />
      </LazyMotion>
    </MotionConfig>
  );
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Root });

// Better Auth sends failed GitHub sign-ins back as `/login?error=<code>`; anything else is dropped.
export const LoginSearch = z.object({
  error: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional()
    .catch(undefined),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: LoginSearch,
  component: Login,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: BoardSearch,
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData({ queryKey: keys.me, queryFn: api.me });
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) throw redirect({ to: "/login" });
      throw e;
    }
  },
  component: Board,
  errorComponent: BoardError,
});

function BoardError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <main className="grid h-full place-items-center p-4">
      <div role="alert" className="glass2 flex max-w-md flex-col gap-4 rounded-[22px] p-6">
        <span className="kicker">NEXUS can't load the board</span>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <button
          type="button"
          onClick={() => void router.invalidate()}
          className="self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc"
        >
          Try again
        </button>
      </div>
    </main>
  );
}

const routeTree = rootRoute.addChildren([loginRoute, boardRoute]);

const makeRouter = (queryClient: QueryClient, history?: RouterHistory) =>
  createRouter({ routeTree, context: { queryClient }, history, defaultPreloadStaleTime: 0 });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}

/** One router + query client pair; tests pass a memory history. */
export function createApp(history?: RouterHistory) {
  const queryClient: QueryClient = new QueryClient({
    // An expired session on any request sends the owner back to sign in.
    queryCache: new QueryCache({
      onError: (e) => {
        if (e instanceof ApiRequestError && e.status === 401) void router.navigate({ to: "/login" });
      },
    }),
    defaultOptions: {
      queries: {
        // Retry only transport/server failures, never 4xx answers.
        retry: (n, e) => n < 2 && !(e instanceof ApiRequestError && e.status >= 400 && e.status < 500),
      },
    },
  });
  const router = makeRouter(queryClient, history);
  return { router, queryClient };
}
