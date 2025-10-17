/* global L, CR, turf */
(function () {
    "use strict";

    var SNAP_METERS = 3;
    var CURVE_SAMPLES = 20;
    var CURVE_ALPHA = 0.5;
    var HANDLE_COLOR = "#ff3b3b";

    /**
     * Bootstraps the admin map with segmented walkways, live bend handles, right-side panel, and walkway edit mode.
     * @returns {Promise<void>}
     */
    async function bootAdmin() {
        const map = CR.initMap("map");

        const fc = await CR.fetchFeatures();
        const allFeatures = fc.features || [];
        const featureLayer = CR.createFeaturesLayer(fc).addTo(map);

        const wfc = await CR.fetchWalkways();
        const sanitizedWalkways = sanitizeFeatureCollection(wfc);
        const walkwayFeatures = (sanitizedWalkways.features || []).slice();
        const walkwayLayer = CR.createWalkwaysLayer({ type: "FeatureCollection", features: walkwayFeatures }).addTo(map);

        let nodes = buildNodeIndex(walkwayFeatures, allFeatures);
        let selectedWalkwayLayer = null;
        let segmentHandles = [];
        let editMode = false;
        let boxState = null;
        let multiSelection = new Set();

        const drawControl = new L.Control.Draw({
            position: "topleft",
            draw: {
                polygon: {
                    allowIntersection: false,
                    showArea: true,
                    shapeOptions: { color: "rgba(142,0,28,0.9)" }
                },
                polyline: { shapeOptions: { color: "rgb(16,124,111)", weight: 3 } },
                rectangle: false,
                circle: false,
                circlemarker: false,
                marker: { icon: new L.Icon.Default() }
            },
            edit: { featureGroup: walkwayLayer, remove: true }
        });
        map.addControl(drawControl);

        await normalizeWalkways(map, walkwayLayer, walkwayFeatures);

        walkwayLayer.eachLayer(function (l) {
            attachWalkway(map, walkwayLayer, l, function (layer) {
                selectedWalkwayLayer = setSelectedWalkway(selectedWalkwayLayer, layer);
                updateWalkwayPanel(map, layer, walkwayLayer, function (nl) { selectedWalkwayLayer = nl; });
                clearSegmentHandles(segmentHandles);
                segmentHandles = showSegmentHandles(map, layer, CURVE_SAMPLES, CURVE_ALPHA, function (newGeom, newControl, props) { return persistBend(layer, newGeom, newControl, props); });
            });
        });

        L.DomEvent.on(document, "keydown", async function (e) {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            if (e.key === "b" || e.key === "B") startDraw("building");
            if (e.key === "r" || e.key === "R") startDraw("room");
            if (e.key === "e" || e.key === "E") startDraw("entrance");
            if (e.key === "s" || e.key === "S") startDraw("stairwell");
            if (e.key === "w" || e.key === "W") startDraw("walkway");
            if (e.key === "p" || e.key === "P") startDraw("parking");
            if (e.key === "x" || e.key === "X") toggleWalkwayEditMode();
            if ((e.key === "Delete" || e.key === "Backspace") && editMode) deleteSelectedWalkways(walkwayLayer, multiSelection);
        });

        /**
         * Starts an appropriate drawing tool by type.
         * @param {"building"|"room"|"entrance"|"stairwell"|"parking"|"walkway"} type
         * @returns {void}
         */
        function startDraw(type) {
            let drawer;
            if (type === "walkway") drawer = new L.Draw.Polyline(map, drawControl.options.draw.polyline);
            else if (type === "building" || type === "room" || type === "parking")
                drawer = new L.Draw.Polygon(map, drawControl.options.draw.polygon);
            else drawer = new L.Draw.Marker(map, drawControl.options.draw.marker);

            drawer.enable();
            map.once(L.Draw.Event.CREATED, async function (evt) {
                await handleCreated(evt.layer, type);
                nodes = buildNodeIndex(walkwayFeatures, allFeatures);
            });
        }

        /**
         * Handles new geometry creation by saving to the correct store with walkway segmentation.
         * @param {L.Layer} layer
         * @param {string} type
         * @returns {Promise<void>}
         */
        async function handleCreated(layer, type) {
            const gj = layer.toGeoJSON();

            if (type === "walkway") {
                const snapped = snapLineEndpoints(map, gj, nodes, SNAP_METERS);
                const coords = snapped.geometry.coordinates.slice();
                if (coords.length < 2) return;
                if (coords.length === 2) {
                    const name = prompt("Walkway name or code (optional):", "") || undefined;
                    const props = { type: "walkway", name: name, curved: false, control: coords.slice(), segmented: true };
                    const saved = await CR.saveWalkway({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props });
                    walkwayFeatures.push(saved);
                    const g = L.geoJSON(saved, { style: function () { return { color: "rgb(16,124,111)", weight: 3 }; } }).addTo(walkwayLayer);
                    g.eachLayer(function (ll) {
                        attachWalkway(map, walkwayLayer, ll, function (sel) {
                            selectedWalkwayLayer = setSelectedWalkway(selectedWalkwayLayer, sel);
                            updateWalkwayPanel(map, sel, walkwayLayer, function (nl) { selectedWalkwayLayer = nl; });
                            clearSegmentHandles(segmentHandles);
                            segmentHandles = showSegmentHandles(map, sel, CURVE_SAMPLES, CURVE_ALPHA, function (newGeom, newControl, props2) { return persistBend(sel, newGeom, newControl, props2); });
                        });
                    });
                } else {
                    const baseName = prompt("Walkway base name/code (optional, applied to segments):", "") || undefined;
                    const segs = splitIntoSegments(coords).map(function (pair, i) {
                        return {
                            type: "Feature",
                            geometry: { type: "LineString", coordinates: pair },
                            properties: { type: "walkway", name: baseName, curved: false, control: pair.slice(), segmented: true, segmentIndex: i }
                        };
                    });
                    for (const f of segs) {
                        const saved = await CR.saveWalkway(f);
                        walkwayFeatures.push(saved);
                        const g = L.geoJSON(saved, { style: function () { return { color: "rgb(16,124,111)", weight: 3 }; } }).addTo(walkwayLayer);
                        g.eachLayer(function (ll) {
                            attachWalkway(map, walkwayLayer, ll, function (sel) {
                                selectedWalkwayLayer = setSelectedWalkway(selectedWalkwayLayer, sel);
                                updateWalkwayPanel(map, sel, walkwayLayer, function (nl) { selectedWalkwayLayer = nl; });
                                clearSegmentHandles(segmentHandles);
                                segmentHandles = showSegmentHandles(map, sel, CURVE_SAMPLES, CURVE_ALPHA, function (newGeom, newControl, props2) { return persistBend(sel, newGeom, newControl, props2); });
                            });
                        });
                    }
                }
                return;
            }

            if (type === "entrance") {
                const auto = autoNameEntrance(gj, allFeatures);
                const name = prompt("Entrance name (auto-suggested)", auto.suggestedName) || auto.suggestedName;
                const props = { type: "entrance", name: name, buildingId: auto.buildingId || undefined, direction: auto.direction || undefined };
                const saved = await CR.saveFeature({ type: "Feature", geometry: gj.geometry, properties: props });
                allFeatures.push(saved);
                L.geoJSON(saved, {
                    pointToLayer: function (_f, latlng) { return L.marker(latlng); },
                    onEachFeature: function (f, l) { CR._bindPopupForFeature(f, l); }
                }).addTo(featureLayer);
                return;
            }

            if (type === "parking") {
                const name = prompt("Parking lot code (e.g., P2):", "") || undefined;
                await addFeature(gj, { type: "parking", name: name });
                return;
            }

            if (type === "room") {
                const number = prompt("Room number:", "") || undefined;
                const buildingId = prompt("Building ID (optional):", "") || undefined;
                const name = prompt("Room name (optional):", "") || undefined;
                await addFeature(gj, { type: "room", number: number, name: name, buildingId: buildingId });
                return;
            }

            if (type === "stairwell") {
                const buildingId = prompt("Building ID (optional):", "") || undefined;
                const name = prompt("Stairwell name (optional):", "") || undefined;
                await addFeature(gj, { type: "stairwell", name: name, buildingId: buildingId });
                return;
            }

            if (type === "building") {
                const name = prompt("Building name:", "") || "Building";
                const short = prompt("Building prefix/short code (e.g., HU):", "") || undefined;
                await addFeature(gj, { type: "building", name: name, prefix: short });
            }
        }

        /**
         * Adds a campus feature via /api/features and displays it.
         * @param {GeoJSON.Feature} gj
         * @param {Object} properties
         * @returns {Promise<void>}
         */
        async function addFeature(gj, properties) {
            const saved = await CR.saveFeature({ type: "Feature", geometry: gj.geometry, properties: properties });
            allFeatures.push(saved);
            L.geoJSON(saved, {
                style: function (f) { return CR._styleForFeature(f); },
                pointToLayer: function (_f, latlng) { return L.marker(latlng); },
                onEachFeature: function (f, l) { CR._bindPopupForFeature(f, l); }
            }).addTo(featureLayer);
        }

        /**
         * Normalizes loaded walkways so each feature is a single two-point segment.
         * @param {L.Map} mapInst
         * @param {L.GeoJSON} wl
         * @param {GeoJSON.Feature[]} store
         * @returns {Promise<void>}
         */
        async function normalizeWalkways(mapInst, wl, store) {
            const originals = wl.getLayers().slice();
            for (const layer of originals) {
                const f = layer.feature;
                if (!f || f.geometry.type !== "LineString") continue;
                const coords = f.geometry.coordinates || [];
                if (coords.length <= 2) continue;
                const id = f.properties && f.properties._id;
                const baseName = f.properties && f.properties.name;
                const segs = splitIntoSegments(coords).map(function (pair, i) {
                    return {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: pair },
                        properties: { type: "walkway", name: baseName, curved: false, control: pair.slice(), segmented: true, segmentIndex: i }
                    };
                });
                for (const seg of segs) {
                    const saved = await CR.saveWalkway(seg);
                    store.push(saved);
                    const g = L.geoJSON(saved, { style: function () { return { color: "rgb(16,124,111)", weight: 3 }; } }).addTo(wl);
                    g.eachLayer(function (ll) {
                        attachWalkway(mapInst, wl, ll, function () {});
                    });
                }
                if (id) {
                    await CR.deleteWalkway(id);
                    wl.removeLayer(layer);
                }
            }
        }

        /**
         * Persists a per-segment bend for the active layer.
         * @param {L.Layer} layer
         * @param {Array<[number,number]>} newGeom
         * @param {Array<[number,number]>} newControl
         * @param {Object} props
         * @returns {Promise<void>}
         */
        async function persistBend(layer, newGeom, newControl, props) {
            const baseProps = layer.feature.properties || {};
            const updated = {
                type: "Feature",
                geometry: { type: "LineString", coordinates: newGeom },
                properties: Object.assign({}, baseProps, props || {}, { curved: true, control: newControl, segmented: true, _id: baseProps._id })
            };
            const saved = await CR.saveWalkway(updated);
            layer.feature = saved;
            layer.setLatLngs(newGeom.map(function (c) { return [c[1], c[0]]; }));
            updateWalkwayPanel(map, layer, walkwayLayer, function () {});
        }

        /**
         * Attaches selection behavior to a walkway layer.
         * @param {L.Map} mapInst
         * @param {L.GeoJSON} wl
         * @param {L.Layer} layer
         * @param {(layer:L.Layer)=>void} onSelect
         * @returns {void}
         */
        function attachWalkway(mapInst, wl, layer, onSelect) {
            layer.on("click", function () { onSelect(layer); });
        }

        /**
         * Highlights next walkway as selected and unhighlights previous.
         * @param {L.Layer|null} prev
         * @param {L.Layer|null} next
         * @returns {L.Layer|null}
         */
        function setSelectedWalkway(prev, next) {
            if (prev && prev.setStyle) prev.setStyle({ weight: 3, opacity: 1.0 });
            const sel = next || null;
            if (sel && sel.setStyle) sel.setStyle({ weight: 5, opacity: 1.0 });
            return sel;
        }

        /**
         * Clears all existing per-segment drag handles.
         * @param {Array<{index:number,handle:L.CircleMarker,off:Function}>} handles
         * @returns {void}
         */
        function clearSegmentHandles(handles) {
            (handles || []).forEach(function (h) {
                if (h.off) h.off();
                h.handle.remove();
            });
        }

        /**
         * Shows draggable midpoints for each segment with live smooth preview and returns the created handles.
         * @param {L.Map} mapInst
         * @param {L.Layer} layer
         * @param {number} samples
         * @param {number} alpha
         * @param {(geom:Array<[number,number]>, control:Array<[number,number]>, props:Object)=>Promise<void>} onCommit
         * @returns {Array<{index:number,handle:L.CircleMarker,off:Function}>}
         */
        function showSegmentHandles(mapInst, layer, samples, alpha, onCommit) {
            const res = [];
            if (!layer || !layer.feature || layer.feature.geometry.type !== "LineString") return res;

            const f = layer.feature;
            const control = (f.properties && Array.isArray(f.properties.control))
                ? f.properties.control.slice()
                : f.geometry.coordinates.slice();
            if (control.length < 2) return res;

            const segments = splitIntoSegments(control);
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const A = seg[0], B = seg[1];
                const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

                const handle = L.circleMarker([mid[1], mid[0]], {
                    radius: 6,
                    color: HANDLE_COLOR,
                    weight: 2,
                    fillColor: HANDLE_COLOR,
                    fillOpacity: 0.9,
                    pane: "markerPane",
                    bubblingMouseEvents: false
                }).addTo(mapInst);

                let dragging = false;
                let moveFn = null;
                let upFn = null;

                handle.on("mousedown", function () {
                    dragging = true;
                    mapInst.dragging.disable();
                });

                moveFn = function (e) {
                    if (!dragging) return;
                    handle.setLatLng(e.latlng);
                    const bend = [e.latlng.lng, e.latlng.lat];
                    const preview = replaceSegmentWithLocalCurve(control, i, bend, samples, alpha);
                    layer.setLatLngs(preview.map(function (c) { return [c[1], c[0]]; }));
                };

                upFn = async function () {
                    if (!dragging) return;
                    dragging = false;
                    mapInst.dragging.enable();
                    const bendLl = handle.getLatLng();
                    const bend = [bendLl.lng, bendLl.lat];
                    const newGeom = replaceSegmentWithLocalCurve(control, i, bend, samples, alpha);
                    const newControl = updateControlForSegment(control, i, bend);
                    await onCommit(newGeom, newControl, {});
                };

                mapInst.on("mousemove", moveFn);
                mapInst.on("mouseup", upFn);

                res.push({
                    index: i,
                    handle: handle,
                    off: function () {
                        mapInst.off("mousemove", moveFn);
                        mapInst.off("mouseup", upFn);
                    }
                });
            }
            return res;
        }

        /**
         * Updates the right-side context panel for the given walkway.
         * @param {L.Map} mapInst
         * @param {L.Layer} layer
         * @param {L.GeoJSON} wl
         * @param {(layer:L.Layer|null)=>void} setSel
         * @returns {void}
         */
        function updateWalkwayPanel(mapInst, layer, wl, setSel) {
            const f = layer.feature || {};
            const p = f.properties || {};
            const name = p.name || "(unnamed)";
            const id = p._id ? ("#" + p._id) : "";
            const isCurved = !!p.curved;

            let panel = document.getElementById("walkway-panel");
            if (!panel) {
                panel = document.createElement("div");
                panel.id = "walkway-panel";
                panel.style.position = "fixed";
                panel.style.top = "96px";
                panel.style.right = "16px";
                panel.style.width = "300px";
                panel.style.maxHeight = "calc(100vh - 120px)";
                panel.style.overflow = "auto";
                panel.style.background = "#fff";
                panel.style.border = "1px solid #e0e0e0";
                panel.style.borderRadius = "10px";
                panel.style.boxShadow = "0 6px 24px rgba(0,0,0,.12)";
                panel.style.zIndex = "1000";
                panel.style.padding = "12px";
                panel.style.fontFamily = "Lato, system-ui, sans-serif";
                document.body.appendChild(panel);
            }

            let editBar = document.getElementById("walkway-editbar");
            if (!editBar) {
                editBar = document.createElement("div");
                editBar.id = "walkway-editbar";
                editBar.style.position = "fixed";
                editBar.style.right = "16px";
                editBar.style.top = "56px";
                editBar.style.zIndex = "1001";
                editBar.style.display = "flex";
                editBar.style.gap = "8px";
                document.body.appendChild(editBar);
            }
            editBar.innerHTML = '<button id="wm-toggle" class="btn small" style="padding:.4rem .6rem">' + (editMode ? 'Exit Walkway Edit (X)' : 'Walkway Edit (X)') + '</button><button id="wm-delete" class="btn small" style="padding:.4rem .6rem;background:#ffe6e6;color:#8e001c;border:1px solid #ffd0d0" ' + (multiSelection.size ? '' : 'disabled') + '>Delete Selected (' + multiSelection.size + ')</button>';
            const tBtn = editBar.querySelector("#wm-toggle");
            const dBtn = editBar.querySelector("#wm-delete");
            if (tBtn) tBtn.onclick = toggleWalkwayEditMode;
            if (dBtn) dBtn.onclick = function () { deleteSelectedWalkways(walkwayLayer, multiSelection); };

            panel.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.25rem">' +
                '<strong style="font-size:14px">' + name + '</strong>' +
                '<small style="opacity:.7">' + id + '</small>' +
                '</div>' +
                '<div style="font-size:12px;opacity:.8;margin-bottom:.5rem">' + (isCurved ? "Curved segment" : "Straight segment") + '</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">' +
                '<button id="wp-rename" class="btn small" style="padding:.45rem .6rem">Rename</button>' +
                '<button id="wp-toggle" class="btn small" style="padding:.45rem .6rem">' + (isCurved ? "Uncurve" : "Curve") + '</button>' +
                '<button id="wp-edit" class="btn small" style="padding:.45rem .6rem">Edit shape</button>' +
                '<button id="wp-delete" class="btn small" style="padding:.45rem .6rem;background:#ffe6e6;color:#8e001c;border:1px solid #ffd0d0">Delete</button>' +
                '</div>' +
                '<div style="font-size:12px;padding:.5rem;border:1px dashed #ccc;border-radius:8px">Drag the red midpoints to preview live curves. Release to save.</div>';

            const rn = panel.querySelector("#wp-rename");
            if (rn) rn.addEventListener("click", async function () {
                const newName = prompt("Walkway name/code:", p.name || "");
                if (newName == null) return;
                const updated = { type: "Feature", geometry: f.geometry, properties: Object.assign({}, p, { name: newName, _id: p._id }) };
                const saved = await CR.saveWalkway(updated);
                layer.feature = saved;
                updateWalkwayPanel(mapInst, layer, wl, setSel);
            });

            const tg = panel.querySelector("#wp-toggle");
            if (tg) tg.addEventListener("click", async function () {
                if (p.curved) {
                    const control = (p.control && Array.isArray(p.control)) ? p.control : (f.geometry.coordinates || []);
                    const upd = { type: "Feature", geometry: { type: "LineString", coordinates: control }, properties: Object.assign({}, p, { curved: false, control: control, _id: p._id }) };
                    const saved = await CR.saveWalkway(upd);
                    layer.feature = saved;
                    layer.setLatLngs(control.map(function (c) { return [c[1], c[0]]; }));
                } else {
                    const control = (p.control && Array.isArray(p.control)) ? p.control : (f.geometry.coordinates || []);
                    const smooth = catmullRom(control, CURVE_SAMPLES, CURVE_ALPHA);
                    const upd = { type: "Feature", geometry: { type: "LineString", coordinates: smooth }, properties: Object.assign({}, p, { curved: true, control: control, _id: p._id }) };
                    const saved = await CR.saveWalkway(upd);
                    layer.feature = saved;
                    layer.setLatLngs(smooth.map(function (c) { return [c[1], c[0]]; }));
                }
                updateWalkwayPanel(mapInst, layer, wl, setSel);
            });

            const ed = panel.querySelector("#wp-edit");
            if (ed) ed.addEventListener("click", function () {
                new L.EditToolbar.Edit(mapInst, { featureGroup: wl }).enable();
            });

            const del = panel.querySelector("#wp-delete");
            if (del) del.addEventListener("click", async function () {
                if (!confirm("Delete this walkway segment?")) return;
                if (p._id) {
                    const ok = await CR.deleteWalkway(p._id);
                    if (ok) {
                        wl.removeLayer(layer);
                        panel.innerHTML = "<em style='opacity:.7'>Select a walkway segment…</em>";
                        setSel(null);
                    }
                }
            });
        }

        /**
         * Toggles walkway edit mode with drag-to-select rectangle and bulk actions.
         * @returns {void}
         */
        function toggleWalkwayEditMode() {
            editMode = !editMode;
            updateWalkwayPanel(map, selectedWalkwayLayer || { feature: { properties: {} } }, walkwayLayer, function () {});
            if (editMode) beginBoxSelect();
            else endBoxSelect();
        }

        /**
         * Begins box selection interaction and initializes handlers.
         * @returns {void}
         */
        function beginBoxSelect() {
            boxState = { start: null, rect: null, mask: null };
            map._container.style.cursor = "crosshair";
            map.on("mousedown", onBoxMouseDown);
        }

        /**
         * Ends box selection interaction and cleans up handlers and overlays.
         * @returns {void}
         */
        function endBoxSelect() {
            map._container.style.cursor = "";
            map.off("mousedown", onBoxMouseDown);
            map.off("mousemove", onBoxMouseMove);
            map.off("mouseup", onBoxMouseUp);
            if (boxState && boxState.rect) { boxState.rect.remove(); }
            if (boxState && boxState.mask) { boxState.mask.remove(); }
            boxState = null;
        }

        /**
         * Handles mousedown to start drawing the selection rectangle.
         * @param {MouseEvent} e
         * @returns {void}
         */
        function onBoxMouseDown(e) {
            if (!editMode) return;
            const latlng = map.mouseEventToLatLng(e.originalEvent || e);
            boxState.start = latlng;
            map.on("mousemove", onBoxMouseMove);
            map.on("mouseup", onBoxMouseUp);
        }

        /**
         * Handles mousemove to update the selection rectangle.
         * @param {MouseEvent} e
         * @returns {void}
         */
        function onBoxMouseMove(e) {
            if (!editMode || !boxState || !boxState.start) return;
            const ll = map.mouseEventToLatLng(e.originalEvent || e);
            const bounds = L.latLngBounds(boxState.start, ll);
            if (!boxState.rect) {
                boxState.rect = L.rectangle(bounds, { color: "#1976d2", weight: 1, fillColor: "#1976d2", fillOpacity: 0.1, interactive: false }).addTo(map);
            } else {
                boxState.rect.setBounds(bounds);
            }
        }

        /**
         * Handles mouseup to finalize selection and compute majority-in-box membership, updating bulk selection set and panel.
         * @returns {void}
         */
        function onBoxMouseUp() {
            if (!editMode || !boxState || !boxState.rect) return;
            const bounds = boxState.rect.getBounds();
            selectWalkwaysInRect(walkwayLayer, bounds, multiSelection);
            updateWalkwayPanel(map, selectedWalkwayLayer || { feature: { properties: {} } }, walkwayLayer, function () {});
            map.off("mousemove", onBoxMouseMove);
            map.off("mouseup", onBoxMouseUp);
            if (boxState.rect) { boxState.rect.remove(); boxState.rect = null; }
        }

        /**
         * Selects walkways whose majority length lies within the given bounds and toggles their highlight.
         * @param {L.GeoJSON} wl
         * @param {L.LatLngBounds} bounds
         * @param {Set<string>} selection
         * @returns {void}
         */
        function selectWalkwaysInRect(wl, bounds, selection) {
            const poly = turf.bboxPolygon([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
            wl.eachLayer(function (layer) {
                if (!layer.feature || layer.feature.geometry.type !== "LineString") return;
                const id = layer.feature.properties && layer.feature.properties._id;
                if (!id) return;
                const insideRatio = lengthInsideRect(layer.feature, poly);
                if (insideRatio >= 0.5) {
                    if (!selection.has(id)) {
                        selection.add(id);
                        if (layer.setStyle) layer.setStyle({ color: "#0e8", weight: 5, opacity: 1.0 });
                    } else {
                        selection.delete(id);
                        if (layer.setStyle) layer.setStyle({ color: "rgb(16,124,111)", weight: 3, opacity: 1.0 });
                    }
                }
            });
        }

        /**
         * Computes the ratio of a line's length that lies within a rectangle polygon.
         * @param {GeoJSON.Feature<GeoJSON.LineString>} feature
         * @param {GeoJSON.Feature<GeoJSON.Polygon>} rectPoly
         * @returns {number}
         */
        function lengthInsideRect(feature, rectPoly) {
            try {
                const line = feature;
                const clipped = turf.lineSplit(line, rectPoly);
                let inside = 0;
                for (let i = 0; i < clipped.features.length; i++) {
                    const seg = clipped.features[i];
                    const mid = seg.geometry.coordinates[Math.floor(seg.geometry.coordinates.length / 2)];
                    if (turf.booleanPointInPolygon(turf.point(mid), rectPoly)) {
                        inside += turf.length(seg, { units: "meters" });
                    }
                }
                const total = turf.length(line, { units: "meters" }) || 0.000001;
                return Math.min(1, Math.max(0, inside / total));
            } catch (_) {
                return 0;
            }
        }

        /**
         * Deletes all currently selected walkways and clears the selection set.
         * @param {L.GeoJSON} wl
         * @param {Set<string>} selection
         * @returns {Promise<void>}
         */
        async function deleteSelectedWalkways(wl, selection) {
            const ids = Array.from(selection);
            for (const id of ids) {
                await CR.deleteWalkway(id);
            }
            const toRemove = [];
            wl.eachLayer(function (l) {
                const id = l.feature && l.feature.properties && l.feature.properties._id;
                if (id && selection.has(id)) toRemove.push(l);
            });
            toRemove.forEach(function (l) { wl.removeLayer(l); });
            selection.clear();
            updateWalkwayPanel(map, selectedWalkwayLayer || { feature: { properties: {} } }, wl, function () {});
        }

        /**
         * Builds a node array used for snapping: walkway endpoints + entrances/exits.
         * @param {GeoJSON.Feature[]} walkways
         * @param {GeoJSON.Feature[]} features
         * @returns {Array<[number, number]>}
         */
        function buildNodeIndex(walkways, features) {
            var nodes = [];

            walkways.forEach(function (f) {
                if (f.geometry && f.geometry.type === "LineString") {
                    var coords = f.geometry.coordinates;
                    if (coords.length) {
                        nodes.push(coords[0]);
                        nodes.push(coords[coords.length - 1]);
                    }
                }
            });

            features.forEach(function (f) {
                if (!f.properties) return;
                if ((f.properties.type === "entrance" || f.properties.type === "exit") && f.geometry && f.geometry.type === "Point") {
                    nodes.push(f.geometry.coordinates);
                }
            });

            return nodes;
        }

        /**
         * Snaps a line's endpoints to nearest existing node if within threshold.
         * @param {L.Map} mapInst
         * @param {GeoJSON.Feature} line
         * @param {Array<[number,number]>} nodes
         * @param {number} meters
         * @returns {GeoJSON.Feature}
         */
        function snapLineEndpoints(mapInst, line, nodes, meters) {
            if (!line.geometry || line.geometry.type !== "LineString") return line;
            var coords = line.geometry.coordinates.slice();
            if (coords.length < 2) return line;

            coords[0] = snapCoord(mapInst, coords[0], nodes, meters);
            coords[coords.length - 1] = snapCoord(mapInst, coords[coords.length - 1], nodes, meters);

            return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: line.properties || {} };
        }

        /**
         * Snaps a single [lng,lat] coordinate to the nearest node within meters.
         * @param {L.Map} mapInst
         * @param {[number,number]} coord
         * @param {Array<[number,number]>} nodes
         * @param {number} meters
         * @returns {[number,number]}
         */
        function snapCoord(mapInst, coord, nodes, meters) {
            var p = L.latLng(coord[1], coord[0]);
            var best = null;
            for (var i = 0; i < nodes.length; i++) {
                var q = L.latLng(nodes[i][1], nodes[i][0]);
                var d = mapInst.distance(p, q);
                if (d <= meters && (!best || d < best.d)) best = { d: d, c: nodes[i] };
            }
            return best ? best.c : coord;
        }

        /**
         * Splits a polyline coordinate array into consecutive 2-point segments.
         * @param {Array<[number,number]>} coords
         * @returns {Array<Array<[number,number]>>}
         */
        function splitIntoSegments(coords) {
            const segs = [];
            for (let i = 0; i < coords.length - 1; i++) segs.push([coords[i], coords[i + 1]]);
            return segs;
        }

        /**
         * Replaces a single segment [A,B] with a smooth local curve defined by [A,bend,B] and returns the full polyline.
         * @param {Array<[number,number]>} coords
         * @param {number} segIndex
         * @param {[number,number]} bend
         * @param {number} samples
         * @param {number} alpha
         * @returns {Array<[number,number]>}
         */
        function replaceSegmentWithLocalCurve(coords, segIndex, bend, samples, alpha) {
            const out = [];
            for (let i = 0; i < coords.length - 1; i++) {
                const A = coords[i], B = coords[i + 1];
                if (i === segIndex) {
                    const local = [A, bend, B];
                    const smooth = catmullRom(local, samples, alpha);
                    if (out.length === 0) out.push(smooth[0]);
                    for (let k = 1; k < smooth.length; k++) out.push(smooth[k]);
                } else {
                    if (out.length === 0) out.push(A);
                    out.push(B);
                }
            }
            return out;
        }

        /**
         * Updates the control array to reflect a bend inserted into one segment.
         * @param {Array<[number,number]>} coords
         * @param {number} segIndex
         * @param {[number,number]} bend
         * @returns {Array<[number,number]>}
         */
        function updateControlForSegment(coords, segIndex, bend) {
            const out = [];
            for (let i = 0; i < coords.length - 1; i++) {
                const A = coords[i], B = coords[i + 1];
                if (i === segIndex) {
                    if (out.length === 0) out.push(A);
                    out.push(bend);
                    out.push(B);
                } else {
                    if (out.length === 0) out.push(A);
                    out.push(B);
                }
            }
            return out;
        }

        /**
         * Catmull–Rom spline through control points returning a densified polyline.
         * @param {Array<[number,number]>} pts
         * @param {number} samples
         * @param {number} alpha
         * @returns {Array<[number,number]>}
         */
        function catmullRom(pts, samples, alpha) {
            if (!Array.isArray(pts) || pts.length < 2) return pts || [];
            const result = [];
            const a = Math.max(0, Math.min(1, alpha || 0.5));
            const s = Math.max(2, samples || 8);

            function tj(ti, pi, pj) {
                if (!pi || !pj) return ti;
                const dx = (pj[0] - pi[0]) || 0, dy = (pj[1] - pi[1]) || 0;
                const d = Math.sqrt(dx * dx + dy * dy);
                return Math.pow(d, a) + ti;
            }

            const p = [];
            p.push(pts[0]);
            for (let i = 0; i < pts.length; i++) p.push(pts[i]);
            p.push(pts[pts.length - 1]);

            for (let i = 0; i < p.length - 3; i++) {
                const p0 = p[i], p1 = p[i + 1], p2 = p[i + 2], p3 = p[i + 3];
                let t0 = 0;
                let t1 = tj(t0, p0, p1);
                let t2 = tj(t1, p1, p2);
                let t3 = tj(t2, p2, p3);

                for (let t = t1; t < t2; t += (t2 - t1) / s) {
                    const A1 = lerpPoint(p0, p1, (t1 - t) / (t1 - t0));
                    const A2 = lerpPoint(p1, p2, (t2 - t) / (t2 - t1));
                    const A3 = lerpPoint(p2, p3, (t3 - t) / (t3 - t2));
                    const B1 = lerpPoint(A1, A2, (t2 - t) / (t2 - t0));
                    const B2 = lerpPoint(A2, A3, (t3 - t) / (t3 - t1));
                    const C = lerpPoint(B1, B2, (t2 - t) / (t2 - t1));
                    if (Number.isFinite(C[0]) && Number.isFinite(C[1])) result.push(C);
                }
            }
            result.push(pts[pts.length - 1]);
            return result;
        }

        /**
         * Linear interpolation between two points with weight.
         * @param {[number,number]} a
         * @param {[number,number]} b
         * @param {number} w
         * @returns {[number,number]}
         */
        function lerpPoint(a, b, w) {
            const ww = Math.max(0, Math.min(1, 1 - (w || 0)));
            const ax = a ? a[0] : 0, ay = a ? a[1] : 0, bx = b ? b[0] : 0, by = b ? b[1] : 0;
            return [ax + (bx - ax) * ww, ay + (by - ay) * ww];
        }
    }

    /**
     * Sanitizes a FeatureCollection of walkways to remove degenerate or out-of-bounds coordinates.
     * @param {GeoJSON.FeatureCollection} fc
     * @returns {GeoJSON.FeatureCollection}
     */
    function sanitizeFeatureCollection(fc) {
        const out = { type: "FeatureCollection", features: [] };
        const feats = (fc && fc.features) || [];
        for (let i = 0; i < feats.length; i++) {
            const clean = sanitizeWalkwayFeature(feats[i]);
            if (clean) out.features.push(clean);
        }
        return out;
    }

    /**
     * Sanitizes a single walkway feature by dropping invalid points and clamping lat/lng to world extents.
     * @param {GeoJSON.Feature} f
     * @returns {GeoJSON.Feature|null}
     */
    function sanitizeWalkwayFeature(f) {
        if (!f || !f.geometry || f.geometry.type !== "LineString") return null;
        const coords = Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
        const cleaned = [];
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i] || [];
            let lng = Number(c[0]), lat = Number(c[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue;
            cleaned.push([lng, lat]);
        }
        if (cleaned.length < 2) return null;
        return {
            type: "Feature",
            geometry: { type: "LineString", coordinates: cleaned },
            properties: Object.assign({}, f.properties || {}, { control: (f.properties && f.properties.control) || cleaned.slice() })
        };
    }

    /**
     * Generates an automatic entrance name and association.
     * @param {GeoJSON.Feature} entrancePoint
     * @param {GeoJSON.Feature[]} allFeatures
     * @returns {{ suggestedName: string, buildingId?: string, direction?: string }}
     */
    function autoNameEntrance(entrancePoint, allFeatures) {
        var buildings = allFeatures.filter(function (f) { return f.properties && f.properties.type === "building" && f.geometry && f.geometry.type === "Polygon"; });

        var best = findBuildingForPoint(entrancePoint, buildings);
        var building = best && best.building;
        var buildingId = building && building.properties && building.properties._id;
        var prefix = building && building.properties && building.properties.prefix
            ? String(building.properties.prefix).toUpperCase()
            : (building && building.properties && building.properties.name ? acronym(building.properties.name) : "BLD");

        var dir = building ? directionFrom(building, entrancePoint) : "N";
        var index = nextEntranceIndex(prefix, dir, buildingId, allFeatures);
        var suggested = prefix + "-" + dir + String(index);

        return { suggestedName: suggested, buildingId: buildingId, direction: dir };
    }

    /**
     * Finds building containing or nearest to point.
     * @param {GeoJSON.Feature} pt
     * @param {GeoJSON.Feature[]} buildings
     * @returns {{ building: GeoJSON.Feature, distance: number }|null}
     */
    function findBuildingForPoint(pt, buildings) {
        var inside = null;
        for (var i = 0; i < buildings.length; i++) {
            try { if (turf.booleanPointInPolygon(pt, buildings[i])) { inside = { building: buildings[i], distance: 0 }; break; } }
            catch (_) {}
        }
        if (inside) return inside;

        var best = null;
        for (var j = 0; j < buildings.length; j++) {
            try {
                var dist = turf.pointToLineDistance(pt, turf.polygonToLine(buildings[j]), { units: "meters" });
                if (!best || dist < best.distance) best = { building: buildings[j], distance: dist };
            } catch (_) {
                try {
                    var c = turf.centerOfMass(buildings[j]);
                    var d2 = turf.distance(pt, c, { units: "meters" });
                    if (!best || d2 < best.distance) best = { building: buildings[j], distance: d2 };
                } catch(__) {}
            }
        }
        return best;
    }

    /**
     * Computes 8-way direction from building centroid to a point.
     * @param {GeoJSON.Feature} buildingPolygon
     * @param {GeoJSON.Feature} point
     * @returns {"N"|"NE"|"E"|"SE"|"S"|"SW"|"W"|"NW"}
     */
    function directionFrom(buildingPolygon, point) {
        try {
            var c = turf.centerOfMass(buildingPolygon);
            var brg = turf.bearing(c, point);
            var b = ((brg % 360) + 360) % 360;
            if (b >= 337.5 || b < 22.5) return "N";
            if (b < 67.5) return "NE";
            if (b < 112.5) return "E";
            if (b < 157.5) return "SE";
            if (b < 202.5) return "S";
            if (b < 247.5) return "SW";
            if (b < 292.5) return "W";
            return "NW";
        } catch (_) { return "N"; }
    }

    /**
     * Creates an acronym from building name.
     * @param {string} name
     * @returns {string}
     */
    function acronym(name) {
        var words = String(name).trim().split(/\s+/).filter(Boolean);
        if (words.length === 1) {
            var w = words[0].toUpperCase();
            return (w[0] || "B") + (w[1] || "L");
        }
        var letters = words.map(function (w) { return w[0]; }).join("").toUpperCase();
        return letters.slice(0, 3);
    }

    /**
     * Gets next available index for prefix+direction within a building.
     * @param {string} prefix
     * @param {string} direction
     * @param {string|undefined} buildingId
     * @param {GeoJSON.Feature[]} features
     * @returns {number}
     */
    function nextEntranceIndex(prefix, direction, buildingId, features) {
        var entrances = features.filter(function (f) {
            if (!f.properties || f.properties.type !== "entrance") return false;
            if (buildingId && f.properties.buildingId !== buildingId) return false;
            var name = f.properties.name || "";
            var dir = f.properties.direction || inferDirectionFromName(name);
            var pre = inferPrefixFromName(name);
            return dir === direction && pre === prefix;
        });
        var used = {};
        entrances.forEach(function (f) {
            var n = extractIndex(f.properties.name || "");
            if (n) used[n] = true;
        });
        var idx = 1;
        while (used[idx]) idx += 1;
        return idx;
    }

    /**
     * Extracts prefix from names like "HU-N3".
     * @param {string} name
     * @returns {string|undefined}
     */
    function inferPrefixFromName(name) {
        var m = String(name).match(/^([A-Z0-9]+)-/i);
        return m ? m[1].toUpperCase() : undefined;
    }

    /**
     * Extracts direction from names like "HU-N3".
     * @param {string} name
     * @returns {string|undefined}
     */
    function inferDirectionFromName(name) {
        var m = String(name).match(/-([NSEW]{1,2})\d*$/i);
        return m ? m[1].toUpperCase() : undefined;
    }

    /**
     * Extracts trailing numeric index.
     * @param {string} name
     * @returns {number|undefined}
     */
    function extractIndex(name) {
        var m = String(name).match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : undefined;
    }

    window.CR = window.CR || {};
    window.CR.bootAdmin = bootAdmin;
})();
