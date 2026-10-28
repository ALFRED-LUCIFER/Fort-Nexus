import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, m } from "motion/react";

// The design's drawer spring: 620 ms, slight overshoot. Opacity fades without bouncing.
const ENTER = { type: "spring", duration: 0.62, bounce: 0.3, opacity: { duration: 0.3 } } as const;
const EXIT = { duration: 0.18, ease: "easeIn" } as const;

/** The right-hand drawer every board node opens (design: 26px glass panel, staggered content). */
export function Drawer({
  banner,
  onClose,
  children,
}: {
  banner?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  // Esc / close button / outside click play the exit first; the owner unmounts us once it ends.
  const [open, setOpen] = useState(true);
  // Drawers open by URL, not a Dialog.Trigger, so Radix has nothing to refocus; return focus to the opener.
  const [opener] = useState(() => document.activeElement);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence onExitComplete={onClose}>
        {open && (
          <Dialog.Portal key="drawer" forceMount>
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                if (opener instanceof HTMLElement) opener.focus();
              }}
            >
              <m.div
                initial={{ opacity: 0, x: 48 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 48, transition: EXIT }}
                transition={ENTER}
                className="fixed top-20 right-4 bottom-4 z-10 flex w-[min(760px,calc(100%-32px))] flex-col overflow-hidden rounded-[26px] border border-line bg-glass2 outline-none"
                style={{
                  backdropFilter: "blur(30px) saturate(1.5)",
                  WebkitBackdropFilter: "blur(30px) saturate(1.5)",
                  boxShadow: "0 30px 90px -30px rgba(40,30,10,.4)",
                }}
              >
                {banner && <div className="flex-none px-6 pt-4">{banner}</div>}
                {children}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

export function DrawerHeader({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="flex items-start gap-4 border-b border-hair px-6 pt-5 pb-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="kicker">{kicker}</span>
        <Dialog.Title className="m-0 font-serif text-[30px] leading-[1.1] font-normal text-pretty break-words">
          {title}
        </Dialog.Title>
      </div>
      <Dialog.Close className="flex-none rounded-xl bg-hair px-3 py-2.5 text-[12px] font-medium text-ink2">
        Back to board <span className="ml-1.5 font-mono text-[10.5px] text-ink3">esc</span>
      </Dialog.Close>
    </div>
  );
}

/** Loading / error body shared by drawers whose data hasn't arrived. */
export function DrawerState({ error }: { error: Error | null }) {
  return (
    <div className="px-6 py-5">
      {error ? (
        <p role="alert" className="m-0 text-[14px] text-coral">
          {error.message}
        </p>
      ) : (
        <p role="status" className="m-0 text-[13px] text-ink3">
          Loading…
        </p>
      )}
    </div>
  );
}
