import { Card, Button, ScrollArea, Disclosure, DisclosureTrigger } from "../components/ui";
import { useEffect, useRef, useState } from "react";
type R = Record<string, any>;
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  NODE_GAP,
  type Position,
} from "../workers/layout";
import { useGraphLayout } from "../workers/useGraphLayout";
export function Graph({
  mission,
  title,
  tasks,
  dependencies,
  saved,
  onSave,
  onInspect,
}: {
  mission: R;
  title?: string;
  tasks: R[];
  dependencies: R[];
  saved?: Record<string, Position>;
  onSave: (p: Record<string, Position>) => void;
  onInspect: (t: R) => void;
}) {
  const computed = useGraphLayout({
    ids: tasks.map((t) => t.id),
    dependencies: dependencies.map((d) => ({
      taskId: d.taskId,
      dependsOnId: d.dependsOnId,
    })),
  });
  const automatic = computed?.layout.positions ?? {};
  const [positions, setPositions] = useState<Record<string, Position>>(
      saved ?? {},
    ),
    [zoom, setZoom] = useState(1);
  const suppressClick = useRef(false);
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    origin: Position;
    moved: boolean;
  } | null>(null);
  useEffect(() => setPositions(saved ?? {}), [mission.id]);
  const pos = (id: string) => positions[id] ?? automatic[id] ?? { x: 0, y: 0 };
  const width = Math.max(
      900,
      ...tasks.map((t) => pos(t.id).x + NODE_WIDTH + 30),
    ),
    height = Math.max(350, ...tasks.map((t) => pos(t.id).y + NODE_HEIGHT + 34));
  function move(id: string, p: Position) {
    setPositions((old) => ({
      ...old,
      [id]: { x: Math.max(0, p.x), y: Math.max(0, p.y) },
    }));
  }
  return (
    <Card className="panel">
      <div className="section-title graph-heading">
        <h2 title={mission.objective}>{title ?? mission.objective}</h2>
        <div className="graph-tools">
          <Button
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}
          >
            −
          </Button>
          <span>{Math.round(zoom * 100)}%</span>
          <Button
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
          >
            +
          </Button>
          <Button
            onClick={() => {
              setPositions({});
              setZoom(1);
              onSave({});
            }}
          >
            Auto layout
          </Button>
          <Button onClick={() => onSave(positions)}>Save layout</Button>
        </div>
      </div>
      <p className="muted">
        Drag nodes to arrange. Use Alt + arrow keys to move a focused node;
        Enter opens details. Scroll to pan. Layout changes never change task
        dependencies.
      </p>
      {!computed && (
        <p role="status" className="muted">
          Arranging dependencies…
        </p>
      )}
      {computed?.layout.cyclic.length ? (
        <p role="status" className="warning">
          Source dependencies contain a cycle. Inspect the dependency list
          before proceeding.
        </p>
      ) : null}
      <ScrollArea
        className="graph-viewport"
        role="region"
        aria-label="Interactive dependency graph"
        tabIndex={0}
      >
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div
            className="graph-canvas"
            style={{
              width,
              height,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
            }}
          >
            <svg width={width} height={height} aria-hidden="true">
              <defs>
                <marker
                  id={"arrow-" + mission.id}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {dependencies
                .filter(
                  (d) =>
                    tasks.some((t) => t.id === d.taskId) &&
                    tasks.some((t) => t.id === d.dependsOnId),
                )
                .map((d) => {
                  const a = pos(d.dependsOnId),
                    b = pos(d.taskId);
                  return (
                    <path
                      key={d.id}
                      d={`M ${a.x + NODE_WIDTH} ${a.y + NODE_HEIGHT / 2} C ${a.x + NODE_WIDTH + NODE_GAP / 2} ${a.y + NODE_HEIGHT / 2}, ${b.x - 25} ${b.y + NODE_HEIGHT / 2}, ${b.x} ${b.y + NODE_HEIGHT / 2}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      markerEnd={`url(#arrow-${mission.id})`}
                    />
                  );
                })}
            </svg>
            {(computed ? tasks : []).map((t) => (
              <Button
                variant="unstyled"
                key={t.id}
                className={"graph-node " + t.status}
                style={{
                  left: pos(t.id).x,
                  top: pos(t.id).y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
                aria-label={t.title + " · " + t.status}
                onClick={() => {
                  if (!suppressClick.current) onInspect(t);
                }}
                onPointerDown={(e) => {
                  suppressClick.current = false;
                  drag.current = {
                    id: t.id,
                    x: e.clientX,
                    y: e.clientY,
                    origin: pos(t.id),
                    moved: false,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.id !== t.id) return;
                  const dx = (e.clientX - d.x) / zoom,
                    dy = (e.clientY - d.y) / zoom;
                  if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
                  if (d.moved)
                    move(t.id, { x: d.origin.x + dx, y: d.origin.y + dy });
                }}
                onPointerUp={() => {
                  suppressClick.current = !!drag.current?.moved;
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  if (
                    e.altKey &&
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(e.key)
                  ) {
                    e.preventDefault();
                    const p = pos(t.id);
                    move(t.id, {
                      x:
                        p.x +
                        (e.key === "ArrowLeft"
                          ? -20
                          : e.key === "ArrowRight"
                            ? 20
                            : 0),
                      y:
                        p.y +
                        (e.key === "ArrowUp"
                          ? -20
                          : e.key === "ArrowDown"
                            ? 20
                            : 0),
                    });
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onInspect(t);
                  }
                }}
              >
                <small title={t.id}>
                  {t.title?.includes(":")
                    ? t.title.split(":")[0].replaceAll("-", " ")
                    : "Task"}{" "}
                  · {t.id.slice(-8)}
                </small>
                <strong title={t.title}>{t.title}</strong>
                <span
                  className={
                    "badge " +
                    (t.status === "completed"
                      ? "green"
                      : t.status === "running"
                        ? "blue"
                        : "")
                  }
                >
                  {t.status}
                </span>
                {t.blockedReason && (
                  <small className="block-reason" title={t.blockedReason}>
                    {t.blockedReason}
                  </small>
                )}
              </Button>
            ))}
          </div>
        </div>
      </ScrollArea>
      <Disclosure>
        <DisclosureTrigger>Accessible dependency list</DisclosureTrigger>
        {tasks.map((t) => (
          <p key={t.id}>
            <Button onClick={() => onInspect(t)}>{t.title}</Button> — {t.status}
            ; requires:{" "}
            {dependencies
              .filter((d) => d.taskId === t.id)
              .map(
                (d) =>
                  tasks.find((t) => t.id === d.dependsOnId)?.title ??
                  d.dependsOnId,
              )
              .join("; ") || "none"}
          </p>
        ))}
      </Disclosure>
    </Card>
  );
}
