import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

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
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          className="nx-drawer fixed top-20 right-4 bottom-4 z-10 flex w-[min(760px,calc(100%-32px))] flex-col overflow-hidden rounded-[26px] border border-line bg-glass2 outline-none"
          style={{
            backdropFilter: "blur(30px) saturate(1.5)",
            WebkitBackdropFilter: "blur(30px) saturate(1.5)",
            boxShadow: "0 30px 90px -30px rgba(40,30,10,.4)",
          }}
        >
          {banner && <div className="flex-none px-6 pt-4">{banner}</div>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
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
