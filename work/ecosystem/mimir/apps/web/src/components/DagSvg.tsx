import type { Task, TaskDependency } from "@mimir/protocol";
import { statusInfo } from "@factory/docs";
import { statusRole } from "@factory/ui";
import { describeBlockedReason } from "../lib/blockedReason.js";
import { layerTasks } from "../lib/derive.js";
import { taskHeadline } from "../lib/names.js";

const W = 240;
const H = 52;
const GX = 72;
const GY = 28;
const MAX_CHARS = 30;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Layered left-to-right DAG. Edges are orthogonal: they leave a node into the gap after its layer,
 * run along the gutter between rows when they skip layers (so they never cross a node), and enter
 * the target from the gap before it. Each node has a <title> with the full task name and status;
 * status is written as text, not colour alone. Clicking a node calls `onSelect` (the task table
 * below is the keyboard path).
 */
export function DagSvg({
  tasks,
  deps,
  selectedId,
  onSelect,
}: {
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
  selectedId?: string | undefined;
  onSelect?: ((taskId: string) => void) | undefined;
}) {
  const layers = layerTasks(tasks, deps);
  const pos = new Map<string, { x: number; y: number; layer: number }>();
  layers.forEach((layer, li) =>
    layer.forEach((t, ti) => pos.set(t.id, { x: li * (W + GX), y: ti * (H + GY), layer: li })),
  );
  const width = Math.max(1, layers.length) * (W + GX) - GX + 2;
  // Top margin so a lane above the first row stays inside the drawing.
  const top = GY / 2;
  const height = Math.max(1, ...layers.map((l) => l.length)) * (H + GY) - GY + 2 + top;
  const edges = deps.filter((d) => pos.has(d.taskId) && pos.has(d.dependsOnId));

  const edgePath = (
    from: { x: number; y: number; layer: number },
    to: { x: number; y: number; layer: number },
  ) => {
    const y1 = from.y + H / 2;
    const y2 = to.y + H / 2;
    const out = from.x + W + GX / 2;
    const into = to.x - GX / 2;
    // Adjacent layers: the gap between them is empty.
    if (to.layer - from.layer <= 1) return `M${from.x + W},${y1} H${out} V${y2} H${to.x}`;
    // Skipping layers: ride the gutter above the source row (no node lives there).
    const lane = from.y - GY / 2;
    return `M${from.x + W},${y1} H${out} V${lane} H${into} V${y2} H${to.x}`;
  };

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-sunken p-4">
      <svg
        role="img"
        aria-label={`Task dependency graph: ${tasks.length} tasks, ${edges.length} dependencies`}
        viewBox={`-1 ${-1 - top} ${width} ${height}`}
        width={width}
        height={height}
        className="block text-fg"
      >
        <defs>
          <marker
            id="dag-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--fg-muted)" />
          </marker>
        </defs>
        {edges.map((d) => (
          <path
            key={d.id}
            data-edge=""
            d={edgePath(pos.get(d.dependsOnId)!, pos.get(d.taskId)!)}
            fill="none"
            stroke="var(--fg-muted)"
            strokeWidth={1.25}
            strokeLinejoin="round"
            markerEnd="url(#dag-arrow)"
          />
        ))}
        {tasks.map((t) => {
          const p = pos.get(t.id);
          if (!p) return null;
          const h = taskHeadline(t.title);
          const name = h.key ?? h.summary;
          const info = statusInfo("mimir", t.status, "task");
          const label = info?.label ?? t.status;
          const role = statusRole("mimir", t.status, "task").role;
          const selected = t.id === selectedId;
          const blocked = t.blockedReason ? describeBlockedReason(t.blockedReason) : null;
          return (
            <g
              key={t.id}
              data-task={t.id}
              transform={`translate(${p.x},${p.y})`}
              onClick={onSelect ? () => onSelect(t.id) : undefined}
              style={onSelect ? { cursor: "pointer" } : undefined}
            >
              {/* SVG has no tooltip widget: the native title carries the raw reason code. */}
              <title>{`${h.key ? `${h.key}: ` : ""}${h.summary} (${label}${blocked ? `: ${blocked.words}${blocked.known ? ` [${blocked.raw}]` : ""}` : ""})`}</title>
              <rect
                width={W}
                height={H}
                rx={8}
                fill="var(--bg-surface)"
                stroke={selected ? "var(--accent)" : "var(--border-strong)"}
                strokeWidth={selected ? 2 : 1}
              />
              <text x={12} y={21} fontSize={13} fontWeight={600} fill="currentColor">
                {clip(name, MAX_CHARS)}
              </text>
              <circle cx={16} cy={37} r={4} fill={`var(--status-${role}-fg)`} />
              <text x={26} y={41} fontSize={12} fill="var(--fg-muted)">
                {label}
                {blocked ? ` · ${clip(blocked.words, 18)}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
