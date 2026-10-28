import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { GITHUB_SETUP_COMMAND } from "@nexus/contracts";
import { callbackErrorMessage, fetchAuthStatus, signInWithGithub } from "./lib/auth.ts";

const primary =
  "flex h-11 items-center justify-center gap-2.5 rounded-xl bg-teal text-[13px] font-medium text-onacc disabled:opacity-60";

function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="m-0 rounded-xl px-3 py-2.5 text-[13px] leading-snug text-coral"
      style={{ background: "oklch(0.62 0.15 32 / .12)" }}
    >
      {children}
    </p>
  );
}

function GithubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Login() {
  const { error: callbackError } = useSearch({ from: "/login" });
  const status = useQuery({ queryKey: ["auth", "status"], queryFn: fetchAuthStatus });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onContinue() {
    setPending(true);
    setError(null);
    const message = await signInWithGithub();
    // On success the browser is on its way to GitHub; stay pending so the button can't fire twice.
    if (message) {
      setError(message);
      setPending(false);
    }
  }

  let body: ReactNode;
  if (status.isPending)
    body = (
      <p role="status" className="m-0 text-[13px] text-ink3">
        Checking sign-in…
      </p>
    );
  else if (status.isError)
    body = (
      <>
        <Alert>{status.error.message}</Alert>
        <button type="button" onClick={() => void status.refetch()} className={primary}>
          Try again
        </button>
      </>
    );
  else if (!status.data.github.configured)
    body = (
      <section aria-labelledby="setup-title" className="flex flex-col gap-2.5">
        <h2 id="setup-title" className="kicker m-0">
          GitHub sign-in isn't set up yet
        </h2>
        <p className="m-0 text-[13px] leading-relaxed text-ink2">On the home machine, run:</p>
        <code className="rounded-xl border border-hair bg-hair px-3 py-2.5 font-mono text-[12.5px] break-all text-ink select-all">
          {GITHUB_SETUP_COMMAND}
        </code>
        <p className="m-0 text-[13px] leading-relaxed text-ink2">
          Then restart the API and reload this page.
        </p>
      </section>
    );
  else
    body = (
      <>
        {(error ?? callbackError) && <Alert>{error ?? callbackErrorMessage(callbackError!)}</Alert>}
        <button type="button" onClick={() => void onContinue()} disabled={pending} className={primary}>
          <GithubMark />
          {pending ? "Opening GitHub…" : "Continue with GitHub"}
        </button>
        {status.data.github.ownerLogin && (
          <p className="m-0 text-[12px] leading-relaxed text-ink3">
            Only @{status.data.github.ownerLogin} can sign in. GitHub's two-factor authentication protects
            this NEXUS.
          </p>
        )}
      </>
    );

  return (
    <main
      className="grid h-full place-items-center p-4"
      style={{
        backgroundImage: "radial-gradient(var(--dot) 1px, transparent 1.3px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div className="glass2 flex w-full max-w-sm flex-col gap-5 rounded-[30px] p-7">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-[22px] rounded-full"
            style={{ background: "conic-gradient(from 200deg, var(--teal), var(--amber), var(--teal))" }}
          />
          <h1 className="m-0 font-serif text-[30px] leading-none italic">nexus</h1>
        </div>
        <p className="m-0 text-[13px] leading-relaxed text-ink2">Sign in to supervise your home machine.</p>
        {body}
      </div>
    </main>
  );
}
