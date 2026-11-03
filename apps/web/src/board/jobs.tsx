import type { ReactNode } from "react";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";

// shortcut: Jobs wave coordinator stub; builder C replaces this file (Jobs page + agent performance).
export function JobsDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="Jobs" title="Jobs" />
      <DrawerState error={null} />
    </Drawer>
  );
}
