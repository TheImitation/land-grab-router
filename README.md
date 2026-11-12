# Land Grab Router

Plans running (or riding) routes for the strods.uk "land grab" challenge, where crossing an
H3 hexagon claims it for your team. It rebuilds the live map from the same data the site
uses, then finds either:

- **Most points**: the route within your distance budget that wins the most, counting
  unclaimed ground, hexagons you can take off rivals (extra credit for blocking the leaders),
  hexagons of yours that are at risk, and progress towards ones you can't take yet.
- **Through chosen hexagons**: the shortest street route that enters every hexagon you
  click.
- **Finish** back at the start, anywhere, or at an **end point** you place on the map (handy
  for running home from work, or to a station). For most points the distance can't go below
  the shortest street route to the end; anything above it goes on detours for points along
  the way. Drag the E marker to move it, or on a phone tap a hexagon and choose **End here**.
- **Several routes at once** (most points): set "Routes to plan" to up to 5. Each later route
  goes for ground the earlier ones don't, so together they're a set of runs for different
  days. Tick which ones to show (points and standings are for the ticked ones together),
  tap one to focus it for live location, and Download GPX saves one file per ticked route.

Routes follow real streets and paths, and export as GPX for Garmin Connect or Strava.

**On a phone** the map fills the screen and the controls live in a bottom sheet: drag it up
or tap its summary to open it, and it drops back down after you plan so you can see the route.
Tap a hexagon to see who holds it, with a **Start here** button. Add it to your home screen
(Share → Add to Home Screen on iPhone, ⋮ → Add to Home screen on Android) and it opens
full-screen like an app.

**Live location** (the target button under the zoom controls) shows where you are on the
map while you run: the hexagon you're in and who holds it, whether you're far enough inside
for it to count, how far you are off the planned route, and which of the route's hexagons
you've reached. It follows you until you pan the map (tap the button to re-centre, tap again
to turn it off), and keeps the screen awake while it's on. Your location never leaves the
phone. Phones only allow location on `https://` pages, which GitHub Pages is.

It only opens for data downloaded by a member of **Worst Pace Scenario** (team 29), and always
plans for that team. Data from any other team gets a mock crash screen and isn't kept. The
check is in `src/team.ts`. It runs in the browser and this repo is public, so it's a deterrent,
not security.

Not affiliated with strods.uk.

## Run it

```bash
npm install
npm run dev
```

Then click **Try demo data** to play with a generated week, or load your real data (below).

```bash
npm test         # game rules, scoring, street graph and solvers
npm run build    # production build in dist/
```

## Getting your live data

**One click:** drag the **Send to Land Grab Router** button (under Game data) to your bookmarks
bar, then click the bookmark on strods.uk/overview. It runs on strods.uk, so it can fetch the
data with your login, and hands it to the planner tab with `postMessage`. The planner only accepts
it from a strods.uk tab that opened it (`src/bookmarklet.ts`).

**By hand:**

The API (`https://api.strods.uk/clubs/{clubId}/land-grab`) authenticates with your
browser's login cookie, so this app can't call it directly. Instead:

1. Open <https://strods.uk/overview> while signed in.
2. Open DevTools, go to **Network**, and filter for `land-grab` (reload if it's empty).
3. Right-click the request, then **Copy → Copy response**.
4. Paste it into **Game data → Paste JSON**, or save it as a `.json` file and load that.

There's a fuller guide (Firefox and Safari, shortcuts, phones, troubleshooting) at
[`public/how-to.html`](public/how-to.html), served as `how-to.html` next to the app.

The data (including other athletes' first names) stays in your browser's local storage.
`data/*.json` is git-ignored if you keep copies in the project.

## How it works

| Piece | Where | Notes |
| --- | --- | --- |
| Map | `src/map.ts` | MapLibre GL with OpenFreeMap's dark style, recoloured the way strods.uk does it. Hexagon fill, gap lines, route and selection layers. |
| Game rules | `src/data/replay.ts` | Replays every crossing of the week in time order. A team takes a hexagon with more crossings than the holder, or the same number if it got there first. Matches the site's client code. |
| Scoring | `src/scoring.ts` | What one more run does to each hexagon for your team: claim, steal, siege, defend or secure, with adjustable weights. A property test checks the projected standings against a full replay. |
| Streets | `src/graph/tiles.ts` | Roads and paths from the `transportation` layer of OpenFreeMap's zoom-14 vector tiles (fast, CDN-hosted). Tiles are lightly simplified and cut at edges, so junctions are repaired: loose ends within ~1.5 m are joined, as are streets crossing at street level (not bridges or tunnels). Falls back to the Overpass API if tiles fail. |
| Graph | `src/graph/graph.ts` | Compressed-sparse-row street graph; every node and long segment is tagged with its H3 cell. |
| Most points | `src/solve/maxScore.ts` | Orienteering heuristic: greedy points-per-metre insertion, 2-opt / or-opt, real street stitching that credits hexagons passed on the way, pruning of stops that became free, tightening, then out-and-back spurs to use leftover distance. Several starting shapes are tried and the best is kept. |
| Through chosen | `src/solve/visitAll.ts` | Orders the hexagons (nearest neighbour + 2-opt + or-opt), enters each one at whichever of its streets suits the legs either side, then tightens. |
| Tightening | `src/solve/tighten.ts` | A hexagon counts once the route is safely inside it, so going deeper is wasted. Each stop moves to the cheapest point in its hexagon given its neighbours, and stops the rest of the route already covers are dropped; changes are kept only if nothing is lost. On London streets this wins 5–20% more ground per kilometre. |
| Worker | `src/worker.ts` | Downloads and solves off the main thread. |
| Live location | `src/live.ts`, `src/main.ts` | Watches the Geolocation API, draws a dot, accuracy circle and heading wedge, and checks each fix against the 15 m margin to mark route hexagons reached. |

## Assumptions worth knowing

- **One visit per run.** A run counts once per hexagon even if it crosses it twice. The
  site's data lists cells per activity; if it ever counts repeat crossings, loops that
  double back would be worth more than this planner thinks.
- **15 m GPS margin.** A hexagon only counts, and is only used as a target, where the
  route gets at least 15 m inside its edges. Change `MARGIN` in `src/graph/graph.ts`.
- **Hexagons you've already crossed.** By default routes skip hexagons on your own activities
  this week (the data marks them `mine`): they score nothing and routes don't aim for them,
  though a route may still pass through one on the way. You can skip only today's, or count
  them. By the site's own rules a repeat crossing still adds a visit for your team, so
  "Count them" can win more in contested hexagons; skipping assumes repeats don't count.
- **Turning back mid-street.** Long streets are cut into 20 m pieces (`MAX_PIECE`), so a
  quick trip into a hexagon turns back at most ~20 m past the margin instead of running
  on to the next junction. Like a real U-turn, it can happen anywhere along a street.
- **Pavements.** Pavements mapped as separate footways aren't in the tiles; the road next
  to them is, so routes run along the road.
- **Street search area.** "Most points" looks within 5 km of the start (`MAX_RADIUS` in
  `src/main.ts`), which covers loops up to roughly 25–30 km. With an end point it looks
  around both ends instead, still at most 5 km from the middle in each direction.
- **Standings move.** Data is a snapshot. Re-copy it before you head out if others have
  been running.
