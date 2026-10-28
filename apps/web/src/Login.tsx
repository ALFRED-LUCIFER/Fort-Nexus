import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { signIn } from "./lib/auth.ts";

const field =
  "h-11 rounded-xl border border-hair bg-hair px-3 text-[15px] text-ink outline-none focus-visible:border-teal";

export function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const message = await signIn(String(form.get("email")), String(form.get("password")));
    setPending(false);
    if (message) return setError(message);
    queryClient.removeQueries();
    await navigate({ to: "/" });
  }

  return (
    <main
      className="grid h-full place-items-center p-4"
      style={{
        backgroundImage: "radial-gradient(var(--dot) 1px, transparent 1.3px)",
        backgroundSize: "22px 22px",
      }}
    >
      <form onSubmit={onSubmit} className="glass2 flex w-full max-w-sm flex-col gap-5 rounded-[30px] p-7">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-[22px] rounded-full"
            style={{ background: "conic-gradient(from 200deg, var(--teal), var(--amber), var(--teal))" }}
          />
          <h1 className="m-0 font-serif text-[30px] leading-none italic">nexus</h1>
        </div>
        <p className="m-0 text-[13px] leading-relaxed text-ink2">Sign in to supervise your home machine.</p>
        <label className="flex flex-col gap-1.5">
          <span className="kicker">Email</span>
          <input name="email" type="email" autoComplete="username" required className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="kicker">Password</span>
          <input name="password" type="password" autoComplete="current-password" required className={field} />
        </label>
        {error && (
          <p
            role="alert"
            className="m-0 rounded-xl px-3 py-2.5 text-[13px] leading-snug text-coral"
            style={{ background: "oklch(0.62 0.15 32 / .12)" }}
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="h-11 rounded-xl bg-teal text-[13px] font-medium text-onacc disabled:opacity-60"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
