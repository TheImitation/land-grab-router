import { cellToBoundary, cellToLatLng, latLngToCell } from "h3-js";
import { bookmarkletHref, receiveImport } from "./bookmarklet";
import { clampKm, floorKm, formatKm, MAX_KM, MIN_KM, parseKm, stepKm } from "./budget";
import { makeDemo } from "./data/demo";
import { crossedByMe, type SkipMine } from "./data/mine";
import { parseLandGrab } from "./data/decode";
import { lead, replay, runnerUp } from "./data/replay";
import type { Dataset, GameState } from "./data/types";
import { toGpx } from "./gpx";
import { haversine, MARGIN } from "./graph/graph";
import { bboxAround, bboxContains, bboxForTrip, bboxUnion, type BBox, type Profile } from "./graph/overpass";
import { depthInCell, distanceToRoute } from "./live";
import { OUTCOME_COLOURS, PlannerMap, type HexProps, type LiveState } from "./map";
import { crash } from "./crash";
import { DEFAULT_WEIGHTS, assess, projectRun, valueTable, type HexPlan, type Outcome, type Weights } from "./scoring";
import { Sheet } from "./sheet";
import "./style.css";
import { checkTeam } from "./team";
import type { RouteMessage, WorkerRequest, WorkerResponse } from "./worker";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DATA_KEY = "lgr-data-v1";
const SETTINGS_KEY = "lgr-settings-v1";
/** Largest street download, metres from the start in each direction. */
const MAX_RADIUS = 5000;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Where a route finishes: back at the start, at an end point you place, or wherever it ends up. */
type Finish = "start" | "end" | "anywhere";
/** What clicking the map does on a desktop. */
type Tool = "start" | "end" | "select";

interface Settings {
  mode: "max" | "visit";
  budgetKm: number;
  finish: Finish;
  profile: Profile;
  weights: Weights;
  view: "teams" | "plan";
  /** Leave hexagons you've already crossed out of new routes. */
  skipMine: SkipMine;
  /** Routes to plan in one go (most points mode). */
  routeCount: number;
}

function loadSettings(): Settings {
  const base: Settings = { mode: "max", budgetKm: 8, finish: "start", profile: "foot", weights: { ...DEFAULT_WEIGHTS }, view: "teams", skipMine: "week", routeCount: 1 };
  try {
    // Older versions had a "Finish where I start" tick box, saved as `closed`.
    const { closed, ...saved } = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const merged: Settings = { ...base, ...saved, weights: { ...base.weights, ...saved.weights } };
    if (!["start", "end", "anywhere"].includes(saved.finish)) merged.finish = closed === false ? "anywhere" : "start";
    return merged;
  } catch {
    return base;
  }
}
const settings = loadSettings();
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
};

const state = {
  ds: null as Dataset | null,
  game: null as GameState | null,
  plans: new Map<string, HexPlan>(),
  team: 0,
  tool: (settings.finish === "end" ? "end" : "start") as Tool,
  start: null as { lat: number; lng: number } | null,
  /** Where the route should finish, when the finish is an end point. */
  end: null as { lat: number; lng: number } | null,
  /** Shortest distance (km) that still reaches the end point; the budget can't go below it. */
  floorKm: MIN_KM,
  selected: new Set<string>(),
  graph: null as { bbox: BBox; profile: Profile; resolution: number } | null,
  /** The route in focus: the one live location follows and the map frames. */
  route: null as RouteMessage | null,
  /** Every route from the last plan, in the order they were planned. */
  routes: [] as RouteMessage[],
  /** Which of them are ticked to show (and count together). */
  picked: new Set<number>(),
  focus: 0,
  hover: null as string | null,
  busy: false,
  /** Hexagons you've crossed that routes are skipping (per the skipMine setting). */
  mine: new Set<string>(),
  /** Every hexagon you've crossed this week, for the hexagon details. */
  mineWeek: new Set<string>(),
};

/** The route's hexagons that count: all of them, less any you're skipping because you've crossed them. */
function countable(cells: string[]) {
  return cells.filter((c) => !state.mine.has(c));
}

const ROUTE_COLOURS = ["#38f2ff", "#b18cff", "#ff8a3d", "#4dffb8", "#ffe14d"];
const routeColour = (i: number) => ROUTE_COLOURS[i % ROUTE_COLOURS.length];

/** The ticked routes, in plan order, with their plan numbers. */
function shownRoutes() {
  return state.routes.map((route, i) => ({ route, i })).filter(({ i }) => state.picked.has(i));
}

/** What the ticked routes would do between them. A hexagon counts once however many cross it. */
function together() {
  const shown = shownRoutes();
  const all = [...new Set(shown.flatMap(({ route }) => route.cells))];
  const cells = countable(all);
  return {
    shown,
    all,
    skipped: all.length - cells.length,
    length: shown.reduce((s, { route }) => s + route.length, 0),
    proj: state.game ? projectRun(state.game, state.team, cells, settings.weights) : null,
  };
}

function setRoutes(routes: RouteMessage[]) {
  state.routes = routes;
  state.picked = new Set(routes.map((_, i) => i));
  state.focus = 0;
  state.route = routes[0] ?? null;
  renderRoute();
}

function focusRoute(i: number) {
  if (!state.routes[i]) return;
  state.focus = i;
  state.picked.add(i);
  state.route = state.routes[i];
  renderRoute();
  pmap.fitCoords(state.route.coords, 14, fitPadding());
}

interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Degrees clockwise from north, or null when standing still. */
  heading: number | null;
  at: number;
}

/** Live location: off, following you, or on but left where you panned to. */
const live = {
  state: "off" as LiveState,
  watch: null as number | null,
  fix: null as Fix | null,
  /** Route hexagons you've been far enough inside to count, this session. */
  reached: new Set<string>(),
  routeFor: null as RouteMessage | null,
  routeCells: new Set<string>(),
  wake: null as WakeLockSentinel | null,
  timer: 0,
  error: "",
};

// ---------- worker ----------
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
const waiting = new Map<number, { resolve: (r: WorkerResponse) => void; progress: (m: string) => void }>();
worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const msg = ev.data;
  const w = waiting.get(msg.id);
  if (!w) return;
  if (msg.type === "progress") return w.progress(msg.message);
  waiting.delete(msg.id);
  w.resolve(msg);
};
function ask(req: WorkerRequest, progress: (m: string) => void): Promise<WorkerResponse> {
  req.id = nextId++;
  return new Promise((resolve) => {
    waiting.set(req.id, { resolve, progress });
    worker.postMessage(req);
  });
}

// ---------- map ----------
const pmap = new PlannerMap($("map"), [-0.1276, 51.5072]);

// ---------- phone layout ----------
const sheet = new Sheet($("panel"), $("sheet-head"), $("sheet-summary"), (s) => {
  if (s === "peek") return;
  hideHexCard();
  // With a route planned, opening the sheet goes straight to its results.
  const result = document.getElementById("result");
  if (state.route && result && !result.hidden) {
    const panel = $("panel");
    panel.scrollTo({ top: result.offsetTop - $("sheet-head").offsetHeight - 8 });
  }
});
/** Touch screens get tap-to-inspect instead of hover, and tapping doesn't move the start. */
const touchUI = () => matchMedia("(hover: none)").matches;
/** Room to leave around a route so it isn't hidden under the sheet or the map buttons. */
const fitPadding = () => (sheet.active ? { top: 70, bottom: sheet.covered() + 24, left: 24, right: 24 } : 60);
let progressText = "";
let progressError = false;

/** The always-visible summary at the top of the phone sheet. */
function renderSheetHead() {
  const title = document.getElementById("sheet-title");
  const sub = document.getElementById("sheet-sub");
  const button = document.getElementById("sheet-plan") as HTMLButtonElement | null;
  if (!title || !sub || !button) return;
  const r = state.route;
  const t = r && state.game ? together() : null;
  if (r && t?.proj) {
    const proj = t.proj;
    const km = t.length / 1000;
    const taken = proj.counts.claim + proj.counts.steal;
    const n = t.shown.length;
    title.textContent = `${n > 1 ? `${n} routes · ` : ""}${km.toFixed(km < 10 ? 2 : 1)} km · ${proj.points.toFixed(1)} points`;
    sub.textContent = progressText || `${taken} ${taken === 1 ? "hexagon" : "hexagons"} taken${proj.counts.steal ? `, ${proj.counts.steal} from rivals` : ""} · tap for details`;
  } else if (state.ds) {
    const toEnd = endWanted() ? " to your end" : "";
    title.textContent =
      settings.mode === "max" ? `${formatKm(settings.budgetKm)} km for most points${toEnd}` : `Through ${state.selected.size} ${state.selected.size === 1 ? "hexagon" : "hexagons"}${toEnd}`;
    sub.textContent =
      progressText || (settings.mode === "visit" && !state.selected.size ? "Tap hexagons on the map to pick them" : "Tap a hexagon to look, or Plan");
  } else {
    title.textContent = "Land Grab Router";
    sub.textContent = progressText || "Tap here to load your data";
  }
  sub.classList.toggle("error", progressError && !!progressText);
  button.disabled = state.busy || !state.ds;
  button.textContent = state.busy ? "Planning…" : r ? "Re-plan" : "Plan";
}

// ---------- helpers ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const swatch = (colour: string) => `<span class="swatch" style="background:${colour}"></span>`;
const teamName = (i: number) => esc(state.ds?.teams[i]?.name ?? "Nobody");
const teamColour = (i: number) => state.ds?.teams[i]?.colour ?? "#555";
const when = (minutes: number) => `${DAYS[Math.min(6, Math.floor(minutes / 1440))]} ${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function setProgress(text: string, isError = false) {
  const el = document.getElementById("progress");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
  progressText = text;
  progressError = isError;
  renderSheetHead();
}

function setPressed(group: string, attr: string, value: string) {
  $(group)
    .querySelectorAll<HTMLButtonElement>(`button[${attr}]`)
    .forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)));
}

function strength(p: HexPlan): number {
  switch (p.outcome) {
    case "steal":
    case "claim":
      return 1;
    case "defend":
      return p.crossingsNeeded === 1 ? 1 : 0.6;
    case "siege":
      return Math.max(0.25, 0.8 / Math.max(1, (p.crossingsNeeded ?? 2) - 1));
    case "secure":
      return 0.6;
  }
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  claim: "Unclaimed, yours if you cross it",
  steal: "One crossing takes it off a rival",
  defend: "Yours, but at risk",
  siege: "Rival's, one more run gets you closer",
  secure: "Yours and safe",
};

// ---------- data ----------
function loadData(raw: unknown, persist: boolean) {
  try {
    const ds = parseLandGrab(raw);
    const verdict = checkTeam(ds);
    if (!verdict.ok) {
      // Another team's data: don't keep it, and take the planner down with it.
      try {
        localStorage.removeItem(DATA_KEY);
      } catch {
        /* ignore */
      }
      crash(verdict.theirTeam, () => {
        worker.terminate();
        pmap.map.remove();
      });
      return;
    }
    state.ds = ds;
    state.game = replay(ds);
    // Always plan for our team, whoever is holding the data.
    state.team = verdict.team;
    state.route = null;
    state.routes = [];
    state.picked.clear();
    state.selected.clear();
    if (persist) {
      try {
        localStorage.setItem(DATA_KEY, typeof raw === "string" ? raw : JSON.stringify(raw));
      } catch {
        /* too big or private mode: fine, it just won't survive a reload */
      }
    }
    pmap.setResolution(ds.resolution);
    pmap.setTeamColours(ds.teams.map((t) => t.colour));

    const home = ds.regions[ds.yourRegion] ?? ds.regions[0];
    const centre = home ? { lat: home.lat, lng: home.lng } : hexCentre(state.game);
    const farFromPlay = !state.start || !centre || haversine(state.start.lat, state.start.lng, centre.lat, centre.lng) > 20_000;
    if (farFromPlay && centre) {
      clearEnd();
      setStart(centre.lat, centre.lng);
    }
    if (sheet.active) sheet.set("peek");
    if (home?.bounds) pmap.fitBounds(home.bounds, fitPadding());
    else if (centre) pmap.map.flyTo({ center: [centre.lng, centre.lat], zoom: 12 });

    const acts = ds.activities.length;
    $("data-status").textContent = `${ds.teams.length} teams · ${state.game.hexes.size} hexagons held · ${acts} ${acts === 1 ? "activity" : "activities"} this week`;
    $("data-status").classList.remove("error");
    renderTeams();
    refreshHexes();
    renderSelected();
    renderRoute();
    renderSheetHead();
  } catch (e) {
    $("data-status").textContent = e instanceof Error ? e.message : String(e);
    $("data-status").classList.add("error");
  }
}

function hexCentre(game: GameState): { lat: number; lng: number } | null {
  const cells = [...game.hexes.keys()].slice(0, 200);
  if (!cells.length) return null;
  let lat = 0;
  let lng = 0;
  for (const c of cells) {
    const [a, b] = cellToLatLng(c);
    lat += a;
    lng += b;
  }
  return { lat: lat / cells.length, lng: lng / cells.length };
}

function renderTeams() {
  const ds = state.ds;
  const game = state.game;
  if (!ds || !game) return;
  $("team-name").innerHTML = `${swatch(ds.teams[state.team].colour)} ${esc(ds.teams[state.team].name)}`;
  $("team-field").hidden = false;
  const order = ds.teams.map((_, i) => i).sort((a, b) => game.held[b] - game.held[a]);
  $("standings").innerHTML = order
    .map((i) => `<li>${swatch(ds.teams[i].colour)}<span>${esc(ds.teams[i].name)}</span>${i === state.team ? '<span class="you">You</span>' : ""}<span class="n">${game.held[i]}</span></li>`)
    .join("");
}

function refreshHexes() {
  const game = state.game;
  if (!game) return;
  state.plans = valueTable(game, state.team, settings.weights);
  if (state.ds) {
    state.mine = crossedByMe(state.ds, settings.skipMine);
    state.mineWeek = crossedByMe(state.ds, "week");
  }
  const hexes: HexProps[] = [];
  game.hexes.forEach((h) => {
    const p = state.plans.get(h.cell)!;
    const r = runnerUp(h);
    const level = r !== -1 && h.visits[r] === h.visits[h.holder] ? r : undefined;
    // Skipped hexagons fade right back in the Opportunities view: they're worth nothing to you.
    const s = state.mine.has(h.cell) ? 0.14 : strength(p);
    hexes.push({ cell: h.cell, team: h.holder, opacity: 0.28 + 0.2 * Math.min(lead(h), 3), outcome: p.outcome, strength: s, level });
  });
  pmap.setHexes(hexes);
  pmap.setMine(state.mine);
  renderSkipHint();
  renderLegend();
  renderHex(state.hover);
}

function renderLegend() {
  const el = $("legend");
  if (!state.ds) {
    el.innerHTML = "";
    return;
  }
  if (settings.view === "teams") {
    el.innerHTML =
      state.ds.teams.map((t) => `<div>${swatch(t.colour)}${esc(t.name)}</div>`).join("") +
      `<div class="muted"><span class="dot-key"></span>Dot: a rival is level</div>` +
      (state.mine.size ? `<div class="muted"><span class="mine-key"></span>Dashed: you've crossed it, skipped</div>` : "");
  } else {
    const keys: Outcome[] = ["steal", "defend", "siege", "secure"];
    el.innerHTML =
      keys.map((k) => `<div>${swatch(OUTCOME_COLOURS[k])}${OUTCOME_LABELS[k]}</div>`).join("") +
      (state.mine.size ? `<div><span class="mine-key"></span>You've crossed it, so routes skip it</div>` : "") +
      `<div class="muted">Blank ground is unclaimed and worth taking too</div>`;
  }
}

/** Who holds a hexagon and what your next run would do to it, as HTML. */
function hexSummary(cell: string): string {
  if (!state.game || !state.ds) return `<p class="muted">Load your data to see who holds this hexagon.</p>`;
  const p = assess(state.game, state.team, cell, settings.weights);
  const h = state.game.hexes.get(cell);
  const picked = state.selected.has(cell) ? " · picked" : "";
  if (!h) {
    return `<b>Unclaimed</b>${picked}<p class="muted">Nobody has crossed it this week. Crossing it takes it: <b>${p.value.toFixed(2)}</b> points.</p>`;
  }
  const visits = h.visits
    .map((v, t) => (v ? `<li><span>${swatch(teamColour(t))} ${teamName(t)}</span><span>${v} ${v === 1 ? "crossing" : "crossings"}</span></li>` : ""))
    .join("");
  const r = runnerUp(h);
  const level = r !== -1 && h.visits[r] === h.visits[h.holder] ? ` <span class="muted">(${teamName(r)} is level)</span>` : "";
  const detail =
    p.outcome === "siege"
      ? `You need ${p.crossingsNeeded} crossings to take it.`
      : p.outcome === "defend"
        ? `A rival needs ${p.crossingsNeeded} ${p.crossingsNeeded === 1 ? "crossing" : "crossings"} to take it.`
        : "";
  const yours = state.mine.has(cell)
    ? `<div class="mine-note">You've crossed it ${settings.skipMine === "today" ? "today" : "this week"}, so routes skip it.</div>`
    : state.mineWeek.has(cell)
      ? `<div class="muted">You crossed it earlier this week.</div>`
      : "";
  return `<div>${swatch(teamColour(h.holder))} Held by <b>${teamName(h.holder)}</b>${level}${picked}</div>
    <ul>${visits}</ul>
    <div class="muted">Last crossed ${when(h.lastCrossedAt)}</div>${yours}
    <p><span class="swatch" style="background:${OUTCOME_COLOURS[p.outcome]}"></span> ${OUTCOME_LABELS[p.outcome]}. ${detail} Worth <b>${p.value.toFixed(2)}</b> points on your next run.</p>`;
}

function renderHex(cell: string | null) {
  const el = document.getElementById("hex-detail");
  if (!el) return;
  if (!cell || !state.game || !state.ds) {
    el.innerHTML = !state.ds ? "Load game data to inspect hexagons." : touchUI() ? "Tap a hexagon on the map to inspect it." : "Point at the map to inspect a hexagon.";
    return;
  }
  el.innerHTML = hexSummary(cell);
}

/** Touch screens: tapping the map shows the hexagon in a card above the sheet, with a button to start there. */
function showHexCard(cell: string, lat: number, lng: number) {
  const card = $("hex-card");
  card.innerHTML = `<button type="button" class="hex-card-close" aria-label="Close">×</button>${hexSummary(cell)}
    <div class="actions"><button type="button" class="primary" data-act="start">Start here</button>${
      endWanted() ? '<button type="button" data-act="end">End here</button>' : ""
    }</div>`;
  card.querySelector(".hex-card-close")!.addEventListener("click", hideHexCard);
  card.querySelector('[data-act="start"]')!.addEventListener("click", () => {
    setStart(lat, lng);
    hideHexCard();
  });
  card.querySelector('[data-act="end"]')?.addEventListener("click", () => {
    setEnd(lat, lng);
    hideHexCard();
  });
  card.hidden = false;
  pmap.setHover(cell);
}

function hideHexCard() {
  const card = document.getElementById("hex-card");
  if (card) card.hidden = true;
  pmap.setHover(null);
}

// ---------- start / selection ----------
function setStart(lat: number, lng: number) {
  state.start = { lat, lng };
  pmap.setStart(lat, lng);
  void updateFloor();
}
pmap.onStartDragged((lat, lng) => setStart(lat, lng));

const endWanted = () => settings.finish === "end";

function setEnd(lat: number, lng: number) {
  state.end = { lat, lng };
  applyFinish();
}
function clearEnd() {
  state.end = null;
  applyFinish();
}
pmap.onEndDragged((lat, lng) => setEnd(lat, lng));

function renderSelected() {
  pmap.setSelected(state.selected);
  const n = state.selected.size;
  $("selected-count").textContent = `${n} ${n === 1 ? "hexagon" : "hexagons"} picked`;
  renderSheetHead();
}

pmap.map.on("click", (e) => {
  const cell = pmap.cellAt(e.lngLat.lat, e.lngLat.lng);
  if (state.tool === "select") {
    if (state.selected.has(cell)) state.selected.delete(cell);
    else state.selected.add(cell);
    renderSelected();
    renderHex(cell);
  } else if (touchUI()) {
    showHexCard(cell, e.lngLat.lat, e.lngLat.lng);
  } else if (state.tool === "end") {
    // One click places the end; after that clicks go back to what they usually do.
    state.tool = settings.mode === "visit" ? "select" : "start";
    setEnd(e.lngLat.lat, e.lngLat.lng);
  } else {
    setStart(e.lngLat.lat, e.lngLat.lng);
  }
});

pmap.map.on("mousemove", (e) => {
  if (pmap.map.getZoom() < 9) return;
  const cell = pmap.cellAt(e.lngLat.lat, e.lngLat.lng);
  if (cell === state.hover) return;
  state.hover = cell;
  pmap.setHover(cell);
  renderHex(cell);
});
pmap.map.getCanvas().addEventListener("mouseleave", () => {
  state.hover = null;
  pmap.setHover(null);
});

// ---------- planning ----------
function bboxForVisit(): BBox {
  const s = state.start!;
  let b: BBox = [s.lng, s.lat, s.lng, s.lat];
  const e = endWanted() ? state.end : null;
  if (e) b = [Math.min(b[0], e.lng), Math.min(b[1], e.lat), Math.max(b[2], e.lng), Math.max(b[3], e.lat)];
  for (const c of state.selected) {
    for (const [lng, lat] of cellToBoundary(c, true)) b = [Math.min(b[0], lng), Math.min(b[1], lat), Math.max(b[2], lng), Math.max(b[3], lat)];
  }
  const pad = bboxAround((b[1] + b[3]) / 2, (b[0] + b[2]) / 2, 700);
  const dLng = (pad[2] - pad[0]) / 2;
  const dLat = (pad[3] - pad[1]) / 2;
  return [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
}

function areaKm2(b: BBox) {
  const mid = (b[1] + b[3]) / 2;
  return (haversine(mid, b[0], mid, b[2]) * haversine(b[1], b[0], b[3], b[0])) / 1e6;
}

async function plan() {
  if (state.busy) return;
  const ds = state.ds;
  if (!ds || !state.game) return setProgress("Load game data first, or try the demo.", true);
  if (!state.start) return setProgress("Click the map to set a start point.", true);
  const start = state.start;
  const end = endWanted() ? state.end : null;
  if (endWanted() && !end) {
    if (!touchUI()) {
      state.tool = "end";
      applyFinish();
    }
    return setProgress(`${touchUI() ? "Tap the map and choose End here" : "Click the map"} to set where you'll finish, or pick another finish.`, true);
  }
  const budget = settings.budgetKm * 1000;
  let need: BBox;
  let note = "";
  if (settings.mode === "max") {
    if (end) {
      const trip = bboxForTrip(start, end, budget, MAX_RADIUS);
      if (trip.capped) note = `Searched streets within ${MAX_RADIUS / 1000} km of the start and end.`;
      need = trip.bbox;
    } else {
      const wanted = budget * (settings.finish === "start" ? 0.42 : 0.8);
      const radius = Math.min(wanted, MAX_RADIUS);
      if (radius < wanted) note = `Searched streets within ${MAX_RADIUS / 1000} km of the start.`;
      need = bboxAround(start.lat, start.lng, radius);
    }
  } else {
    if (!state.selected.size) return setProgress("Pick at least one hexagon on the map.", true);
    need = bboxForVisit();
    if (areaKm2(need) > 160) return setProgress(`Those hexagons span ${Math.round(areaKm2(need))} km². Pick ones closer together (under about 160 km²).`, true);
  }

  state.busy = true;
  $<HTMLButtonElement>("plan").disabled = true;
  renderSheetHead();
  try {
    const g = state.graph;
    if (!g || g.profile !== settings.profile || g.resolution !== ds.resolution || !bboxContains(g.bbox, need)) {
      const res = await ask({ id: 0, type: "load", bbox: need, profile: settings.profile, resolution: ds.resolution }, setProgress);
      if (res.type === "error") throw new Error(res.message);
      if (res.type !== "loaded") throw new Error("Unexpected reply from the planner.");
      if (res.nodes === 0) throw new Error("No streets or paths found around the start point.");
      state.graph = { bbox: res.bbox, profile: settings.profile, resolution: ds.resolution };
    }
    let budgetM = budget;
    if (end && settings.mode === "max") {
      // The streets are loaded now, so the real shortest way to the end is known.
      const m = await ask({ id: 0, type: "measure", start, end }, setProgress);
      if (m.type === "error") throw new Error(m.message);
      if (m.type === "measured") {
        if (m.length === null) throw new Error("There's no street route between your start and end points.");
        const least = floorKm(m.length);
        if (least > MAX_KM) throw new Error(`Your end point is ${formatKm(m.length / 1000)} km from the start by street, further than the ${MAX_KM} km limit.`);
        if (settings.budgetKm < least) {
          setBudget(least, true);
          budgetM = least * 1000;
          note += ` Distance raised to ${formatKm(least)} km, the shortest way to your end point.`;
        }
      }
    }
    const req: WorkerRequest =
      settings.mode === "max"
        ? {
            id: 0,
            type: "maxScore",
            start,
            budget: budgetM,
            closed: settings.finish === "start",
            end: end ?? undefined,
            // Hexagons you're skipping are worth nothing, so routes don't go out of their way for them.
            known: [...state.plans].map(([c, p]) => [c, state.mine.has(c) ? 0 : p.value]),
            unclaimed: settings.weights.claim,
            count: settings.routeCount,
          }
        : { id: 0, type: "visitAll", start, targets: [...state.selected], closed: settings.finish === "start", end: end ?? undefined };
    const res = await ask(req, setProgress);
    if (res.type === "error") throw new Error(res.message);
    const routes = res.type === "routes" ? res.routes : res.type === "route" ? [res.route] : null;
    if (!routes?.length) throw new Error("Unexpected reply from the planner.");
    $("r-note").dataset.note =
      note + (settings.mode === "max" && routes.length < settings.routeCount ? ` Only ${routes.length} of ${settings.routeCount} routes found ground worth a run.` : "");
    setRoutes(routes);
    void updateFloor(); // the streets are loaded now, so the end point's distance is exact
    if (sheet.active) sheet.set("peek");
    pmap.fitCoords(routes.flatMap((r) => r.coords), 14, fitPadding());
    setProgress("");
  } catch (e) {
    setProgress(e instanceof Error ? e.message : String(e), true);
  } finally {
    state.busy = false;
    $<HTMLButtonElement>("plan").disabled = false;
    renderSheetHead();
  }
}

function renderRoute() {
  const r = state.route;
  const game = state.game;
  const ds = state.ds;
  renderSheetHead();
  renderRouteList();
  if (!r || !game || !ds) {
    $("result").hidden = true;
    pmap.setRoutes([], []);
    syncLiveRoute();
    return;
  }
  $("result").hidden = false;
  const t = together();
  const proj = t.proj!;
  const skipped = t.skipped;
  pmap.setRoutes(
    t.shown.map(({ route, i }) => ({ coords: route.coords, colour: routeColour(i), focused: i === state.focus })),
    t.all,
  );
  syncLiveRoute();
  const many = state.routes.length > 1;
  $("result-title").textContent = many ? "Your routes" : "Your route";
  $("r-together").hidden = !many;
  $("r-together").textContent =
    t.shown.length > 1 ? `The ${t.shown.length} ticked routes together:` : `Route ${t.shown[0].i + 1} on its own:`;
  const km = t.length / 1000;
  $("r-dist").textContent = `${km.toFixed(km < 10 ? 2 : 1)} km`;
  const minutes = settings.profile === "bike" ? (km / 20) * 60 : km * 5.5;
  $("r-time").textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}` : `${Math.round(minutes)} min`;
  $("r-time-label").textContent = settings.profile === "bike" ? "at 20 km/h" : "at 5:30/km";
  $("r-points").textContent = proj.points.toFixed(1);

  const chips: [Outcome, string][] = [
    ["claim", "unclaimed taken"],
    ["steal", "taken from rivals"],
    ["defend", "shored up"],
    ["siege", "closer to taking"],
    ["secure", "already safe"],
  ];
  $("breakdown").innerHTML =
    chips
      .filter(([k]) => proj.counts[k] > 0)
      .map(([k, label]) => `<li>${swatch(OUTCOME_COLOURS[k])}<b>${proj.counts[k]}</b> ${label}</li>`)
      .join("") + (skipped ? `<li><span class="mine-key"></span><b>${skipped}</b> you've already crossed</li>` : "");

  const order = ds.teams.map((_, i) => i).sort((a, b) => proj.heldAfter[b] - proj.heldAfter[a]);
  $("projection").innerHTML =
    `<tr><td class="muted">Hexagons held</td><td class="muted">now</td><td class="muted">after</td></tr>` +
    order
      .map((i) => {
        const d = proj.heldAfter[i] - proj.heldBefore[i];
        const delta = d ? ` <span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span>` : "";
        return `<tr><td>${swatch(ds.teams[i].colour)} ${esc(ds.teams[i].name)}${i === state.team ? ' <span class="you">You</span>' : ""}</td><td>${proj.heldBefore[i]}</td><td>${proj.heldAfter[i]}${delta}</td></tr>`;
      })
      .join("");

  const notes: string[] = [];
  if ($("r-note").dataset.note) notes.push($("r-note").dataset.note!);
  if (settings.mode === "visit") {
    const covered = new Set(r.cells);
    const missed = [...state.selected].filter((c) => !covered.has(c));
    const shallow = missed.length - r.unreachable.length;
    if (r.unreachable.length) notes.push(`${r.unreachable.length} picked ${r.unreachable.length === 1 ? "hexagon has" : "hexagons have"} no streets or paths the route can use.`);
    if (shallow > 0) notes.push(`${shallow} picked ${shallow === 1 ? "hexagon is" : "hexagons are"} only reachable near the edge, so GPS may not register ${shallow === 1 ? "it" : "them"}.`);
    if (!missed.length) notes.push(`Passes through all ${state.selected.size} picked hexagons.`);
  }
  notes.push(`Gets at least ${MARGIN} m inside ${t.all.length} hexagons, so GPS drift shouldn't cost you any. Each counts once per run.`);
  if (skipped) notes.push(`${skipped} of them you've already crossed, so they're left out of the points and standings above.`);
  $("r-note").textContent = notes.join(" ");
}

/** One GPX file per ticked route: Garmin Connect imports one course per file. */
function downloadGpx() {
  const shown = shownRoutes();
  if (!shown.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const many = state.routes.length > 1;
  shown.forEach(({ route, i }, n) => {
    setTimeout(() => {
      const name = many ? `Land grab route ${i + 1} ${stamp}` : `Land grab route ${stamp}`;
      const blob = new Blob([toGpx(route.coords, name)], { type: "application/gpx+xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = many ? `land-grab-route-${i + 1}-${stamp}.gpx` : `land-grab-route-${stamp}.gpx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, n * 400);
  });
}

/** The list of planned routes: tick to show, tap the name to focus. */
function renderRouteList() {
  const list = $("route-list");
  const game = state.game;
  list.hidden = state.routes.length < 2 || !game;
  if (list.hidden || !game) return;
  list.innerHTML = state.routes
    .map((r, i) => {
      const own = projectRun(game, state.team, countable(r.cells), settings.weights);
      const km = r.length / 1000;
      const focused = i === state.focus;
      return `<li class="route-item${focused ? " focused" : ""}">
        <input type="checkbox" data-pick="${i}" ${state.picked.has(i) ? "checked" : ""} aria-label="Show route ${i + 1}" style="accent-color:${routeColour(i)}" />
        <button type="button" class="route-focus" data-focus="${i}" aria-pressed="${focused}">
          <span class="route-swatch" style="background:${routeColour(i)}"></span>
          <b>Route ${i + 1}</b>
          <span class="muted">${km.toFixed(km < 10 ? 2 : 1)} km · ${own.points.toFixed(1)} pts · ${r.cells.length} hexagons</span>
        </button>
      </li>`;
    })
    .join("");
}

$("route-list").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  const i = Number(box.dataset.pick);
  if (!Number.isInteger(i)) return;
  if (box.checked) state.picked.add(i);
  else if (state.picked.size > 1) state.picked.delete(i);
  else box.checked = true; // keep at least one showing
  if (!state.picked.has(state.focus)) {
    // Focus moves to the first route still ticked.
    state.focus = Math.min(...state.picked);
    state.route = state.routes[state.focus];
  }
  renderRoute();
});
$("route-list").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-focus]");
  if (button) focusRoute(Number(button.dataset.focus));
});

// ---------- controls ----------
function applyMode() {
  setPressed("mode", "data-mode", settings.mode);
  const visit = settings.mode === "visit";
  if (visit && state.tool === "start" && state.selected.size === 0) state.tool = "select";
  $("selected-row").hidden = !visit;
  $("budget-field").hidden = visit;
  $("count-field").hidden = visit;
  $("mode-hint").textContent = visit
    ? "Click hexagons on the map to pick them. The planner finds the shortest street route that enters every one."
    : "Finds the route that wins the most points within your distance. Blank, unclaimed ground counts too.";
  applyFinish();
  renderSheetHead();
}

$("mode").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest("button")?.dataset.mode as Settings["mode"] | undefined;
  if (!m) return;
  settings.mode = m;
  saveSettings();
  applyMode();
});
$("tool").addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("button")?.dataset.tool as Tool | undefined;
  if (!t) return;
  state.tool = t;
  applyFinish();
});
$("view").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest("button")?.dataset.view as Settings["view"] | undefined;
  if (!v) return;
  settings.view = v;
  saveSettings();
  setPressed("view", "data-view", v);
  pmap.setView(v);
  renderLegend();
});
$("profile").addEventListener("click", (e) => {
  const p = (e.target as HTMLElement).closest("button")?.dataset.profile as Profile | undefined;
  if (!p) return;
  settings.profile = p;
  saveSettings();
  setPressed("profile", "data-profile", p);
  void updateFloor();
});

// ---------- hexagons you've already crossed ----------
function renderSkipHint() {
  const hint = document.getElementById("skip-hint");
  if (!hint || !state.ds) return;
  const any = state.ds.activities.some((a) => a.mine);
  hint.textContent = !any
    ? "This data doesn't include any of your own activities this week."
    : settings.skipMine === "off"
      ? `Routes treat the ${state.mineWeek.size} hexagons you've crossed this week like any other.`
      : `Skipping ${state.mine.size} ${state.mine.size === 1 ? "hexagon" : "hexagons"} you've crossed ${settings.skipMine === "today" ? "today" : "this week"}.`;
}

setPressed("skip", "data-skip", settings.skipMine);
$("skip").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest("button")?.dataset.skip as SkipMine | undefined;
  if (!v || v === settings.skipMine) return;
  settings.skipMine = v;
  saveSettings();
  setPressed("skip", "data-skip", v);
  refreshHexes();
  renderRoute();
  if (state.route && settings.mode === "max") setProgress("Re-plan to route with this setting.");
});

// ---------- how many routes ----------
function setRouteCount(n: number) {
  settings.routeCount = Math.min(5, Math.max(1, Math.round(n) || 1));
  $("count-out").textContent = String(settings.routeCount);
  $("count-unit").textContent = settings.routeCount === 1 ? "route" : "routes";
  $<HTMLButtonElement>("count-down").disabled = settings.routeCount <= 1;
  $<HTMLButtonElement>("count-up").disabled = settings.routeCount >= 5;
  saveSettings();
}
$("count-down").addEventListener("click", () => setRouteCount(settings.routeCount - 1));
$("count-up").addEventListener("click", () => setRouteCount(settings.routeCount + 1));
setRouteCount(settings.routeCount);

const budget = $<HTMLInputElement>("budget");
settings.budgetKm = clampKm(Number(settings.budgetKm) || 8);
budget.value = formatKm(settings.budgetKm);

function setBudget(km: number, rewrite: boolean) {
  settings.budgetKm = clampKm(km, state.floorKm);
  if (rewrite) budget.value = formatKm(settings.budgetKm);
  $<HTMLButtonElement>("budget-down").disabled = settings.budgetKm <= state.floorKm;
  $<HTMLButtonElement>("budget-up").disabled = settings.budgetKm >= MAX_KM;
  saveSettings();
  renderSheetHead();
}

/** Whether the box holds a distance we can use as typed (in range, not just clamped to it). */
function markBudget() {
  const km = parseKm(budget.value);
  const ok = km !== null && km >= state.floorKm && km <= MAX_KM;
  budget.setAttribute("aria-invalid", String(!ok));
  $("budget-hint").textContent = `Type a distance between ${formatKm(state.floorKm)} and ${MAX_KM} km.`;
  $("budget-hint").hidden = ok;
  return km;
}

budget.addEventListener("input", () => {
  // Take valid distances as they're typed, but leave the text alone until they're done.
  const km = markBudget();
  if (km !== null && km >= state.floorKm && km <= MAX_KM) setBudget(km, false);
});
budget.addEventListener("change", () => {
  const km = parseKm(budget.value);
  setBudget(km ?? settings.budgetKm, true);
  markBudget();
});
budget.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    setBudget(stepKm(parseKm(budget.value) ?? settings.budgetKm, e.key === "ArrowUp" ? 1 : -1, state.floorKm), true);
    markBudget();
  } else if (e.key === "Enter") budget.blur();
});
budget.addEventListener("focus", () => budget.select());
for (const [id, dir] of [["budget-down", -1], ["budget-up", 1]] as const) {
  $(id).addEventListener("click", () => {
    setBudget(stepKm(parseKm(budget.value) ?? settings.budgetKm, dir, state.floorKm), true);
    markBudget();
  });
}
setBudget(settings.budgetKm, true);

// ---------- where the route finishes ----------
function setFloor(km: number, note: string, bad = false) {
  state.floorKm = km;
  const el = $("budget-min");
  el.textContent = note;
  el.hidden = !note;
  el.classList.toggle("error", bad);
  setBudget(settings.budgetKm, true);
  markBudget();
}

let floorToken = 0;
/** Works out the least distance that reaches the end point, and holds the budget above it. */
async function updateFloor() {
  const token = ++floorToken;
  const s = state.start;
  const e = state.end;
  if (settings.mode !== "max" || !endWanted() || !s || !e) return setFloor(MIN_KM, "");
  const straight = haversine(s.lat, s.lng, e.lat, e.lng);
  const rough = floorKm(straight);
  if (rough > MAX_KM) return setFloor(MAX_KM, `Your end point is ${formatKm(straight / 1000)} km from the start in a straight line, further than the ${MAX_KM} km limit.`, true);
  setFloor(rough, `At least ${formatKm(rough)} km to reach your end point (in a straight line; checked against real streets when you plan).`);
  // If the streets between the two points are already loaded, the exact figure is cheap.
  const g = state.graph;
  if (!g || g.profile !== settings.profile || !bboxContains(g.bbox, bboxUnion(bboxAround(s.lat, s.lng, 300), bboxAround(e.lat, e.lng, 300)))) return;
  const res = await ask({ id: 0, type: "measure", start: s, end: e }, () => {});
  if (token !== floorToken || res.type !== "measured") return;
  if (res.length === null) return setFloor(rough, "There's no street route between your start and end points.", true);
  const exact = floorKm(res.length);
  if (exact > MAX_KM) return setFloor(MAX_KM, `Your end point is ${formatKm(res.length / 1000)} km from the start by street, further than the ${MAX_KM} km limit.`, true);
  setFloor(exact, `At least ${formatKm(exact)} km: the shortest street route to your end point.`);
}

/** Syncs the finish, the end marker and the map-click choices with the settings and the mode. */
function applyFinish() {
  const visit = settings.mode === "visit";
  // Touch screens set the end from the hexagon card ("End here") instead of a click mode.
  const endTool = endWanted() && !touchUI();
  if ((state.tool === "end" && !endTool) || (state.tool === "select" && !visit)) state.tool = "start";
  const tool = $("tool");
  tool.hidden = !visit && !endTool;
  tool.querySelector<HTMLElement>('[data-tool="end"]')!.hidden = !endTool;
  tool.querySelector<HTMLElement>('[data-tool="select"]')!.hidden = !visit;
  setPressed("tool", "data-tool", state.tool);
  pmap.map.getCanvas().style.cursor = state.tool === "select" ? "pointer" : "crosshair";

  setPressed("finish", "data-finish", settings.finish);
  $("end-hint").textContent = touchUI() ? "Tap the map where you'll finish, then End here." : "Click the map to set where you'll finish.";
  $("end-hint").hidden = !endWanted() || !!state.end;
  pmap.setEnd(endWanted() ? state.end : null);
  void updateFloor();
}

$("finish").addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest("button")?.dataset.finish as Finish | undefined;
  if (!f) return;
  settings.finish = f;
  if (f === "end" && !state.end) state.tool = "end";
  saveSettings();
  applyFinish();
  renderSheetHead();
});

document.querySelectorAll<HTMLInputElement>("#weights input[data-w]").forEach((input) => {
  const key = input.dataset.w as "claim" | "block" | "defend" | "siege";
  const out = input.nextElementSibling as HTMLOutputElement;
  input.value = String(settings.weights[key]);
  out.textContent = settings.weights[key].toFixed(2);
  input.addEventListener("input", () => {
    settings.weights[key] = parseFloat(input.value);
    out.textContent = settings.weights[key].toFixed(2);
    saveSettings();
    refreshHexes();
    renderRoute();
  });
});
const leader = $<HTMLInputElement>("leader");
leader.checked = settings.weights.leaderFocus;
leader.addEventListener("change", () => {
  settings.weights.leaderFocus = leader.checked;
  saveSettings();
  refreshHexes();
  renderRoute();
});

$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) loadData(await file.text(), true);
  (e.target as HTMLInputElement).value = "";
});
$("paste-load").addEventListener("click", () => {
  const text = $<HTMLTextAreaElement>("paste").value.trim();
  if (text) loadData(text, true);
});
$("demo").addEventListener("click", () => {
  const c = state.start ?? pmap.map.getCenter();
  state.start = null;
  loadData(makeDemo({ lat: c.lat, lng: c.lng }), true);
});
$("clear-selected").addEventListener("click", () => {
  state.selected.clear();
  renderSelected();
});
$("locate").addEventListener("click", () => {
  if (live.fix) {
    setStart(live.fix.lat, live.fix.lng);
    return;
  }
  if (!navigator.geolocation) return setProgress("Your browser can't share its location.", true);
  setProgress("Finding you…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStart(pos.coords.latitude, pos.coords.longitude);
      pmap.map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 13 });
      setProgress("");
    },
    (err) => setProgress(`Couldn't get your location: ${err.message}`, true),
  );
});
$("plan").addEventListener("click", plan);
$("sheet-plan").addEventListener("click", plan);
$("gpx").addEventListener("click", downloadGpx);
$("clear-route").addEventListener("click", () => setRoutes([]));

// ---------- live location ----------
const LIVE_LABELS: Record<Outcome, string> = {
  claim: "unclaimed, yours if you get in",
  steal: "one crossing takes it",
  defend: "yours, but at risk",
  siege: "not enough to take it yet",
  secure: "yours and safe",
};

/** Resets progress when the route changes, and redraws it. */
function syncLiveRoute() {
  if (live.routeFor === state.route) return;
  live.routeFor = state.route;
  live.routeCells = new Set(state.route?.cells ?? []);
  live.reached.clear();
  pmap.setReached([]);
  renderLive();
}

function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}

async function keepAwake(on: boolean) {
  try {
    if (on && !live.wake && "wakeLock" in navigator && document.visibilityState === "visible") {
      const lock = await navigator.wakeLock.request("screen");
      live.wake = lock;
      lock.addEventListener("release", () => {
        if (live.wake === lock) live.wake = null;
      });
    } else if (!on && live.wake) {
      const lock = live.wake;
      live.wake = null;
      await lock.release();
    }
  } catch {
    /* refused (battery saver, unsupported): the map still works */
  }
}
document.addEventListener("visibilitychange", () => {
  // Browsers drop the lock when the tab is hidden; take it back on return.
  if (document.visibilityState === "visible" && live.state !== "off") keepAwake(true);
});

function liveStart() {
  if (!navigator.geolocation) {
    live.error = "This browser can't share its location.";
    return renderLive(true);
  }
  live.error = "";
  live.state = "follow";
  if (sheet.active) sheet.set("peek");
  pmap.setLiveState("follow", true);
  live.watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 });
  live.timer = window.setInterval(() => {
    if (live.fix) pmap.setMe({ ...live.fix, stale: Date.now() - live.fix.at > 20_000 });
    renderLive();
  }, 5000);
  keepAwake(true);
  renderLive();
}

function liveStop() {
  if (live.watch !== null) navigator.geolocation.clearWatch(live.watch);
  clearInterval(live.timer);
  live.watch = null;
  live.state = "off";
  live.fix = null;
  pmap.setMe(null);
  pmap.setLiveState("off");
  pmap.clearInset();
  keepAwake(false);
  renderLive();
}

function onFix(pos: GeolocationPosition) {
  if (live.state === "off") return;
  const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
  const prev = live.fix;
  // Trust the GPS heading while moving; otherwise work it out from the last fix, once you've
  // moved further than the GPS wobbles.
  let dir: number | null = heading !== null && Number.isFinite(heading) && (speed ?? 1) > 0.5 ? heading : null;
  if (dir === null && prev) {
    const moved = haversine(prev.lat, prev.lng, lat, lng);
    dir = moved > Math.max(8, accuracy / 2) ? bearing(prev, { lat, lng }) : prev.heading;
  }
  live.fix = { lat, lng, accuracy, heading: dir, at: pos.timestamp || Date.now() };
  live.error = "";
  pmap.setMe(live.fix);
  pmap.setLiveState(live.state);
  renderLive();
  if (live.state === "follow") pmap.follow(lat, lng, !prev, liveInset());

  syncLiveRoute();
  const cell = latLngToCell(lat, lng, state.ds?.resolution ?? 8);
  if (live.routeCells.has(cell) && !live.reached.has(cell) && depthInCell(cell, lat, lng) >= MARGIN) {
    live.reached.add(cell);
    pmap.setReached(live.reached);
  }
  if (live.state === "follow") renderHex(cell);
  renderLive();
}

function onFixError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) {
    liveStop();
    live.error = "Location is blocked for this site. Allow it in your browser's site settings, then try again.";
    renderLive(true);
    return;
  }
  // Timeouts and lost signal: keep watching and say so.
  live.error = live.fix ? "GPS signal lost, keep going." : "Waiting for GPS…";
  renderLive();
}

/** Pixels at the top of the map taken by the live card, so following keeps you below it. */
function liveInset() {
  const el = $("live");
  return el.hidden ? 0 : el.offsetTop + el.offsetHeight + 12;
}

function renderLive(showError = false) {
  const el = $("live");
  if (live.state === "off") {
    el.hidden = !(showError && live.error);
    el.innerHTML = live.error ? `<div class="live-row warn">${esc(live.error)}</div>` : "";
    if (showError) setTimeout(() => live.state === "off" && (el.hidden = true), 10_000);
    return;
  }
  el.hidden = false;
  const f = live.fix;
  const head = `<div class="live-row"><span class="live-pill"><i></i>Live</span>`;
  if (!f) {
    el.innerHTML = `${head}<span>${esc(live.error || "Finding you…")}</span></div>`;
    return;
  }
  const rows: string[] = [];
  const age = Math.round((Date.now() - f.at) / 1000);
  const gps = `GPS ±${Math.round(f.accuracy)} m${age > 20 ? `, last fix ${age} s ago` : ""}`;
  rows.push(`${head}<span class="${f.accuracy > 25 || age > 20 ? "warn" : "muted"}">${gps}</span></div>`);
  if (live.error) rows.push(`<div class="live-row warn">${esc(live.error)}</div>`);

  const cell = latLngToCell(f.lat, f.lng, state.ds?.resolution ?? 8);
  const depth = depthInCell(cell, f.lat, f.lng);
  if (state.game && state.ds) {
    const h = state.game.hexes.get(cell);
    const p = assess(state.game, state.team, cell, settings.weights);
    const owner = h ? `${swatch(teamColour(h.holder))}<b>${teamName(h.holder)}</b>` : `${swatch(OUTCOME_COLOURS.claim)}<b>Unclaimed</b>`;
    rows.push(`<div class="live-row">${owner}<span class="muted">${LIVE_LABELS[p.outcome]}</span></div>`);
  }
  rows.push(
    state.mine.has(cell)
      ? `<div class="live-row muted">You've already crossed this one</div>`
      : depth >= MARGIN
        ? `<div class="live-row ok">${Math.round(depth)} m inside: this hexagon counts</div>`
        : `<div class="live-row">${Math.round(depth)} m inside: ${Math.ceil(MARGIN - depth)} m more and it counts</div>`,
  );
  const r = state.route;
  if (r && live.routeCells.size) {
    const off = distanceToRoute(r.coords, f.lat, f.lng);
    const n = live.reached.size;
    const total = live.routeCells.size;
    rows.push(
      `<div class="live-row"><span>Route: <b>${n}</b> of ${total} hexagons reached</span>${off > 40 ? `<span class="warn">${off >= 1000 ? (off / 1000).toFixed(1) + " km" : Math.round(off) + " m"} off route</span>` : ""}</div>`,
      `<div class="live-bar"><i style="width:${Math.round((100 * n) / total)}%"></i></div>`,
    );
  }
  el.innerHTML = rows.join("");
}

pmap.addLiveButton(() => {
  if (live.state === "off") liveStart();
  else if (live.state === "free") {
    live.state = "follow";
    pmap.setLiveState("follow", !live.fix);
    if (live.fix) pmap.follow(live.fix.lat, live.fix.lng, false, liveInset());
  } else liveStop();
});
pmap.onUserPan(() => {
  if (live.state === "follow") {
    live.state = "free";
    pmap.setLiveState("free");
  }
});

if (import.meta.env.DEV) Object.assign(window, { __lgr: { state, live, pmap } });

// ---------- one-click import from strods.uk ----------
const plannerUrl = new URL(import.meta.env.BASE_URL, location.origin).href;
if (touchUI()) {
  // No bookmarks bar to drag to on a phone.
  document.querySelector(".oneclick .hint")!.innerHTML =
    `<b>One-click import:</b> tap <button type="button" id="copy-bookmarklet" class="link">Copy it for a phone</button>, then follow the ` +
    `<a href="how-to.html#bookmark">phone steps</a> to save it as a bookmark. Use it on strods.uk/overview.`;
}
const bookmark = $<HTMLAnchorElement>("bookmarklet");
bookmark.href = bookmarkletHref(plannerUrl);
bookmark.addEventListener("click", (e) => {
  // Clicking it here would just send you to strods.uk; it's meant to be dragged.
  e.preventDefault();
  setDataStatus("Drag that button to your bookmarks bar, then click the bookmark on strods.uk/overview.");
});
$("copy-bookmarklet").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(bookmark.href);
    setDataStatus("Copied. On your phone, bookmark any page, then edit the bookmark and paste this in as its address. The help page has the steps.");
  } catch {
    setDataStatus("Couldn't copy here. Long-press the button and choose Copy Link instead.", true);
  }
});

function setDataStatus(text: string, isError = false) {
  $("data-status").textContent = text;
  $("data-status").classList.toggle("error", isError);
}

/** Opened by the bookmark: say we're ready, then take the data it sends. */
function awaitImport() {
  const opener = window.opener as Window | null;
  if (location.hash !== "#import" || !opener || !document.getElementById("data-status")) return;
  setDataStatus("Getting your data from strods.uk…");
  const tidy = () => history.replaceState(null, "", location.pathname + location.search);
  receiveImport(window, opener, {
    onData(json) {
      tidy();
      loadData(json, true);
    },
    onError(message) {
      tidy();
      setDataStatus(`Couldn't get your data: ${message}.`, true);
    },
    onTimeout() {
      tidy();
      setDataStatus("Didn't hear back from strods.uk. Go back to strods.uk/overview and click the bookmark again.", true);
    },
  });
}

// ---------- start up ----------
setPressed("view", "data-view", settings.view);
setPressed("profile", "data-profile", settings.profile);
applyMode();
pmap.setView(settings.view);
let saved: string | null = null;
try {
  saved = localStorage.getItem(DATA_KEY);
} catch {
  /* ignore */
}
if (saved) loadData(saved, false);
else renderHex(null);
renderSheetHead();
awaitImport();
