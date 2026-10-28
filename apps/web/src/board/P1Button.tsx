import { useId, type ReactNode } from "react";

/**
 * A control whose backend doesn't exist yet. It stays focusable (aria-disabled, not `disabled`)
 * so keyboard and screen-reader users hear why it does nothing.
 */
export function P1Button({
  why,
  className = "",
  children,
}: {
  why: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-disabled="true"
        aria-describedby={id}
        title={why}
        className={`cursor-not-allowed opacity-45 ${className}`}
      >
        {children}
      </button>
      <span id={id} hidden>
        {why}
      </span>
    </>
  );
}
