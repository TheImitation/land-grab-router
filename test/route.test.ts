import * as h3 from "h3-js";
import { describe, expect, it } from "vitest";
import { dijkstra, pathCells } from "../src/graph/dijkstra";
import { haversine, MAX_PIECE } from "../src/graph/graph";
import { grid } from "./grid";
import { maxScore } from "../src/solve/maxScore";
import { visitAll } from "../src/solve/visitAll";

describe("street graph", () => {
  const { g, centre } = grid();

  it("measures grid distances as Manhattan distances", () => {
    const sp = dijkstra(g, 0);
    const far = 31 * 31 - 1;
    const expected = haversine(g.lat[0], g.lng[0], g.lat[30], g.lng[30]) + haversine(g.lat[30], g.lng[30], g.lat[far], g.lng[far]);
    expect(sp.dist[far]).toBeCloseTo(expected, -1);
  });

  it("only counts hexagons the route gets well inside", () => {
    // Independent check: sample each hexagon's edges finely and measure with haversine.
    const edgeDistance = (lat: number, lng: number, cell: string) => {
      const ring = h3.cellToBoundary(cell);
      let best = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        for (let k = 0; k <= 200; k++) {
          const f = k / 200;
          best = Math.min(best, haversine(lat, lng, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f));
        }
      }
      return best;
    };
    let safe = 0;
    for (let v = 0; v < g.n; v++) {
      const d = edgeDistance(g.lat[v], g.lng[v], g.cellIds[g.cellOf[v]]);
      if (g.safe[v]) {
        safe++;
        expect(d).toBeGreaterThan(15 - 0.5);
      } else expect(d).toBeLessThan(15 + 0.5);
    }
    expect(safe / g.n).toBeGreaterThan(0.85);
    expect(safe).toBeLessThan(g.n);
  });

  it("cuts long streets so a route can turn back almost anywhere", () => {
    let longest = 0;
    for (let k = 0; k < g.to.length; k++) longest = Math.max(longest, g.w[k]);
    expect(longest).toBeLessThanOrEqual(MAX_PIECE + 1e-6);
    // The 120 m blocks were cut into 6 pieces each, keeping the original junctions first.
    expect(g.n).toBe(31 * 31 + 2 * 31 * 30 * 5 + 2);
  });

  it("never starts on the detached island", () => {
    expect(g.component[centre]).toBe(g.component[0]);
    expect(g.componentSize[g.component[centre]]).toBe(g.n - 2); // all but the two island nodes
  });
});

describe("visitAll", () => {
  const { g, centre } = grid();
  const cellNear = (r: number, c: number) => g.cellIds[g.cellOf[r * 31 + c]];

  it("enters every chosen hexagon and comes home", () => {
    const targets = [cellNear(2, 2), cellNear(2, 28), cellNear(28, 28), cellNear(28, 2), cellNear(15, 25)];
    const r = visitAll({ g, start: centre, targets, closed: true });
    for (const t of targets) expect(r.cells.has(g.cellIndex.get(t)!)).toBe(true);
    expect(r.path.nodes[0]).toBe(centre);
    expect(r.path.nodes[r.path.nodes.length - 1]).toBe(centre);
    expect(r.unreachable).toEqual([]);
    // Four corners of a ~3.4 km square from the middle: no sensible route is longer than ~16 km.
    expect(r.path.length).toBeLessThan(16_000);
  });

  it("finishes at the end point after entering every chosen hexagon", () => {
    const targets = [cellNear(25, 5), cellNear(15, 25), cellNear(5, 10)];
    const end = 2 * 31 + 28;
    const r = visitAll({ g, start: centre, targets, closed: true, end });
    for (const t of targets) expect(r.cells.has(g.cellIndex.get(t)!)).toBe(true);
    expect(r.path.nodes[0]).toBe(centre);
    expect(r.path.nodes[r.path.nodes.length - 1]).toBe(end);
    // Ordered for the end: reaching (5, 10) last, next to the end, beats finishing on (15, 25).
    const open = visitAll({ g, start: centre, targets, closed: false });
    expect(r.path.length).toBeLessThan(open.path.length + dijkstra(g, open.path.nodes[open.path.nodes.length - 1], { target: end }).dist[end]);
  });

  it("goes straight to the end point when there's nothing to pick up", () => {
    const end = 5 * 31 + 25;
    const r = visitAll({ g, start: centre, targets: [], closed: false, end });
    expect(r.path.nodes[r.path.nodes.length - 1]).toBe(end);
    expect(r.path.length).toBeCloseTo(dijkstra(g, centre, { target: end }).dist[end], 3);
  });

  it("refuses an end point the streets don't reach", () => {
    expect(() => visitAll({ g, start: centre, targets: [cellNear(2, 2)], closed: false, end: 31 * 31 })).toThrow(/no street route/);
  });

  it("flags hexagons with no streets", () => {
    const r = visitAll({ g, start: centre, targets: ["881f1d4887fffff"], closed: false });
    expect(r.unreachable).toEqual(["881f1d4887fffff"]);
  });
});

describe("maxScore", () => {
  const { g, centre } = grid();

  it("stays within budget and scores what it crosses", () => {
    const budget = 6000;
    const r = maxScore({ g, start: centre, budget, closed: true, value: () => 1 });
    expect(r.path.length).toBeLessThanOrEqual(budget + 1e-6);
    expect(r.path.nodes[0]).toBe(centre);
    expect(r.path.nodes[r.path.nodes.length - 1]).toBe(centre);
    expect(r.score).toBe(pathCells(g, r.path).size);
  });

  it("does at least as well as a hand-drawn square loop of the same length", () => {
    const id = (r: number, c: number) => r * 31 + c;
    for (const k of [3, 6, 9]) {
      // Run north k blocks, round a square with corners k blocks out, then back.
      const loop = [] as number[];
      for (let r = 15; r >= 15 - k; r--) loop.push(id(r, 15));
      for (let c = 15 - k; c <= 15 + k; c++) loop.push(id(15 - k, c));
      for (let r = 15 - k; r <= 15 + k; r++) loop.push(id(r, 15 + k));
      for (let c = 15 + k; c >= 15 - k; c--) loop.push(id(15 + k, c));
      for (let r = 15 + k; r >= 15 - k; r--) loop.push(id(r, 15 - k));
      const square = new Set(loop.filter((v) => g.safe[v]).map((v) => g.cellOf[v]));
      const budget = 10 * k * 120;
      const r = maxScore({ g, start: centre, budget, closed: true, value: () => 1 });
      expect(r.score).toBeGreaterThanOrEqual(square.size);
      expect(r.path.length).toBeLessThanOrEqual(budget + 1e-6);
    }
  });

  it("goes out of its way for a valuable hexagon", () => {
    const prize = g.cellOf[3 * 31 + 3]; // ~1.4 km from the centre in both directions
    const r = maxScore({ g, start: centre, budget: 7000, closed: true, value: (c) => (c === prize ? 50 : 0.01) });
    expect(r.cells.has(prize)).toBe(true);
  });

  it("ignores worthless hexagons", () => {
    const r = maxScore({ g, start: centre, budget: 5000, closed: true, value: () => 0 });
    expect(r.path.length).toBe(0);
  });

  describe("with an end point", () => {
    const end = 5 * 31 + 25; // 10 blocks north-ish and 10 east: 2.4 km by street
    const direct = dijkstra(g, centre, { target: end }).dist[end];

    it("finishes at the end, within budget", () => {
      const budget = direct + 3000;
      const r = maxScore({ g, start: centre, budget, closed: true, end, value: () => 1 });
      expect(r.path.nodes[0]).toBe(centre);
      expect(r.path.nodes[r.path.nodes.length - 1]).toBe(end);
      expect(r.path.length).toBeLessThanOrEqual(budget + 1e-6);
      expect(r.score).toBe(pathCells(g, r.path).size);
    });

    it("spends extra distance on more hexagons than the direct route", () => {
      const tight = maxScore({ g, start: centre, budget: direct + 1, closed: false, end, value: () => 1 });
      const roomy = maxScore({ g, start: centre, budget: direct + 4000, closed: false, end, value: () => 1 });
      expect(tight.path.nodes[tight.path.nodes.length - 1]).toBe(end);
      expect(roomy.score).toBeGreaterThan(tight.score * 1.5);
    });

    it("still goes from start to end when nothing is worth points", () => {
      const r = maxScore({ g, start: centre, budget: direct + 2000, closed: true, end, value: () => 0 });
      expect(r.path.nodes[r.path.nodes.length - 1]).toBe(end);
      expect(r.path.length).toBeCloseTo(direct, 3);
    });

    it("refuses a budget shorter than the way to the end", () => {
      expect(() => maxScore({ g, start: centre, budget: direct - 100, closed: false, end, value: () => 1 })).toThrow(/too far/);
    });
  });
});
