import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// The board needs several request rounds (session, workspaces, scope, data) before content appears;
// 1 s (the default) is too tight on slower CI runners. Only affects how long a find* waits, not passing tests.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
