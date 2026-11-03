// shortcut: Cofounder wave coordinator stub; builder D replaces this file (Cofounder panel, push-to-talk, spoken
// replies, voice HUD).
export function CofounderPanel({ projectId }: { projectId: string | undefined }) {
  return (
    <aside aria-label="Cofounder" className="text-ink3">
      {projectId ? "Cofounder" : "Pick a project to talk with your cofounder."}
    </aside>
  );
}
