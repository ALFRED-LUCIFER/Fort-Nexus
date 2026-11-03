// Adapter for module A's Sources tab (P1 wave 5: apps/web/src/board/researchSources.tsx), with the signature pinned in
// docs/specs/p1-wave-5-researcher.md. Deleted by the coordinator at merge: real module replaces this.

export function ResearchSources({ workspaceId }: { workspaceId: string }) {
  return (
    <section aria-label="Sources" data-workspace-id={workspaceId} className="flex flex-col gap-2">
      <h3 className="kicker m-0">Sources</h3>
      <p className="m-0 text-[14px] leading-relaxed text-ink2">
        The domain rules for this workspace aren&apos;t available in this build of NEXUS.
      </p>
    </section>
  );
}
