import { describe, expect, it } from 'vitest';
import { graph } from './graph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const line = (x1: number, y1: number, x2: number, y2: number, color: number) => ({ x1, y1, x2, y2, color });
const pass = (x: number, color: number) => line(x, 0, x, 1, color);
const into = (from: number, to: number, color: number) => line(from, 0, to, 0.5, color); // top half, into the node
const out = (from: number, to: number, color: number) => line(from, 0.5, to, 1, color); // bottom half, out of the node

describe('graph', () => {
  it('linear history: one lane, one colour', () => {
    const { rows, state } = graph([c('C', 'B'), c('B', 'A'), c('A')]);
    expect(rows).toEqual([
      { col: 0, color: 0, width: 1, lines: [out(0, 0, 0)] },
      { col: 0, color: 0, width: 1, lines: [into(0, 0, 0), out(0, 0, 0)] },
      { col: 0, color: 0, width: 1, lines: [into(0, 0, 0)] },
    ]);
    expect(state).toEqual({ lanes: [], nextColor: 1 });
  });

  const branchMerge = [c('M', 'B', 'F'), c('B', 'A'), c('F', 'A'), c('A')];
  const branchMergeRows = [
    { col: 0, color: 0, width: 2, lines: [out(0, 0, 0), out(0, 1, 1)] }, // merge opens lane 1 for F
    { col: 0, color: 0, width: 2, lines: [into(0, 0, 0), pass(1, 1), out(0, 0, 0)] },
    { col: 1, color: 1, width: 2, lines: [pass(0, 0), into(1, 1, 1), out(1, 1, 1)] }, // F keeps lane 1's colour
    { col: 0, color: 0, width: 2, lines: [into(0, 0, 0), into(1, 0, 1)] }, // both lines end at the fork point
  ];

  it('branch + merge: the side branch gets its own lane and colour until it ends at the fork point', () => {
    const { rows, state } = graph(branchMerge);
    expect(rows).toEqual(branchMergeRows);
    expect(state).toEqual({ lanes: [], nextColor: 2 });
  });

  it('crossing branches: a merge joins a lane on the far side, crossing the lane between', () => {
    const { rows } = graph([c('X', 'P'), c('Y', 'Q'), c('Z', 'R', 'P'), c('Q', 'R'), c('P', 'R'), c('R')]);
    expect(rows.map((r) => [r.col, r.color])).toEqual([[0, 0], [1, 1], [2, 2], [1, 1], [0, 0], [0, 0]]);
    // Z's second parent P is already awaited in lane 0: the connector keeps lane 0's colour and crosses lane 1.
    expect(rows[2]!.lines).toEqual([pass(0, 0), pass(1, 1), out(2, 2, 2), out(2, 0, 0)]);
    expect(rows[3]!.lines).toEqual([pass(0, 0), into(1, 1, 1), pass(2, 2), out(1, 1, 1)]);
    expect(rows[5]!.lines).toEqual([into(0, 0, 0), into(1, 0, 1), into(2, 0, 2)]);
    expect(rows.map((r) => r.width)).toEqual([1, 2, 3, 3, 3, 3]);
  });

  it('octopus merge: one new lane and colour per extra parent', () => {
    const { rows, state } = graph([c('M', 'A', 'B', 'C'), c('A', 'R'), c('B', 'R'), c('C', 'R'), c('R')]);
    expect(rows[0]).toEqual({ col: 0, color: 0, width: 3, lines: [out(0, 0, 0), out(0, 1, 1), out(0, 2, 2)] });
    expect(rows.map((r) => [r.col, r.color])).toEqual([[0, 0], [0, 0], [1, 1], [2, 2], [0, 0]]);
    expect(rows[4]!.lines).toEqual([into(0, 0, 0), into(1, 0, 1), into(2, 0, 2)]);
    expect(state.lanes).toEqual([]);
  });

  it('a freed lane is reused by the next branch tip, with a new colour', () => {
    const { rows } = graph([c('M', 'B', 'F'), c('F', 'B'), c('B', 'A'), c('T', 'A'), c('A')]);
    expect(rows[3]).toMatchObject({ col: 1, color: 2 }); // lane 1 ended at B; tip T takes it
    expect(rows[3]!.lines).toEqual([pass(0, 0), out(1, 1, 2)]);
  });

  it('a branch split across a page boundary continues in the same lane and colour', () => {
    const first = graph(branchMerge.slice(0, 2));
    expect(first.state).toEqual({ lanes: [{ hash: 'A', color: 0 }, { hash: 'F', color: 1 }], nextColor: 2 });
    const saved = structuredClone(first.state);
    const second = graph(branchMerge.slice(2), first.state);
    expect([...first.rows, ...second.rows]).toEqual(branchMergeRows);
    expect(first.state).toEqual(saved); // pure: the carried state isn't mutated
  });
});
