import { dijkstra, extractPath, joinPaths, pathCells } from "../graph/dijkstra";
import { centreNode, nodesByCell, safeNodes, type RoadGraph } from "../graph/graph";
import { distanceMatrix, type Progress, type RouteResult } from "./common";
import { legBetween, tighten, type Leg, type Stops } from "./tighten";
import { NO_TAIL, nearestNeighbour, orOpt, twoOpt } from "./tour";

export interface VisitAllInput {
  g: RoadGraph;
  start: number;
  /** H3 cells that must all be crossed. */
  targets: string[];
  /** Finish back at the start. */
  closed: boolean;
  /** Finish at this street node instead (takes precedence over `closed`). */
  end?: number;
  onProgress?: Progress;
}

/**
 * Shortest street route that enters every chosen hexagon.
 *
 * 1. Pick a street node near the middle of each hexagon and measure road distances between them.
 * 2. Order the hexagons (nearest neighbour, then 2-opt and or-opt).
 * 3. Walk the order, but enter each hexagon at whichever of its nodes is cheapest
 *    given where you came from and where you go next, and skip hexagons the
 *    route has already passed through on the way.
 * 4. Tighten (see tighten.ts): re-pick each entry point now that both neighbours are
 *    known, and drop stops the rest of the route covers anyway.
 *
 * With an end point the order is chosen for a route that finishes there, and the last leg
 * goes to it.
 */
export function visitAll({ g, start, targets, end, onProgress, ...inp }: VisitAllInput): RouteResult {
  const closed = inp.closed && end === undefined;
  const comp = g.component[start];
  if (end !== undefined && g.component[end] !== comp) throw new Error("There's no street route between your start and end points.");
  const byCell = nodesByCell(g, comp);
  const unreachable: string[] = [];
  const cells: number[] = [];
  for (const t of new Set(targets)) {
    const c = g.cellIndex.get(t);
    if (c === undefined || !byCell.has(c)) unreachable.push(t);
    else cells.push(c);
  }

  const startCell = g.cellOf[start];
  const goals = cells.filter((c) => c !== startCell || !g.safe[start]);
  const reps = goals.map((c) => centreNode(g, c, byCell.get(c)!));
  // Matrix indexes: 0 is the start, 1..n the hexagons, and n + 1 the end point if there is one.
  const matrix = distanceMatrix(g, [start, ...reps, ...(end === undefined ? [] : [end])], onProgress);

  const tail = end !== undefined ? reps.length + 1 : closed ? 0 : NO_TAIL;
  let tour = nearestNeighbour(matrix, reps.map((_, i) => i + 1));
  tour = twoOpt(matrix, tour, tail);
  tour = orOpt(matrix, tour, tail);
  tour = twoOpt(matrix, tour, tail);
  const order = tour.slice(1).map((i) => i - 1); // indexes into goals/reps

  onProgress?.("Joining up the route", 0.9);
  const stops: Stops = { nodes: [start], cells: [startCell], pinned: [true] };
  const legs: Leg[] = [];
  const covered = new Set<number>(g.safe[start] ? [startCell] : []);
  let cur = start;
  for (let k = 0; k < order.length; k++) {
    const goal = goals[order[k]];
    if (covered.has(goal)) continue;
    let next = -1;
    for (let j = k + 1; j < order.length; j++) {
      if (!covered.has(goals[order[j]])) {
        next = reps[order[j]];
        break;
      }
    }
    if (next === -1) next = end ?? (closed ? start : -1);

    const fromCur = dijkstra(g, cur);
    const toNext = next === -1 ? null : dijkstra(g, next).dist;
    let best = -1;
    let bestCost = Infinity;
    for (const v of safeNodes(g, byCell.get(goal)!)) {
      const cost = fromCur.dist[v] + (toNext ? toNext[v] : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
    const path = extractPath(fromCur, best);
    const leg = { path, cells: pathCells(g, path) };
    legs.push(leg);
    leg.cells.forEach((c) => covered.add(c));
    covered.add(goal); // aimed at, so don't aim at it again even if it has no safe nodes
    stops.nodes.push(best);
    stops.cells.push(goal);
    // A hexagon with no street far enough inside can't count, so keep its stop regardless.
    stops.pinned.push(!byCell.get(goal)!.some((v) => g.safe[v]));
    cur = best;
  }
  if (end !== undefined) {
    legs.push(legBetween(g, cur, end));
    stops.end = end;
  } else if (closed && stops.nodes.length > 1) legs.push(legBetween(g, cur, start));

  onProgress?.("Trimming wasted distance", 0.95);
  const wanted = new Set(goals);
  const quality = (cells: Set<number>) => {
    let n = 0;
    cells.forEach((c) => wanted.has(c) && n++);
    return n;
  };
  const tight = tighten(g, stops, legs, closed, byCell, quality);
  const path = tight.legs.length ? joinPaths(tight.legs.map((l) => l.path)) : { nodes: [start], slots: [], length: 0 };
  return { path, cells: pathCells(g, path), targets: tight.stops.cells.slice(1), unreachable };
}
