export type Position = { x: number; y: number };
export const NODE_WIDTH = 300,
  NODE_HEIGHT = 206,
  NODE_GAP = 70;
export type LayoutInput = {
  ids: string[];
  dependencies: { taskId: string; dependsOnId: string }[];
};
export function layoutGraph({ ids, dependencies }: LayoutInput) {
  const unique = [...new Set(ids)],
    included = new Set(unique),
    indegree = new Map(unique.map((id) => [id, 0])),
    children = new Map<string, string[]>(),
    levels = new Map(unique.map((id) => [id, 0]));
  const edges = new Set<string>();
  for (const edge of dependencies) {
    if (!included.has(edge.taskId) || !included.has(edge.dependsOnId)) continue;
    const key = JSON.stringify([edge.dependsOnId, edge.taskId]);
    if (edges.has(key)) continue;
    edges.add(key);
    indegree.set(edge.taskId, indegree.get(edge.taskId)! + 1);
    const list = children.get(edge.dependsOnId) ?? [];
    list.push(edge.taskId);
    children.set(edge.dependsOnId, list);
  }
  const queue = unique.filter((id) => indegree.get(id) === 0);
  for (let index = 0; index < queue.length; index++)
    for (const child of children.get(queue[index]) ?? []) {
      levels.set(
        child,
        Math.max(levels.get(child)!, levels.get(queue[index])! + 1),
      );
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  const cyclic = unique.filter((id) => indegree.get(id)! > 0);
  const used = new Map<number, number>(),
    positions: Record<string, Position> = Object.create(null);
  for (const id of unique) {
    const column = levels.get(id) ?? 0,
      row = used.get(column) ?? 0;
    used.set(column, row + 1);
    positions[id] = {
      x: 30 + column * (NODE_WIDTH + NODE_GAP),
      y: 30 + row * (NODE_HEIGHT + 50),
    };
  }
  return { positions, cyclic };
}
