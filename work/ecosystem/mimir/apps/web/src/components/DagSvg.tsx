import type { Task, TaskDependency } from "@mimir/protocol";
import { layerTasks } from "../lib/derive.js";

const W = 180;
const H = 44;
const GX = 60;
const GY = 16;

/** Layered left-to-right DAG. Status is written in each node, not shown by color alone. */
export function DagSvg({
  tasks,
  deps,
}: {
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
}) {
  const layers = layerTasks(tasks, deps);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) =>
    layer.forEach((t, ti) => pos.set(t.id, { x: li * (W + GX), y: ti * (H + GY) })),
  );
  const width = Math.max(1, layers.length) * (W + GX) - GX + 2;
  const height = Math.max(1, ...layers.map((l) => l.length)) * (H + GY) - GY + 2;
  const edges = deps.filter((d) => pos.has(d.taskId) && pos.has(d.dependsOnId));
  return (
    <svg
      role="img"
      aria-label={`Task dependency graph: ${tasks.length} tasks, ${edges.length} dependencies`}
      viewBox={`-1 -1 ${width} ${height}`}
      width={width}
      height={height}
      className="max-w-full text-zinc-900 dark:text-zinc-100"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>
      {edges.map((d) => {
        const from = pos.get(d.dependsOnId) as { x: number; y: number };
        const to = pos.get(d.taskId) as { x: number; y: number };
        return (
          <line
            key={d.id}
            x1={from.x + W}
            y1={from.y + H / 2}
            x2={to.x}
            y2={to.y + H / 2}
            stroke="currentColor"
            markerEnd="url(#arrow)"
          />
        );
      })}
      {tasks.map((t) => {
        const p = pos.get(t.id);
        if (!p) return null;
        return (
          <g key={t.id} transform={`translate(${p.x},${p.y})`}>
            <rect width={W} height={H} rx={4} fill="none" stroke="currentColor" />
            <text x={8} y={18} fontSize={13} fill="currentColor">
              {t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title}
            </text>
            <text x={8} y={35} fontSize={11} fill="currentColor">
              {t.status}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
