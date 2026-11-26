import type { Commit } from './git';

/** A line inside one row. x = lane (column) index; y = 0 top edge, 0.5 the node's centre, 1 bottom edge. `color` is a palette index. */
export interface Line { x1: number; y1: number; x2: number; y2: number; color: number }
/** One row of the graph: the node's lane and colour, the row's lines, and how many lanes wide the row is. */
export interface GraphRow { col: number; color: number; lines: Line[]; width: number }
/** What carries over to the next page: each lane's awaited commit (null = free) and the next new line's colour. */
export interface Lanes { lanes: ({ hash: string; color: number } | null)[]; nextColor: number }

/**
 * Lays out commits (in `--topo-order`, newest first) in lanes. Pure: pass the returned `state` with the next page to continue.
 * A line keeps its lane and colour from the child where it starts to the parent where it ends; lanes never shift, freed ones are reused.
 */
export function graph(commits: Pick<Commit, 'hash' | 'parents'>[], state: Lanes = { lanes: [], nextColor: 0 }): { rows: GraphRow[]; state: Lanes } {
  const lanes = [...state.lanes];
  let nextColor = state.nextColor;
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  const rows = commits.map((c): GraphRow => {
    const lines: Line[] = [];
    const found = lanes.findIndex((l) => l?.hash === c.hash);
    const col = found < 0 ? free() : found; // not found: a branch tip, nothing above leads here
    const color = found < 0 ? nextColor++ : lanes[col]!.color;
    // Top half: lines arriving at this node end here; every other lane passes straight through.
    lanes.forEach((l, i) => {
      if (!l) return;
      if (l.hash !== c.hash) lines.push({ x1: i, y1: 0, x2: i, y2: 1, color: l.color });
      else {
        lines.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: l.color });
        lanes[i] = null;
      }
    });
    // Bottom half: the first parent continues this lane (same colour); other parents join a lane awaiting them or open a new one.
    c.parents.forEach((p, k) => {
      const at = k === 0 ? -1 : lanes.findIndex((l) => l?.hash === p);
      const i = k === 0 ? col : at >= 0 ? at : free();
      if (k === 0 || at < 0) lanes[i] = { hash: p, color: k === 0 ? color : nextColor++ };
      lines.push({ x1: col, y1: 0.5, x2: i, y2: 1, color: lanes[i]!.color });
    });
    while (lanes.length && !lanes.at(-1)) lanes.pop();
    return { col, color, lines, width: Math.max(col + 1, ...lines.map((l) => Math.max(l.x1, l.x2) + 1)) };
  });
  return { rows, state: { lanes: [...lanes], nextColor } };
}
