/* global L, turf */
(function () {
    "use strict";

    /**
     * Initializes the Leaflet map.
     * @param {string} elementId DOM element id for the map container.
     * @returns {L.Map} Leaflet map instance.
     */
    function initMap(elementId) {
        const campusCenter = [40.69803104641056, -124.19603359276114];
        const bounds = L.latLngBounds(
            [40.6935, -124.2015], // SW
            [40.7025, -124.1905]  // NE
        );

        const map = L.map(elementId, {
            zoomControl: false,
            minZoom: 15,
            maxZoom: 22,
            maxBounds: bounds.pad(0.1),
            maxBoundsViscosity: 0.8,
            zoomSnap: 0.25,
            zoomDelta: 0.5,
            wheelDebounceTime: 10,
            preferCanvas: false
        }).setView(campusCenter, 20);

        L.control.zoom({ position: "bottomright" }).addTo(map);
        const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap contributors",
            maxZoom: 22,
            maxNativeZoom: 19,
            noWrap: true,
            crossOrigin: true,
            keepBuffer: 8,
            updateWhenZooming: true,
            updateWhenIdle: false,
            errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw="
        });
        CR.enableTilePrefetch(map, osm);
        const esriSat = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            {
                maxZoom: 24,
                maxNativeZoom: 19, // ESRI imagery often stops here; allow over-zooming to reuse last good tiles
                reuseTiles: true,
                updateWhenZooming: false,
                updateWhenIdle: true
            }
        );
        CR.enableTilePrefetch(map, esriSat);

        map._crBase = {
            current: "paper",
            layers: {
                paper: osm,
                satellite: esriSat
            }
        };
        // start with paper layer
        map.addLayer(osm);

        return map;
    }

    /**
     * Loads GeoJSON features from the server.
     * @returns {Promise<GeoJSON.FeatureCollection>} Feature collection.
     */
    async function fetchFeatures() {
        const res = await fetch("/api/features");
        return res.json();
    }

    /**
     * Creates a Leaflet layer for features with symbology and interactivity.
     * @param {GeoJSON.FeatureCollection} fc Feature collection.
     * @returns {L.GeoJSON} Leaflet GeoJSON layer.
     */
    function createFeaturesLayer(fc) {
        const layer = L.geoJSON(fc, {
            style: function (f) { return styleForFeature(f); },
            pointToLayer: function (f, latlng) { return pointMarkerForFeature(f, latlng); },
            onEachFeature: function (f, l) { bindPopupForFeature(f, l); }
        });
        return layer;
    }

    /**
     * Returns a style object based on feature type.
     * @param {GeoJSON.Feature} feature Feature to style.
     * @returns {L.PathOptions} Leaflet style options.
     */
    function styleForFeature(feature) {
        const t = feature.properties && feature.properties.type;
        if (t === "building") return { color: "#7aa2ff", weight: 2, fillOpacity: 0.25 };
        if (t === "path") return { color: "#6de0a6", weight: 3 };
        if (t === "room") return { color: "#ffce73", weight: 1.5, fillOpacity: 0.3 };
        if (t === "entrance" || t === "exit" || t === "stairwell") return {};
        return { color: "#9fb0d6", weight: 1.5 };
    }

    /**
     * Creates a point marker with an appropriate icon based on feature type.
     * @param {GeoJSON.Feature} feature Feature to render.
     * @param {L.LatLng} latlng Coordinates.
     * @returns {L.Layer} Leaflet marker layer.
     */
    function pointMarkerForFeature(feature, latlng) {
        const t = feature.properties && feature.properties.type;
        const label = t === "entrance" ? "IN" : t === "exit" ? "OUT" : t === "stairwell" ? "ST" : "POI";
        const icon = L.divIcon({ className: "poi", html: "<span>" + label + "</span>" });
        return L.marker(latlng, { icon: icon });
    }

    /**
     * Binds a popup to a layer showing key metadata.
     * @param {GeoJSON.Feature} feature Feature to describe.
     * @param {L.Layer} layer Leaflet layer.
     * @returns {void} Nothing.
     */
    function bindPopupForFeature(feature, layer) {
        var p = feature.properties || {};
        var title = [p.name, p.number].filter(Boolean).join(" - ");
        var meta = ["Type: " + (p.type || "unknown"), p.buildingId ? "Building: " + p.buildingId : ""].filter(Boolean).join("<br>");
        var id = p._id ? '<small class="badge">#' + p._id + "</small>" : "";
        layer.bindPopup("<strong>" + (title || "Feature") + "</strong> " + id + "<br>" + meta);
    }

    /**
     * Saves a feature to the server.
     * @param {GeoJSON.Feature} feature GeoJSON feature.
     * @returns {Promise<GeoJSON.Feature>} Saved feature.
     */
    async function saveFeature(feature) {
        const res = await fetch("/api/features", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(feature)
        });
        return res.json();
    }

    /**
     * Deletes a feature by its identifier.
     * @param {string} id Feature identifier.
     * @returns {Promise<boolean>} True when deletion succeeds.
     */
    async function deleteFeature(id) {
        const res = await fetch("/api/features/" + id, { method: "DELETE" });
        return res.ok;
    }

    /**
     * Prefetch integer zoom tiles only, capped to native zoom.
     * @param {L.Map} map
     * @param {L.TileLayer} tileLayer
     * @param {number[]} zooms
     */
    function prefetchTiles(map, tileLayer, zooms) {
        const tileSize = tileLayer.getTileSize().x;
        const maxNative = tileLayer.options.maxNativeZoom ?? tileLayer.options.maxZoom ?? 19;
        const minZ = tileLayer.options.minZoom ?? 0;

        zooms.forEach(function (zRaw) {
            const z = Math.max(minZ, Math.min(maxNative, Math.round(zRaw))); // integer + capped
            const bounds = map.getBounds();
            const nw = map.project(bounds.getNorthWest(), z);
            const se = map.project(bounds.getSouthEast(), z);

            const x0 = Math.floor(nw.x / tileSize) - 1;
            const y0 = Math.floor(nw.y / tileSize) - 1;
            const x1 = Math.floor(se.x / tileSize) + 1;
            const y1 = Math.floor(se.y / tileSize) + 1;

            const limit = 1 << z; // 2^z

            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    const xx = ((x % limit) + limit) % limit; // wrap X
                    const yy = Math.min(Math.max(y, 0), limit - 1); // clamp Y
                    const url = tileLayer.getTileUrl({ x: xx, y: yy, z: z });
                    const img = new Image();
                    img.referrerPolicy = "no-referrer";
                    // IMPORTANT: do NOT set img.crossOrigin here (avoid CORS mode)
                    img.src = url;
                }
            }
        });
    }

    /**
     * Enable prefetch using integer zooms.
     * @param {L.Map} map
     * @param {L.TileLayer} tileLayer
     */
    function enableTilePrefetch(map, tileLayer) {
        let t;
        const currentZ = () => Math.round(map.getZoom());
        const doPrefetch = () => prefetchTiles(map, tileLayer, [currentZ(), currentZ() + 1]);
        map.on("moveend zoomend", () => {
            clearTimeout(t);
            t = setTimeout(doPrefetch, 150);
        });
        doPrefetch();
    }

    /**
     * Loads walkway features from the server.
     * @returns {Promise<GeoJSON.FeatureCollection>} Feature collection.
     */
    async function fetchWalkways() {
        const res = await fetch("/api/walkways");
        return res.json();
    }

    /**
     * Creates a Leaflet layer for walkways.
     * @param {GeoJSON.FeatureCollection} fc Walkway features.
     * @returns {L.GeoJSON} Leaflet layer.
     */
    function createWalkwaysLayer(fc) {
        return L.geoJSON(fc, {
            style: function () { return { color: "rgb(16,124,111)", weight: 3, opacity: 0.85 }; }
        });
    }

    /**
     * Lightweight search over features by name/number/building prefix.
     * @param {Array<Object>} items
     * @param {string} query
     * @param {number} limit
     */
    function simpleSearch(items, query, limit) {
        if (!query) return [];
        const q = query.trim().toLowerCase();
        return items.filter(function (item) {
            const hay = (item.searchKey || "").toLowerCase();
            return hay.includes(q);
        }).slice(0, limit || 8);
    }

    /**
     * Snap a coordinate to the nearest walkway (LineString) using turf.
     * @param {L.Map} mapInst
     * @param {GeoJSON.FeatureCollection} walkwaysFc
     * @param {[number,number]} coord [lng,lat]
     * @param {number} maxMeters maximum snap distance
     * @returns {{coord:[number,number], distMeters:number}|null}
     */
    function snapToWalkways(mapInst, walkwaysFc, coord, maxMeters) {
        const pt = turf.point(coord);
        let best = null;
        (walkwaysFc.features || []).forEach(function (f) {
            if (!f.geometry || f.geometry.type !== "LineString") return;
            const snap = turf.nearestPointOnLine(f, pt, { units: "meters" });
            const d = snap.properties && typeof snap.properties.dist === "number" ? snap.properties.dist : Infinity;
            if (!best || d < best.distMeters) {
                best = { coord: snap.geometry.coordinates, distMeters: d };
            }
        });
        if (!best || best.distMeters > maxMeters) return null;
        return best;
    }

    /**
     * Saves a walkway feature.
     * @param {GeoJSON.Feature} feature GeoJSON LineString.
     * @returns {Promise<GeoJSON.Feature>} Saved feature.
     */
    async function saveWalkway(feature) {
        const res = await fetch("/api/walkways", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(feature)
        });
        return res.json();
    }

    /**
     * Deletes a walkway by ID.
     * @param {string} id Identifier.
     * @returns {Promise<boolean>} True when ok.
     */
    async function deleteWalkway(id) {
        const res = await fetch("/api/walkways/" + id, { method: "DELETE" });
        return res.ok;
    }

    /**
     * Build a routing graph from walkway features, including intersections.
     * @param {L.Map} mapInst
     * @param {GeoJSON.FeatureCollection} walkwaysFc
     * @returns {{nodes: Array<[number,number]>, adjacency: Map<number,Array<{to:number,weight:number}>>, segments: Array<{a:number,b:number,coordA:[number,number],coordB:[number,number]}>}}
     */
    function buildWalkwayGraph(mapInst, walkwaysFc) {
        const raw = (walkwaysFc && walkwaysFc.features) || [];
        const walkways = [];

        raw.forEach(function (f, idx) {
            if (!f.geometry || f.geometry.type !== "LineString") return;
            const coords = (f.geometry.coordinates || []).map(function (c) { return [c[0], c[1]]; });
            if (coords.length < 2) return;
            walkways.push({
                id: (f.properties && f.properties._id) || "w" + idx,
                coords: coords
            });
        });

        // Collect intersection points per segment
        const segmentIntersections = new Map(); // key: "wIdx:segIdx" -> Array<{coord:[number,number], t:number}>

        function segKey(wi, si) { return wi + ":" + si; }

        function addIntersection(wi, si, coord, t) {
            const key = segKey(wi, si);
            if (!segmentIntersections.has(key)) segmentIntersections.set(key, []);
            segmentIntersections.get(key).push({ coord: coord, t: t });
        }

        function computeT(a, b, p) {
            const vx = b[0] - a[0];
            const vy = b[1] - a[1];
            const wx = p[0] - a[0];
            const wy = p[1] - a[1];
            const vv = vx * vx + vy * vy || 1e-12;
            let t = (vx * wx + vy * wy) / vv;
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            return t;
        }

        // Find intersections between walkways (pairwise)
        for (let i = 0; i < walkways.length; i++) {
            const wi = walkways[i];
            for (let j = i + 1; j < walkways.length; j++) {
                const wj = walkways[j];

                const ci = wi.coords;
                const cj = wj.coords;

                for (let si = 0; si < ci.length - 1; si++) {
                    const Ai = ci[si];
                    const Bi = ci[si + 1];
                    const li = turf.lineString([Ai, Bi]);

                    for (let sj = 0; sj < cj.length - 1; sj++) {
                        const Aj = cj[sj];
                        const Bj = cj[sj + 1];
                        const lj = turf.lineString([Aj, Bj]);

                        const inter = turf.lineIntersect(li, lj);
                        if (!inter.features || !inter.features.length) continue;

                        inter.features.forEach(function (ptFeature) {
                            const p = ptFeature.geometry && ptFeature.geometry.coordinates;
                            if (!p) return;

                            const t1 = computeT(Ai, Bi, p);
                            const t2 = computeT(Aj, Bj, p);

                            addIntersection(i, si, p, t1);
                            addIntersection(j, sj, p, t2);
                        });
                    }
                }
            }
        }

        // Enrich each walkway coords with intersection points, split along segments
        walkways.forEach(function (w, wi) {
            const src = w.coords;
            const out = [];
            for (let si = 0; si < src.length - 1; si++) {
                const A = src[si];
                const B = src[si + 1];
                out.push(A);

                const key = segKey(wi, si);
                let list = segmentIntersections.get(key) || [];
                if (list.length) {
                    // sort intersections along the segment
                    list.sort(function (a, b) { return a.t - b.t; });
                    list.forEach(function (item) {
                        const c = item.coord;
                        const last = out[out.length - 1];
                        const dx = Math.abs(c[0] - last[0]);
                        const dy = Math.abs(c[1] - last[1]);
                        if (dx > 1e-10 || dy > 1e-10) {
                            out.push([c[0], c[1]]);
                        }
                    });
                }
            }
            out.push(src[src.length - 1]);
            w.coords = out;
        });

        // Build graph (nodes + adjacency + segments)
        const nodes = [];
        const nodeIndex = new Map(); // "lng,lat" -> index
        const adjacency = new Map();
        const segments = [];

        function getNodeIndex(coord) {
            const key = coord[0] + "," + coord[1];
            if (!nodeIndex.has(key)) {
                const idx = nodes.length;
                nodes.push(coord);
                nodeIndex.set(key, idx);
                adjacency.set(idx, []);
            }
            return nodeIndex.get(key);
        }

        walkways.forEach(function (w) {
            const coords = w.coords;
            if (coords.length < 2) return;

            const nodeIdx = coords.map(function (c) { return getNodeIndex(c); });

            for (let i = 0; i < coords.length - 1; i++) {
                const ia = nodeIdx[i];
                const ib = nodeIdx[i + 1];
                const A = coords[i];
                const B = coords[i + 1];
                const wKm = turf.distance(A, B, { units: "kilometers" });

                adjacency.get(ia).push({ to: ib, weight: wKm });
                adjacency.get(ib).push({ to: ia, weight: wKm });

                segments.push({
                    a: ia,
                    b: ib,
                    coordA: A,
                    coordB: B
                });
            }
        });

        // Soft-connect nearby nodes that are within a small tolerance (helps when lines barely miss)
        connectNearbyNodes(mapInst, nodes, adjacency, 2); // meters

        return { nodes: nodes, adjacency: adjacency, segments: segments };
    }

    /**
     * Connect nodes that are very close (tolerance meters) to avoid gaps from almost-touching lines.
     */
    function connectNearbyNodes(mapInst, nodes, adjacency, toleranceMeters) {
        const n = nodes.length;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const d = mapInst.distance(L.latLng(a[1], a[0]), L.latLng(b[1], b[0]));
                if (d <= toleranceMeters) {
                    adjacency.get(i).push({ to: j, weight: d / 1000 });
                    adjacency.get(j).push({ to: i, weight: d / 1000 });
                }
            }
        }
    }

    /**
     * Insert a point (start/end) into the graph by splitting the nearest segment.
     * @param {L.Map} mapInst
     * @param {{nodes:Array<[number,number]>, adjacency:Map, segments:Array}} graph
     * @param {[number,number]} coord [lng,lat]
     * @returns {{nodeIndex:number, snapped:[number,number]}|null}
     */
    function insertPointIntoGraph(mapInst, graph, coord, maxSnapMeters) {
        if (!graph.segments.length) return null;

        const targetLL = L.latLng(coord[1], coord[0]);
        const targetPt = mapInst.project(targetLL);

        let best = null; // {seg, snappedCoord, dist}

        graph.segments.forEach(function (seg, idx) {
            const A = seg.coordA;
            const B = seg.coordB;
            const aLL = L.latLng(A[1], A[0]);
            const bLL = L.latLng(B[1], B[0]);
            const aPt = mapInst.project(aLL);
            const bPt = mapInst.project(bLL);

            const vx = bPt.x - aPt.x;
            const vy = bPt.y - aPt.y;
            const wx = targetPt.x - aPt.x;
            const wy = targetPt.y - aPt.y;

            const vv = vx * vx + vy * vy || 1e-12;
            let t = (vx * wx + vy * wy) / vv;
            if (t < 0) t = 0;
            if (t > 1) t = 1;

            const projX = aPt.x + t * vx;
            const projY = aPt.y + t * vy;
            const projLL = mapInst.unproject(L.point(projX, projY));

            const dist = mapInst.distance(targetLL, projLL);
            if (!best || dist < best.dist) {
                best = {
                    seg: seg,
                    segIndex: idx,
                    snappedCoord: [projLL.lng, projLL.lat],
                    dist: dist
                };
            }
        });

        if (!best || (maxSnapMeters && best.dist > maxSnapMeters)) return null;

        const snapped = best.snappedCoord;
        const A = best.seg.coordA;
        const B = best.seg.coordB;
        const ia = best.seg.a;
        const ib = best.seg.b;

        // If it's essentially at an existing node, just reuse that node
        function almostEqual(c1, c2) {
            return Math.abs(c1[0] - c2[0]) < 1e-10 && Math.abs(c1[1] - c2[1]) < 1e-10;
        }
        if (almostEqual(snapped, A)) return { nodeIndex: ia, snapped: A, distMeters: best.dist };
        if (almostEqual(snapped, B)) return { nodeIndex: ib, snapped: B, distMeters: best.dist };

        // Create new node
        const newIndex = graph.nodes.length;
        graph.nodes.push(snapped);
        graph.adjacency.set(newIndex, []);

        // Remove old edge ia <-> ib
        graph.adjacency.set(ia, graph.adjacency.get(ia).filter(function (e) { return e.to !== ib; }));
        graph.adjacency.set(ib, graph.adjacency.get(ib).filter(function (e) { return e.to !== ia; }));

        // Remove old segment, add two new segments
        graph.segments.splice(best.segIndex, 1);
        const dA = turf.distance(A, snapped, { units: "kilometers" });
        const dB = turf.distance(snapped, B, { units: "kilometers" });

        graph.adjacency.get(ia).push({ to: newIndex, weight: dA });
        graph.adjacency.get(newIndex).push({ to: ia, weight: dA });

        graph.adjacency.get(ib).push({ to: newIndex, weight: dB });
        graph.adjacency.get(newIndex).push({ to: ib, weight: dB });

        graph.segments.push({
            a: ia,
            b: newIndex,
            coordA: A,
            coordB: snapped
        });
        graph.segments.push({
            a: newIndex,
            b: ib,
            coordA: snapped,
            coordB: B
        });

        return { nodeIndex: newIndex, snapped: snapped, distMeters: best.dist };
    }

    /**
     * Dijkstra shortest path over the walkway graph.
     * @param {{nodes:Array<[number,number]>, adjacency:Map<number,Array<{to:number,weight:number}>>}} graph
     * @param {number} startIndex
     * @param {number} endIndex
     * @returns {{distanceKm:number, path:Array<number>}|null}
     */
    function dijkstraShortestPath(graph, startIndex, endIndex) {
        const n = graph.nodes.length;
        const dist = new Array(n).fill(Infinity);
        const prev = new Array(n).fill(null);
        const visited = new Array(n).fill(false);

        dist[startIndex] = 0;

        while (true) {
            let u = -1;
            let best = Infinity;
            for (let i = 0; i < n; i++) {
                if (!visited[i] && dist[i] < best) {
                    best = dist[i];
                    u = i;
                }
            }
            if (u === -1) break;
            if (u === endIndex) break;

            visited[u] = true;
            const edges = graph.adjacency.get(u) || [];
            for (const edge of edges) {
                const v = edge.to;
                const alt = dist[u] + edge.weight;
                if (alt < dist[v]) {
                    dist[v] = alt;
                    prev[v] = u;
                }
            }
        }

        if (!isFinite(dist[endIndex])) return null;

        const path = [];
        let cur = endIndex;
        while (cur != null) {
            path.push(cur);
            cur = prev[cur];
        }
        path.reverse();

        return { distanceKm: dist[endIndex], path: path };
    }

    /**
     * Wire up the routing UI on the public map.
     * @param {L.Map} mapInst
     * @param {GeoJSON.FeatureCollection} walkwaysFc
     */
    function initRouting(mapInst, walkwaysFc) {
        const sidebar = document.getElementById("route-sidebar");
        if (!sidebar) return;

        const MAX_SNAP_METERS = 150;
        const startSearchInput = document.getElementById("route-start-search");
        const endSearchInput = document.getElementById("route-end-search");
        const btnStart = document.getElementById("route-set-start");
        const btnEnd = document.getElementById("route-set-end");
        const btnClear = document.getElementById("route-clear");
        const startLabel = document.getElementById("route-start-label");
        const endLabel = document.getElementById("route-end-label");
        const distanceLabel = document.getElementById("route-distance-label");

        let mode = null; // "start"|"end"|null
        let startCoord = null;
        let endCoord = null;
        let startSnapDist = null;
        let endSnapDist = null;
        let featureIndex = null;
        let startMarker = null;
        let endMarker = null;
        let routeLine = null;

        function formatLabel(coord, dist) {
            if (!coord) return "--";
            const text = coord[1].toFixed(5) + ", " + coord[0].toFixed(5);
            if (typeof dist === "number") {
                return text + " (snapped " + Math.round(dist) + " m)";
            }
            return text;
        }

        function updateLabels() {
            startLabel.textContent = "Start: " + formatLabel(startCoord, startSnapDist);
            endLabel.textContent = "End: " + formatLabel(endCoord, endSnapDist);
        }

        function clearRoute() {
            startCoord = null;
            endCoord = null;
            startSnapDist = null;
            endSnapDist = null;
            if (startMarker) mapInst.removeLayer(startMarker);
            if (endMarker) mapInst.removeLayer(endMarker);
            if (routeLine) mapInst.removeLayer(routeLine);
            startMarker = null;
            endMarker = null;
            routeLine = null;
            distanceLabel.textContent = "Distance: --";
            updateLabels();
            if (startSearchInput) startSearchInput.value = "";
            if (endSearchInput) endSearchInput.value = "";
        }

        async function recomputeRoute() {
            if (!startCoord || !endCoord) return;

            const graph = buildWalkwayGraph(mapInst, walkwaysFc);
            if (!graph.nodes.length) {
                distanceLabel.textContent = "Distance: (no walkways)";
                return;
            }

            const startInfo = insertPointIntoGraph(mapInst, graph, startCoord, MAX_SNAP_METERS);
            const endInfo = insertPointIntoGraph(mapInst, graph, endCoord, MAX_SNAP_METERS);
            if (!startInfo || !endInfo) {
                distanceLabel.textContent = "Distance: (click closer to a walkway)";
                return;
            }

            const result = dijkstraShortestPath(graph, startInfo.nodeIndex, endInfo.nodeIndex);
            if (!result) {
                distanceLabel.textContent = "Distance: (no path)";
                if (routeLine) mapInst.removeLayer(routeLine);
                return;
            }

            const coords = result.path.map(function (idx) {
                const c = graph.nodes[idx];
                return [c[1], c[0]];
            });

            const km = result.distanceKm;
            const m = km * 1000;
            distanceLabel.textContent = "Distance: " + (m < 1000 ? m.toFixed(0) + " m" : km.toFixed(2) + " km");

            if (routeLine) mapInst.removeLayer(routeLine);
            routeLine = L.polyline(coords, {
                weight: 6,
                opacity: 0.9,
                dashArray: "8,5"
            }).addTo(mapInst);

            mapInst.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
        }

        btnStart.addEventListener("click", function () {
            mode = "start";
        });

        btnEnd.addEventListener("click", function () {
            mode = "end";
        });

        btnClear.addEventListener("click", function () {
            mode = null;
            clearRoute();
        });

        mapInst.on("click", function (e) {
            if (!mode) return;
            const coord = [e.latlng.lng, e.latlng.lat];
            const snapped = snapToWalkways(mapInst, walkwaysFc, coord, MAX_SNAP_METERS);
            if (!snapped) {
                distanceLabel.textContent = "Distance: (click closer to a walkway)";
                mode = null;
                return;
            }

            const snappedLatLng = L.latLng(snapped.coord[1], snapped.coord[0]);

            if (mode === "start") {
                startCoord = snapped.coord;
                startSnapDist = snapped.distMeters;
                if (!startMarker) {
                    startMarker = L.marker(snappedLatLng, { draggable: false }).addTo(mapInst);
                } else {
                    startMarker.setLatLng(snappedLatLng);
                }
            } else if (mode === "end") {
                endCoord = snapped.coord;
                endSnapDist = snapped.distMeters;
                if (!endMarker) {
                    endMarker = L.marker(snappedLatLng, { draggable: false }).addTo(mapInst);
                } else {
                    endMarker.setLatLng(snappedLatLng);
                }
            }

            mode = null;
            updateLabels();
            recomputeRoute();
        });

        // Build feature index for search
        featureIndex = buildFeatureIndex();

        function buildFeatureIndex() {
            const items = [];
            const addItem = function (f) {
                const p = f.properties || {};
                const id = p._id;
                const type = p.type;
                const name = p.name || "";
                const number = p.number || "";
                const buildingId = p.buildingId || "";
                const searchKey = [name, number, buildingId, type].filter(Boolean).join(" ");
                items.push({ id: id, type: type, name: name, number: number, buildingId: buildingId, geom: f.geometry, searchKey: searchKey, raw: f });
            };
            (walkwaysFc.features || []).forEach(addItem); // entrances may be part of features
            return items;
        }

        function resolveFeatureToCoord(item, role) {
            if (!item || !item.raw || !item.raw.geometry) return null;
            const p = item.raw.properties || {};

            if (p.type === "entrance") {
                const c = item.raw.geometry.coordinates;
                return { coord: c, label: p.name || "Entrance" };
            }

            if (p.type === "room" && p.buildingId) {
                // look up building entrances
                const entrances = featureIndex.filter(function (x) { return x.type === "entrance" && x.buildingId === p.buildingId; });
                if (entrances.length) {
                    const nearest = entrances[0];
                    return { coord: nearest.raw.geometry.coordinates, label: nearest.name || "Entrance" };
                }
            }

            if (p.type === "building") {
                // pick nearest entrance if available
                const entrances = featureIndex.filter(function (x) { return x.type === "entrance" && x.buildingId === p._id; });
                if (entrances.length) {
                    const nearest = entrances[0];
                    return { coord: nearest.raw.geometry.coordinates, label: nearest.name || "Entrance" };
                }
                // fallback centroid
                if (item.raw.geometry.type === "Polygon") {
                    const c = turf.centerOfMass(item.raw);
                    return { coord: c.geometry.coordinates, label: p.name || "Building centroid" };
                }
            }

            // fallback to point geom
            return item.raw.geometry.coordinates ? { coord: item.raw.geometry.coordinates, label: p.name || role } : null;
        }

        function handleSearch(inputEl, role) {
            if (!inputEl) return;
            inputEl.addEventListener("change", function () {
                const q = inputEl.value;
                if (!q || !featureIndex) return;
                const matches = simpleSearch(featureIndex, q, 1);
                if (!matches.length) return;
                const resolved = resolveFeatureToCoord(matches[0], role);
                if (!resolved) return;
                const snapped = snapToWalkways(mapInst, walkwaysFc, resolved.coord, MAX_SNAP_METERS);
                if (!snapped) return;
                const latlng = L.latLng(snapped.coord[1], snapped.coord[0]);

                if (role === "start") {
                    startCoord = snapped.coord;
                    startSnapDist = snapped.distMeters;
                    if (!startMarker) startMarker = L.marker(latlng, { draggable: false }).addTo(mapInst);
                    else startMarker.setLatLng(latlng);
                } else {
                    endCoord = snapped.coord;
                    endSnapDist = snapped.distMeters;
                    if (!endMarker) endMarker = L.marker(latlng, { draggable: false }).addTo(mapInst);
                    else endMarker.setLatLng(latlng);
                }
                updateLabels();
                recomputeRoute();
            });
        }

        handleSearch(startSearchInput, "start");
        handleSearch(endSearchInput, "end");

        clearRoute();
    }

    /**
     * Simple slide-out drawer for quick actions/settings.
     */
    function initUtilityDrawer(mapInst) {
        const toggle = document.getElementById("utility-toggle");
        const drawer = document.getElementById("utility-drawer");
        const closeBtn = document.getElementById("utility-close");
        const scrim = document.getElementById("utility-scrim");
        if (!toggle || !drawer) return;

        const open = () => {
            drawer.classList.add("open");
            drawer.setAttribute("aria-hidden", "false");
            toggle.setAttribute("aria-expanded", "true");
            if (scrim) scrim.classList.add("visible");
        };
        const close = () => {
            drawer.classList.remove("open");
            drawer.setAttribute("aria-hidden", "true");
            toggle.setAttribute("aria-expanded", "false");
            if (scrim) scrim.classList.remove("visible");
        };

        toggle.addEventListener("click", function () {
            if (drawer.classList.contains("open")) {
                close();
            } else {
                open();
            }
        });
        if (closeBtn) closeBtn.addEventListener("click", close);
        if (scrim) scrim.addEventListener("click", close);
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") close();
        });

        drawer.addEventListener("click", function (e) {
            const btn = e.target && e.target.closest && e.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.getAttribute("data-action");
            close();
            if (window.CR && typeof window.CR.onMenuAction === "function") {
                window.CR.onMenuAction(action);
            } else {
                // eslint-disable-next-line no-console
                console.info("Menu action selected:", action);
            }
        });

        // Base map buttons
        const baseToggle = document.getElementById("basemap-toggle");
        if (baseToggle && mapInst && mapInst._crBase) {
            baseToggle.addEventListener("click", function (e) {
                const btn = e.target && e.target.closest && e.target.closest("[data-base-layer]");
                if (!btn) return;
                const layerName = btn.getAttribute("data-base-layer");
                if (!layerName) return;
                setBaseLayer(mapInst, layerName);
                baseToggle.querySelectorAll(".basemap-btn").forEach(function (el) {
                    el.classList.toggle("active", el === btn);
                });
            });
        }

        // Admin modal hook
        const adminBtn = document.getElementById("drawer-admin-fab");
        const modalScrim = document.getElementById("auth-modal-scrim");
        const modalClose = document.getElementById("auth-modal-close");
        if (adminBtn && modalScrim) {
            adminBtn.addEventListener("click", function () {
                modalScrim.classList.add("open");
                modalScrim.setAttribute("aria-hidden", "false");
                close();
                const pwd = modalScrim.querySelector("#modal-password");
                if (pwd) setTimeout(() => pwd.focus(), 50);
            });
            const closeModal = function () {
                modalScrim.classList.remove("open");
                modalScrim.setAttribute("aria-hidden", "true");
            };
            modalScrim.addEventListener("click", function (e) {
                if (e.target === modalScrim) closeModal();
            });
            if (modalClose) modalClose.addEventListener("click", closeModal);
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape") closeModal();
            });
        }

        // Settings modal hook
        const settingsBtn = document.getElementById("drawer-settings-fab");
        const settingsModal = document.getElementById("settings-modal-scrim");
        const settingsClose = document.getElementById("settings-modal-close");
        if (settingsBtn && settingsModal) {
            const openSettings = function () {
                settingsModal.classList.add("open");
                settingsModal.setAttribute("aria-hidden", "false");
                close();
            };
            const closeSettings = function () {
                settingsModal.classList.remove("open");
                settingsModal.setAttribute("aria-hidden", "true");
            };
            settingsBtn.addEventListener("click", openSettings);
            if (settingsClose) settingsClose.addEventListener("click", closeSettings);
            settingsModal.addEventListener("click", function (e) {
                if (e.target === settingsModal) closeSettings();
            });
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape") closeSettings();
            });
        }
    }

    function setBaseLayer(mapInst, name) {
        if (!mapInst || !mapInst._crBase) return;
        const store = mapInst._crBase;
        if (!store.layers[name] || store.current === name) return;
        if (store.layers[store.current]) {
            mapInst.removeLayer(store.layers[store.current]);
        }
        mapInst.addLayer(store.layers[name]);
        store.current = name;
    }

    window.CR = window.CR || {};
    window.CR.initMap = initMap;
    window.CR.fetchFeatures = fetchFeatures;
    window.CR.createFeaturesLayer = createFeaturesLayer;
    window.CR.saveFeature = saveFeature;
    window.CR.deleteFeature = deleteFeature;
    window.CR._styleForFeature = styleForFeature;
    window.CR._bindPopupForFeature = bindPopupForFeature;
    window.CR.enableTilePrefetch = enableTilePrefetch;
    window.CR.fetchWalkways = fetchWalkways;
    window.CR.createWalkwaysLayer = createWalkwaysLayer;
    window.CR.saveWalkway = saveWalkway;
    window.CR.deleteWalkway = deleteWalkway;
    window.CR.initRouting = initRouting;
    window.CR.initUtilityDrawer = initUtilityDrawer;
    window.CR.setBaseLayer = setBaseLayer;

})();
