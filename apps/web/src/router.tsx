import { z } from "zod";
import { QueryCache, QueryClient } from "@tanstack/react-query";
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

// Deep-linkable board state: `/?ws=dev&drawer=run:<uuid>`. Bad values fall back instead of erroring.
export const BoardSearch = z.object({
  ws: Workspace.optional().catch(undefined),
  drawer: z
    .string()
    .regex(/^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional()
    .catch(undefined),
});

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: Login });

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
