/* global L, turf */
(function () {
    "use strict";

    /**
     * Initializes the Leaflet map.
     * @param {string} elementId DOM element id for the map container.
     * @returns {L.Map} Leaflet map instance.
     */
    function initMap(elementId) {
        const map = L.map(elementId, {
            zoomControl: false,
            minZoom: 14,
            maxZoom: 22,
            zoomSnap: 0.25,
            zoomDelta: 0.5,
            wheelDebounceTime: 10,
            preferCanvas: false
        }).setView([40.69803104641056, -124.19603359276114], 20);

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
        }).addTo(map);
        CR.enableTilePrefetch(map, osm);
        const esriSat = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            { maxZoom: 24, maxNativeZoom: 22 }
        );
        CR.enableTilePrefetch(map, esriSat);


// Toggle between base maps
        L.control.layers(
            { "OSM Standard": osm, "Esri World Imagery": esriSat },
            {},
            { position: "topleft", collapsed: false }
        ).addTo(map);

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
        if (t === "entrance" || t === "exit" || t === "stairwell") return { };
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
        const emoji = t === "entrance" ? "🚪" : t === "exit" ? "🏁" : t === "stairwell" ? "🧭" : "📍";
        const icon = L.divIcon({ className: "poi", html: '<div style="font-size:12px">' + emoji + "</div>" });
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
        var title = [p.name, p.number].filter(Boolean).join(" · ");
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

        zooms.forEach(zRaw => {
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
                    const xx = ((x % limit) + limit) % limit;     // wrap X
                    const yy = Math.min(Math.max(y, 0), limit - 1); // clamp Y
                    const url = tileLayer.getTileUrl({ x: xx, y: yy, z });
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
            style: function () { return { color: "rgb(16,124,111)", weight: 3 }; }
        });
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

    /* global L, turf */

// Build a simple undirected graph from walkway LineStrings
    function buildWalkwayGraph(walkwaysFc) {
        const nodes = [];             // array of [lng, lat]
        const nodeIndex = new Map();  // "lng,lat" -> index
        const adjacency = new Map();  // index -> [{ to, weight }]

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

        // Flatten MultiLineStrings etc
        turf.flattenEach(walkwaysFc, function (feature) {
            const geom = feature.geometry;
            if (!geom || geom.type !== "LineString") return;

            const coords = geom.coordinates;
            for (let i = 0; i < coords.length - 1; i++) {
                const a = coords[i];
                const b = coords[i + 1];
                const ia = getNodeIndex(a);
                const ib = getNodeIndex(b);

                const w = turf.distance(a, b, { units: "kilometers" });

                adjacency.get(ia).push({ to: ib, weight: w });
                adjacency.get(ib).push({ to: ia, weight: w });
            }
        });

        return { nodes, adjacency };
    }

// Find nearest graph node to a coordinate
    function findNearestNode(nodes, coord) {
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = 0; i < nodes.length; i++) {
            // distance in km (relative only)
            const d = turf.distance(nodes[i], coord, { units: "kilometers" });
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        return { index: bestIdx, distanceKm: bestDist };
    }

// Dijkstra shortest path
    function dijkstraShortestPath(graph, startIndex, endIndex) {
        const { nodes, adjacency } = graph;
        const n = nodes.length;

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

            if (u === -1) break;      // no reachable node
            if (u === endIndex) break; // reached target

            visited[u] = true;
            const edges = adjacency.get(u) || [];
            for (const edge of edges) {
                const v = edge.to;
                const alt = dist[u] + edge.weight;
                if (alt < dist[v]) {
                    dist[v] = alt;
                    prev[v] = u;
                }
            }
        }

        if (!isFinite(dist[endIndex])) return null; // no path

        // Reconstruct path of node indices
        const pathIdx = [];
        let cur = endIndex;
        while (cur != null) {
            pathIdx.push(cur);
            cur = prev[cur];
        }
        pathIdx.reverse();

        return {
            distanceKm: dist[endIndex],
            coordinates: pathIdx.map(function (i) { return graph.nodes[i]; })
        };
    }

// Routing UI wiring
    function initRouting(map, walkwaysFc) {
        const sidebar = document.getElementById("route-sidebar");
        if (!sidebar) return; // nothing to do on pages without the sidebar

        const btnStart = document.getElementById("route-set-start");
        const btnEnd = document.getElementById("route-set-end");
        const btnClear = document.getElementById("route-clear");
        const startLabel = document.getElementById("route-start-label");
        const endLabel = document.getElementById("route-end-label");
        const distanceLabel = document.getElementById("route-distance-label");

        const graph = buildWalkwayGraph(walkwaysFc);

        let mode = null; // "start" | "end" | null
        let startCoord = null;
        let endCoord = null;

        const startMarker = L.marker([0, 0], { draggable: false });
        const endMarker = L.marker([0, 0], { draggable: false });
        let routeLine = null;

        function updateLabels() {
            startLabel.textContent = "Start: " + (startCoord ? startCoord[1].toFixed(5) + ", " + startCoord[0].toFixed(5) : "—");
            endLabel.textContent = "End: " + (endCoord ? endCoord[1].toFixed(5) + ", " + endCoord[0].toFixed(5) : "—");
        }

        function clearRoute() {
            startCoord = null;
            endCoord = null;
            if (map.hasLayer(startMarker)) map.removeLayer(startMarker);
            if (map.hasLayer(endMarker)) map.removeLayer(endMarker);
            if (routeLine && map.hasLayer(routeLine)) map.removeLayer(routeLine);
            routeLine = null;
            distanceLabel.textContent = "Distance: —";
            updateLabels();
        }

        function computeAndDrawRoute() {
            if (!startCoord || !endCoord) return;

            const startNode = findNearestNode(graph.nodes, startCoord);
            const endNode = findNearestNode(graph.nodes, endCoord);

            const result = dijkstraShortestPath(graph, startNode.index, endNode.index);
            if (!result) {
                distanceLabel.textContent = "Distance: (no path)";
                if (routeLine && map.hasLayer(routeLine)) map.removeLayer(routeLine);
                return;
            }

            const km = result.distanceKm;
            const meters = km * 1000;

            distanceLabel.textContent =
                "Distance: " + (meters < 1000 ? meters.toFixed(0) + " m" : km.toFixed(2) + " km");

            if (routeLine && map.hasLayer(routeLine)) {
                map.removeLayer(routeLine);
            }

            routeLine = L.polyline(
                result.coordinates.map(function (c) { return [c[1], c[0]]; }),
                {
                    weight: 5,
                    opacity: 0.85,
                    dashArray: "6,4"
                }
            ).addTo(map);

            map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
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

        map.on("click", function (e) {
            if (!mode) return;

            const coord = [e.latlng.lng, e.latlng.lat];

            if (mode === "start") {
                startCoord = coord;
                startMarker.setLatLng(e.latlng);
                if (!map.hasLayer(startMarker)) startMarker.addTo(map);
            } else if (mode === "end") {
                endCoord = coord;
                endMarker.setLatLng(e.latlng);
                if (!map.hasLayer(endMarker)) endMarker.addTo(map);
            }

            mode = null;
            updateLabels();
            computeAndDrawRoute();
        });

        clearRoute();
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

})();
