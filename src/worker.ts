/// <reference lib="webworker" />
import { dijkstra } from "./graph/dijkstra";
import { buildGraph, nearestNode, type RoadGraph } from "./graph/graph";
import { fetchOsm, type BBox, type Profile } from "./graph/overpass";
import { fetchStreetTiles } from "./graph/tiles";
import type { RouteResult } from "./solve/common";
import { planRoutes } from "./solve/multi";
import { visitAll } from "./solve/visitAll";

export type WorkerRequest =
  | { id: number; type: "load"; bbox: BBox; profile: Profile; resolution: number }
  /** `end`: finish here instead (overrides `closed`). */
  | { id: number; type: "visitAll"; start: LatLng; targets: string[]; closed: boolean; end?: LatLng }
  | {
      id: number;
      type: "maxScore";
      start: LatLng;
      budget: number;
      closed: boolean;
      /** Finish here instead (overrides `closed`). */
      end?: LatLng;
      /** Points for hexagons already in play; anything else is worth `unclaimed`. */
      known: [string, number][];
      unclaimed: number;
      /** How many routes to plan; each later one goes for hexagons the earlier ones don't. */
      count?: number;
    }
  /** Shortest street distance from start to end, on the loaded streets. */
  | { id: number; type: "measure"; start: LatLng; end: LatLng };

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteMessage {
  coords: [number, number][];
  length: number;
  cells: string[];
  targets: string[];
  unreachable: string[];
}

export type WorkerResponse =
  | { id: number; type: "progress"; message: string; fraction?: number }
  | { id: number; type: "loaded"; nodes: number; segments: number; bbox: BBox }
  | { id: number; type: "route"; route: RouteMessage }
  | { id: number; type: "routes"; routes: RouteMessage[] }
  /** Metres, or null if the end can't be reached from the start. */
  | { id: number; type: "measured"; length: number | null }
  | { id: number; type: "error"; message: string };

let graph: RoadGraph | null = null;

const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

function toMessage(g: RoadGraph, r: RouteResult): RouteMessage {
  return {
    coords: r.path.nodes.map((v) => [g.lng[v], g.lat[v]]),
    length: r.path.length,
    cells: [...r.cells].map((c) => g.cellIds[c]),
    targets: r.targets.map((c) => g.cellIds[c]),
    unreachable: r.unreachable,
  };
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const progress = (message: string, fraction?: number) => post({ id: req.id, type: "progress", message, fraction });
  try {
    if (req.type === "load") {
      let osm;
      let bbox = req.bbox;
      try {
        const tiles = await fetchStreetTiles(req.bbox, req.profile, progress);
        osm = tiles.osm;
        bbox = tiles.bbox;
      } catch (e) {
        progress(`Map tiles failed (${e instanceof Error ? e.message : e}); asking OpenStreetMap directly, which can take a minute or two`);
        osm = await fetchOsm(req.bbox, req.profile);
      }
      progress(`Building the street graph (${osm.lat.length.toLocaleString()} points)`);
      graph = buildGraph(osm, req.resolution);
      post({ id: req.id, type: "loaded", nodes: graph.n, segments: graph.to.length / 2, bbox });
      return;
    }
    if (!graph || graph.n === 0) throw new Error("No street map loaded for this area.");
    const g = graph;
    const start = nearestNode(g, req.start.lat, req.start.lng);
    const end = req.end ? nearestNode(g, req.end.lat, req.end.lng) : undefined;
    if (req.type === "measure") {
      const d = dijkstra(g, start, { target: end }).dist[end!];
      post({ id: req.id, type: "measured", length: Number.isFinite(d) ? d : null });
    } else if (req.type === "visitAll") {
      const r = visitAll({ g, start, targets: req.targets, closed: req.closed, end, onProgress: progress });
      post({ id: req.id, type: "route", route: toMessage(g, r) });
    } else {
      const known = new Map(req.known);
      const values = new Float64Array(g.cellIds.length);
      g.cellIds.forEach((c, i) => (values[i] = known.get(c) ?? req.unclaimed));
      const routes = planRoutes({ g, start, budget: req.budget, closed: req.closed, end, values, count: req.count ?? 1, onProgress: progress });
      post({ id: req.id, type: "routes", routes: routes.map((r) => toMessage(g, r)) });
    }
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
