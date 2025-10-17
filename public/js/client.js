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
})();
