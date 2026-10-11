import type { GraphNode } from "../continuityGraph";

/** Task 11 placeholder: the real drawer (recent messages, focus, open-session) is Task 12. */
export function SessionDrawer({ node, onClose }: { projectId: string; node: GraphNode | null; onClose: () => void }) {
  if (!node) return null;
  return (
    <aside className="session-drawer">
      <button type="button" className="session-drawer-x" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h3>{node.label}</h3>
    </aside>
  );
}
