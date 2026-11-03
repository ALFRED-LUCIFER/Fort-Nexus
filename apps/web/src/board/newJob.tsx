import type { ReactNode } from "react";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";

// shortcut: Jobs wave coordinator stub; builder D replaces this file (New job form + job draft drawer).
export function NewJobDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="New job" title="New job" />
      <DrawerState error={null} />
    </Drawer>
  );
}

export function JobDraftDrawer({
  id,
  banner,
  onClose,
}: {
  id: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="New job" title={`Draft ${id.slice(0, 8)}`} />
      <DrawerState error={null} />
    </Drawer>
  );
}
