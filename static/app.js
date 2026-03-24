/* ══════════════════════════════════════════════════════════════
   GeoJSON Viewer — app.js
   ══════════════════════════════════════════════════════════════ */

'use strict';

// ── Basemap styles ────────────────────────────────────────────
const BASEMAPS = {
  dark:      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light:     'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  streets:   'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  satellite: {
    version: 8,
    sources: {
      sat: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxzoom: 19,
      },
    },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  },
};

// ── Layer color palette ───────────────────────────────────────
const COLORS = [
  '#388bfd', '#f85149', '#3fb950', '#e3b341',
  '#bc8cff', '#39d0d8', '#ff7b72', '#7ee787',
  '#ffa657', '#d2a8ff',
];

// ── Application state ─────────────────────────────────────────
let map;
const tooltip = { popup: null };

const state = {
  layers:       new Map(),   // layerId → layer object
  nextLayerId:  0,
  colorIndex:   0,
  basemap:      'dark',
  draw: {
    mode:     'select',      // 'select' | 'point' | 'line' | 'polygon'
    vertices: [],            // coords for in-progress geometry
    features: [],            // completed GeoJSON features
    drawCount: 0,
  },
};

/* ── Layer schema ─────────────────────────────────────────────
 * { id, name, color, visible, featureCount, geojson, meta }
 * meta: { total, shown, sampled, load_time_s, file_size_mb } | null
 */

// ═════════════════════════════════════════════════════════════
// Init
// ═════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupTabs();
  setupDragDrop();
  setupFileInput();
  setupPathLoad();
  setupBasemapSwitcher();
  setupInspectorClose();
  setupLayerActions();
  setupDrawTools();
  loadDataFiles();
});

// ═════════════════════════════════════════════════════════════
// Map
// ═════════════════════════════════════════════════════════════

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style:     BASEMAPS.dark,
    center:    [0, 20],
    zoom:      2,
    attributionControl: false,
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  tooltip.popup = new maplibregl.Popup({
    closeButton:    false,
    closeOnClick:   false,
    offset:         [0, -4],
    anchor:         'bottom',
    className:      'feature-tooltip',
  });

  map.on('load', () => {
    initDrawSources();
    bindMapEvents();
  });

  map.on('zoom', () => {
    document.getElementById('status-zoom').textContent =
      'Zoom: ' + map.getZoom().toFixed(1);
  });
}

function bindMapEvents() {
  map.on('mousemove', onMouseMove);
  map.on('click',     onMapClick);

  // Draw click handler
  map.on('click', onDrawClick);
  map.on('dblclick', onDrawDblClick);

  map.getCanvas().addEventListener('contextmenu', e => {
    if (state.draw.mode !== 'select') {
      e.preventDefault();
      cancelDrawing();
    }
  });
}

// ═════════════════════════════════════════════════════════════
// Tab navigation
// ═════════════════════════════════════════════════════════════

function setupTabs() {
  const btns   = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      btns.forEach(b   => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });
}

// ═════════════════════════════════════════════════════════════
// File loading
// ═════════════════════════════════════════════════════════════

function setupDragDrop() {
  const dropzone = document.getElementById('dropzone');

  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    [...e.dataTransfer.files].forEach(handleFile);
  });

  // Allow dropping onto the map area too
  const mapWrap = document.getElementById('map-wrap');
  mapWrap.addEventListener('dragover', e => e.preventDefault());
  mapWrap.addEventListener('drop', e => {
    e.preventDefault();
    [...e.dataTransfer.files].forEach(handleFile);
  });
}

function setupFileInput() {
  const input = document.getElementById('file-input');
  input.addEventListener('change', () => {
    [...input.files].forEach(handleFile);
    input.value = '';
  });
}

async function handleFile(file) {
  if (!file.name.match(/\.(geojson|json)$/i)) {
    notify(`"${file.name}" doesn't look like a GeoJSON file`, 'warning');
    return;
  }

  const sizeMB = file.size / 1e6;
  if (sizeMB > 150) {
    notify(
      `"${file.name}" is ${sizeMB.toFixed(0)} MB — for files this large, use "Load from path" for server-side sampling.`,
      'warning'
    );
  }

  setLoading(true, `Reading ${file.name}…`);
  try {
    const text = await readText(file);
    const json = JSON.parse(text);
    const name = file.name.replace(/\.(geojson|json)$/i, '');
    processGeoJSON(name, json, null);
  } catch (err) {
    notify(`Failed to parse "${file.name}": ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function readText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('File read error'));
    r.readAsText(file);
  });
}

// ── Server-side load (for large files) ────────────────────────

function setupPathLoad() {
  const btn       = document.getElementById('btn-path-load');
  const pathInput = document.getElementById('path-input');

  btn.addEventListener('click', triggerPathLoad);
  pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') triggerPathLoad(); });
}

function triggerPathLoad() {
  const path = document.getElementById('path-input').value.trim();
  const max  = parseInt(document.getElementById('max-features').value) || 100_000;

  if (!path) { notify('Enter a file path first', 'warning'); return; }
  loadFromServer(path, max);
}

async function loadFromServer(filePath, maxFeatures) {
  setLoading(true, 'Loading from server…');
  try {
    const url  = `/api/load?file=${encodeURIComponent(filePath)}&max=${maxFeatures}`;
    const res  = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data  = await res.json();
    const meta  = data._meta || null;
    delete data._meta;
    const name  = filePath.split(/[\\/]/).pop().replace(/\.(geojson|json)$/i, '');
    processGeoJSON(name, data, meta);
  } catch (err) {
    notify(`Server load failed: ${err.message}. Is server.py running?`, 'error');
  } finally {
    setLoading(false);
  }
}

// ── Data folder list ──────────────────────────────────────────

async function loadDataFiles() {
  try {
    const res   = await fetch('/api/files');
    if (!res.ok) return;
    const files = await res.json();
    renderDataFiles(files);
  } catch { /* server not running — that's OK */ }
}

function renderDataFiles(files) {
  const el = document.getElementById('data-files');
  if (!files.length) {
    el.innerHTML = '<div class="empty-state small">No .geojson files in data/ folder</div>';
    return;
  }
  el.innerHTML = files.map(f => `
    <div class="data-file" data-path="${esc(f.path)}" title="${esc(f.path)}">
      <svg class="data-file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="data-file-name">${esc(f.name)}</span>
      <span class="data-file-size">${fmtBytes(f.size)}</span>
    </div>
  `).join('');

  el.querySelectorAll('.data-file').forEach(div => {
    div.addEventListener('click', () => {
      const max = parseInt(document.getElementById('max-features').value) || 100_000;
      loadFromServer(div.dataset.path, max);
    });
  });
}

// ═════════════════════════════════════════════════════════════
// GeoJSON processing
// ═════════════════════════════════════════════════════════════

function processGeoJSON(name, data, meta) {
  let fc;
  if (data.type === 'FeatureCollection') {
    fc = data;
  } else if (data.type === 'Feature') {
    fc = { type: 'FeatureCollection', features: [data] };
  } else if (data.coordinates) {
    fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: data, properties: {} }] };
  } else {
    notify('Unrecognised GeoJSON format', 'error');
    return;
  }

  fc.features = (fc.features || []).filter(f => f && f.geometry);

  if (!fc.features.length) {
    notify(`"${name}" has no renderable features`, 'warning');
    return;
  }

  addLayer(name, fc, meta);
}

// ═════════════════════════════════════════════════════════════
// Layer management
// ═════════════════════════════════════════════════════════════

function nextColor() {
  const c = COLORS[state.colorIndex % COLORS.length];
  state.colorIndex++;
  return c;
}

function addLayer(name, geojson, meta) {
  const id    = state.nextLayerId++;
  const color = nextColor();

  const layer = { id, name, color, visible: true, featureCount: geojson.features.length, geojson, meta };
  state.layers.set(id, layer);

  const src = `src-${id}`;
  map.addSource(src, { type: 'geojson', data: geojson, generateId: true });

  // Polygon fill
  map.addLayer({
    id:     `lyr-${id}-fill`,
    type:   'fill',
    source: src,
    filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    paint:  { 'fill-color': color, 'fill-opacity': .35 },
  });

  // Polygon + MultiPolygon outline
  map.addLayer({
    id:     `lyr-${id}-outline`,
    type:   'line',
    source: src,
    filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    paint:  { 'line-color': color, 'line-width': 1.5, 'line-opacity': .8 },
  });

  // Lines
  map.addLayer({
    id:     `lyr-${id}-line`,
    type:   'line',
    source: src,
    filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    paint:  { 'line-color': color, 'line-width': 2, 'line-opacity': .9 },
  });

  // Points
  map.addLayer({
    id:     `lyr-${id}-point`,
    type:   'circle',
    source: src,
    filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
    paint:  {
      'circle-color':        color,
      'circle-radius':       5,
      'circle-opacity':      .9,
      'circle-stroke-color': 'rgba(255,255,255,.6)',
      'circle-stroke-width': 1,
    },
  });

  zoomToLayer(id, false);
  renderLayerList();
  updateStatusBar();

  // Switch to layers tab
  document.querySelector('[data-tab="layers"]').click();

  const metaMsg = meta?.sampled
    ? ` (sampled ${fmtN(meta.shown)} of ${fmtN(meta.total)})`
    : '';
  const timeMsg = meta?.load_time_s ? ` in ${meta.load_time_s}s` : '';
  notify(`Loaded "${name}" — ${fmtN(layer.featureCount)} features${metaMsg}${timeMsg}`, 'success');
}

function removeLayer(id) {
  if (!state.layers.has(id)) return;
  ['fill', 'outline', 'line', 'point'].forEach(t => {
    if (map.getLayer(`lyr-${id}-${t}`)) map.removeLayer(`lyr-${id}-${t}`);
  });
  if (map.getSource(`src-${id}`)) map.removeSource(`src-${id}`);
  state.layers.delete(id);
  renderLayerList();
  updateStatusBar();
}

function toggleVisibility(id, visible) {
  const layer = state.layers.get(id);
  if (!layer) return;
  layer.visible = visible;
  const v = visible ? 'visible' : 'none';
  ['fill', 'outline', 'line', 'point'].forEach(t => {
    const lid = `lyr-${id}-${t}`;
    if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', v);
  });
  renderLayerList();
}

function setColor(id, color) {
  const layer = state.layers.get(id);
  if (!layer) return;
  layer.color = color;
  if (map.getLayer(`lyr-${id}-fill`)) {
    map.setPaintProperty(`lyr-${id}-fill`,    'fill-color',   color);
    map.setPaintProperty(`lyr-${id}-outline`, 'line-color',   color);
    map.setPaintProperty(`lyr-${id}-line`,    'line-color',   color);
    map.setPaintProperty(`lyr-${id}-point`,   'circle-color', color);
  }
  renderLayerList();
}

function zoomToLayer(id, animate = true) {
  const layer = state.layers.get(id);
  if (!layer) return;
  const bounds = geoBounds(layer.geojson);
  if (bounds) map.fitBounds(bounds, { padding: 50, duration: animate ? 900 : 0, maxZoom: 18 });
}

function zoomToAll() {
  if (!state.layers.size) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.layers.forEach(l => {
    const b = geoBounds(l.geojson);
    if (!b) return;
    minX = Math.min(minX, b[0][0]); minY = Math.min(minY, b[0][1]);
    maxX = Math.max(maxX, b[1][0]); maxY = Math.max(maxY, b[1][1]);
  });
  if (isFinite(minX)) map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 50, duration: 900 });
}

function clearAllLayers() {
  [...state.layers.keys()].forEach(removeLayer);
  closeInspector();
}

function geoBounds(geojson) {
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  function walk(c) {
    if (typeof c[0] === 'number') {
      mnX = Math.min(mnX, c[0]); mnY = Math.min(mnY, c[1]);
      mxX = Math.max(mxX, c[0]); mxY = Math.max(mxY, c[1]);
    } else c.forEach(walk);
  }
  geojson.features.forEach(f => { if (f.geometry?.coordinates) walk(f.geometry.coordinates); });
  return isFinite(mnX) ? [[mnX, mnY], [mxX, mxY]] : null;
}

// ═════════════════════════════════════════════════════════════
// Layer list UI
// ═════════════════════════════════════════════════════════════

function renderLayerList() {
  const el = document.getElementById('layer-list');

  if (!state.layers.size) {
    el.innerHTML = '<div class="empty-state">No layers loaded.<br>Load a GeoJSON file to begin.</div>';
    return;
  }

  const eyeOn  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const eyeOff = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  const zoomSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  const delSvg  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  el.innerHTML = [...state.layers.values()].reverse().map(l => `
    <div class="layer-item ${l.visible ? '' : 'hidden-layer'}" data-id="${l.id}">
      <div class="layer-color-swatch" style="background:${l.color}" title="Click to change color">
        <input type="color" value="${l.color}" data-id="${l.id}">
      </div>
      <span class="layer-name" title="${esc(l.name)}">${esc(l.name)}</span>
      <span class="layer-count">${fmtN(l.featureCount)}</span>
      <div class="layer-actions">
        <button class="icon-btn vis-btn" data-id="${l.id}" title="${l.visible ? 'Hide' : 'Show'}">${l.visible ? eyeOn : eyeOff}</button>
        <button class="icon-btn zoom-btn" data-id="${l.id}" title="Zoom to layer">${zoomSvg}</button>
        <button class="icon-btn danger del-btn" data-id="${l.id}" title="Remove layer">${delSvg}</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('input[type="color"]').forEach(inp => {
    inp.addEventListener('input',  e => setColor(+e.target.dataset.id, e.target.value));
  });
  el.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = +btn.dataset.id;
      toggleVisibility(id, !state.layers.get(id).visible);
    });
  });
  el.querySelectorAll('.zoom-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); zoomToLayer(+btn.dataset.id); });
  });
  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); removeLayer(+btn.dataset.id); });
  });
}

function setupLayerActions() {
  document.getElementById('btn-zoom-all').addEventListener('click', zoomToAll);
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (!state.layers.size) return;
    if (confirm('Remove all layers?')) clearAllLayers();
  });
  document.getElementById('btn-refresh-files').addEventListener('click', loadDataFiles);
}

// ═════════════════════════════════════════════════════════════
// Feature inspection
// ═════════════════════════════════════════════════════════════

function setupInspectorClose() {
  document.getElementById('btn-close-inspector').addEventListener('click', closeInspector);
}

function closeInspector() {
  document.getElementById('inspector').classList.remove('open');
}

function openInspector(feature) {
  const props   = feature.properties || {};
  const geomType = feature.geometry?.type || 'Unknown';
  const srcId    = feature.source || '';
  const lyrId    = +srcId.replace('src-', '');
  const layer    = state.layers.get(lyrId);
  const layerName = layer ? layer.name : '?';

  document.getElementById('inspector-meta').innerHTML = `
    <span class="badge badge-layer">${esc(layerName)}</span>
    <span class="badge badge-geom">${esc(geomType)}</span>
  `;

  const keys = Object.keys(props);
  if (!keys.length) {
    document.getElementById('inspector-body').innerHTML =
      '<div class="empty-state">No properties on this feature</div>';
  } else {
    const rows = keys.map(k => {
      const raw = props[k];
      let display;
      if (raw === null)                   display = '<span class="null">null</span>';
      else if (typeof raw === 'object')   display = `<code>${esc(JSON.stringify(raw))}</code>`;
      else if (isURL(String(raw)))        display = `<a href="${esc(String(raw))}" target="_blank" rel="noopener">${esc(String(raw))}</a>`;
      else                               display = esc(String(raw));

      return `<tr><td class="prop-key" title="${esc(k)}">${esc(k)}</td><td class="prop-val">${display}</td></tr>`;
    }).join('');

    document.getElementById('inspector-body').innerHTML =
      `<table class="prop-table">${rows}</table>`;
  }

  document.getElementById('inspector').classList.add('open');
}

// ═════════════════════════════════════════════════════════════
// Map events
// ═════════════════════════════════════════════════════════════

function getInteractiveLayers() {
  const ids = [];
  state.layers.forEach((l, id) => {
    if (!l.visible) return;
    ['fill', 'line', 'point'].forEach(t => {
      const lid = `lyr-${id}-${t}`;
      if (map.getLayer(lid)) ids.push(lid);
    });
  });
  return ids;
}

function onMouseMove(e) {
  // Update coordinate display
  const { lng, lat } = e.lngLat;
  document.getElementById('status-coords').textContent =
    `${lng.toFixed(5)}, ${lat.toFixed(5)}`;

  if (state.draw.mode !== 'select') {
    map.getCanvas().style.cursor = 'crosshair';
    return;
  }

  // Hover interaction
  const lids = getInteractiveLayers();
  if (!lids.length) {
    map.getCanvas().style.cursor = '';
    tooltip.popup.remove();
    return;
  }

  const features = map.queryRenderedFeatures(e.point, { layers: lids });
  if (!features.length) {
    map.getCanvas().style.cursor = '';
    tooltip.popup.remove();
    return;
  }

  map.getCanvas().style.cursor = 'pointer';

  // Show tooltip with first meaningful property value
  const props = features[0].properties || {};
  const keys  = Object.keys(props);
  const label = keys.length ? getTooltipLabel(props) : null;

  if (label) {
    tooltip.popup
      .setLngLat(e.lngLat)
      .setHTML(label)
      .addTo(map);
  } else {
    tooltip.popup.remove();
  }
}

function getTooltipLabel(props) {
  const priority = ['name', 'NAME', 'label', 'LABEL', 'title', 'TITLE', 'id', 'ID', 'fid'];
  for (const k of priority) {
    if (props[k] != null) return `<span class="tooltip-prop">${esc(k)}</span> <span class="tooltip-val">${esc(String(props[k]))}</span>`;
  }
  const k = Object.keys(props)[0];
  const v = props[k];
  if (v == null) return null;
  const str = String(v);
  if (str.length > 60) return null;
  return `<span class="tooltip-prop">${esc(k)}</span> <span class="tooltip-val">${esc(str)}</span>`;
}

function onMapClick(e) {
  if (state.draw.mode !== 'select') return;

  const lids = getInteractiveLayers();
  if (!lids.length) return;

  const features = map.queryRenderedFeatures(e.point, { layers: lids });
  if (!features.length) {
    closeInspector();
    return;
  }
  openInspector(features[0]);
}

// ═════════════════════════════════════════════════════════════
// Draw tools
// ═════════════════════════════════════════════════════════════

const DRAW_SRC    = '_draw';
const DRAW_PREV   = '_draw_preview';

function initDrawSources() {
  map.addSource(DRAW_SRC, { type: 'geojson', data: emptyFC() });
  map.addSource(DRAW_PREV, { type: 'geojson', data: emptyFC() });

  // Completed drawn features
  map.addLayer({ id: 'draw-fill',    type: 'fill',   source: DRAW_SRC,  filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], paint: { 'fill-color': '#388bfd', 'fill-opacity': .25 } });
  map.addLayer({ id: 'draw-outline', type: 'line',   source: DRAW_SRC,  filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], paint: { 'line-color': '#388bfd', 'line-width': 2 } });
  map.addLayer({ id: 'draw-line',    type: 'line',   source: DRAW_SRC,  filter: ['match', ['geometry-type'], ['LineString'], true, false], paint: { 'line-color': '#388bfd', 'line-width': 2 } });
  map.addLayer({ id: 'draw-point',   type: 'circle', source: DRAW_SRC,  filter: ['match', ['geometry-type'], ['Point'], true, false], paint: { 'circle-color': '#388bfd', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });

  // Preview (in-progress) — dashed
  map.addLayer({ id: 'prev-line',    type: 'line',   source: DRAW_PREV, paint: { 'line-color': '#e3b341', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'prev-point',   type: 'circle', source: DRAW_PREV, filter: ['match', ['geometry-type'], ['Point'], true, false], paint: { 'circle-color': '#e3b341', 'circle-radius': 5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
}

function setupDrawTools() {
  document.querySelectorAll('.draw-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setDrawMode(btn.dataset.mode));
  });

  document.getElementById('btn-export-draw').addEventListener('click', exportDrawn);
  document.getElementById('btn-add-draw-as-layer').addEventListener('click', addDrawnAsLayer);
  document.getElementById('btn-clear-draw').addEventListener('click', () => {
    if (!state.draw.features.length && !state.draw.vertices.length) return;
    if (confirm('Clear all drawn features?')) clearDrawn();
  });
  document.getElementById('btn-undo-draw').addEventListener('click', undoLastDraw);
}

function setDrawMode(mode) {
  cancelDrawing();
  state.draw.mode = mode;

  document.querySelectorAll('.draw-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  map.getCanvas().style.cursor = mode === 'select' ? '' : 'crosshair';

  const hints = {
    select:  'Click features to inspect properties',
    point:   'Click to place a point',
    line:    'Click to add vertices · Double-click to finish · Right-click to cancel',
    polygon: 'Click to add vertices · Double-click to close · Right-click to cancel',
  };
  document.getElementById('draw-hint').textContent = hints[mode] || '';
}

function onDrawClick(e) {
  const mode = state.draw.mode;
  if (mode === 'select') return;
  if (mode === 'point') {
    finishPoint(e.lngLat);
    return;
  }
  // line / polygon: add vertex
  state.draw.vertices.push([e.lngLat.lng, e.lngLat.lat]);
  updateDrawPreview(e.lngLat);
}

function onDrawDblClick(e) {
  const mode = state.draw.mode;
  if (mode === 'select') return;
  e.preventDefault();

  if (mode === 'line')    finishLine();
  if (mode === 'polygon') finishPolygon();
}

function finishPoint(lngLat) {
  const feat = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
    properties: { drawn: true, id: state.draw.drawCount++ },
  };
  state.draw.features.push(feat);
  refreshDrawSource();
  updateDrawCount();
  updateDrawPreview();
}

function finishLine() {
  const verts = state.draw.vertices;
  if (verts.length < 2) { cancelDrawing(); return; }
  const feat = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [...verts] },
    properties: { drawn: true, id: state.draw.drawCount++ },
  };
  state.draw.features.push(feat);
  state.draw.vertices = [];
  refreshDrawSource();
  clearDrawPreview();
  updateDrawCount();
}

function finishPolygon() {
  const verts = state.draw.vertices;
  if (verts.length < 3) { cancelDrawing(); return; }
  const ring = [...verts, verts[0]]; // close the ring
  const feat = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { drawn: true, id: state.draw.drawCount++ },
  };
  state.draw.features.push(feat);
  state.draw.vertices = [];
  refreshDrawSource();
  clearDrawPreview();
  updateDrawCount();
}

function cancelDrawing() {
  state.draw.vertices = [];
  clearDrawPreview();
}

function updateDrawPreview(cursorLngLat) {
  const verts = state.draw.vertices;
  const mode  = state.draw.mode;

  if (!verts.length) { clearDrawPreview(); return; }

  let previewCoords = [...verts];
  if (cursorLngLat) previewCoords.push([cursorLngLat.lng, cursorLngLat.lat]);

  // Add cursor tracking on mousemove when drawing
  if (!map._drawMouseHandler) {
    map._drawMouseHandler = mv => {
      if (state.draw.mode === 'select' || !state.draw.vertices.length) return;
      updateDrawPreview(mv.lngLat);
    };
    map.on('mousemove', map._drawMouseHandler);
  }

  const features = [];

  // Vertex points
  verts.forEach(c => {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} });
  });

  // Line preview
  if (previewCoords.length >= 2) {
    let coords = previewCoords;
    if (mode === 'polygon' && previewCoords.length >= 3) {
      coords = [...previewCoords, previewCoords[0]];
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
  }

  map.getSource(DRAW_PREV).setData({ type: 'FeatureCollection', features });
}

function clearDrawPreview() {
  if (map.getSource(DRAW_PREV)) map.getSource(DRAW_PREV).setData(emptyFC());
  if (map._drawMouseHandler) {
    map.off('mousemove', map._drawMouseHandler);
    map._drawMouseHandler = null;
  }
}

function refreshDrawSource() {
  if (map.getSource(DRAW_SRC)) {
    map.getSource(DRAW_SRC).setData({ type: 'FeatureCollection', features: state.draw.features });
  }
}

function updateDrawCount() {
  document.getElementById('draw-count').textContent = state.draw.features.length;
}

function clearDrawn() {
  state.draw.features = [];
  state.draw.vertices = [];
  state.draw.drawCount = 0;
  refreshDrawSource();
  clearDrawPreview();
  updateDrawCount();
  notify('Drawn features cleared', 'info');
}

function undoLastDraw() {
  if (state.draw.vertices.length) {
    // Cancel in-progress
    state.draw.vertices.pop();
    updateDrawPreview();
    return;
  }
  if (state.draw.features.length) {
    state.draw.features.pop();
    refreshDrawSource();
    updateDrawCount();
    notify('Undid last feature', 'info');
  }
}

function exportDrawn() {
  const feats = state.draw.features;
  if (!feats.length) { notify('No drawn features to export', 'warning'); return; }
  const fc   = { type: 'FeatureCollection', features: feats };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'drawn-features.geojson' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  notify(`Exported ${feats.length} drawn feature${feats.length > 1 ? 's' : ''}`, 'success');
}

function addDrawnAsLayer() {
  const feats = state.draw.features;
  if (!feats.length) { notify('Nothing drawn yet', 'warning'); return; }
  const fc = { type: 'FeatureCollection', features: JSON.parse(JSON.stringify(feats)) };
  addLayer('Drawn features', fc, null);
  clearDrawn();
}

// ═════════════════════════════════════════════════════════════
// Basemap switcher
// ═════════════════════════════════════════════════════════════

function setupBasemapSwitcher() {
  document.querySelectorAll('.bm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.style;
      if (key === state.basemap) return;
      switchBasemap(key);
      document.querySelectorAll('.bm-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
}

function switchBasemap(key) {
  state.basemap = key;

  // Snapshot current layers & draw state before style reload
  const snapshot = [...state.layers.values()].map(l => ({ ...l }));
  const drawnFeatures = [...state.draw.features];
  const drawnVertices = [...state.draw.vertices];

  map.setStyle(BASEMAPS[key]);

  map.once('styledata', () => {
    // Restore draw sources
    initDrawSources();
    state.draw.features = drawnFeatures;
    state.draw.vertices = drawnVertices;
    refreshDrawSource();
    updateDrawCount();

    // Restore all geojson layers
    snapshot.forEach(l => {
      const src = `src-${l.id}`;
      if (!map.getSource(src)) {
        map.addSource(src, { type: 'geojson', data: l.geojson, generateId: true });
      }
      reAddMapLayers(l);
      if (!l.visible) {
        ['fill', 'outline', 'line', 'point'].forEach(t => {
          const lid = `lyr-${l.id}-${t}`;
          if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', 'none');
        });
      }
    });
  });
}

function reAddMapLayers(l) {
  const src   = `src-${l.id}`;
  const color = l.color;

  const add = (id, type, filter, paint) => {
    if (!map.getLayer(id)) map.addLayer({ id, type, source: src, filter, paint });
  };

  add(`lyr-${l.id}-fill`,    'fill',   ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], { 'fill-color': color, 'fill-opacity': .35 });
  add(`lyr-${l.id}-outline`, 'line',   ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], { 'line-color': color, 'line-width': 1.5, 'line-opacity': .8 });
  add(`lyr-${l.id}-line`,    'line',   ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false], { 'line-color': color, 'line-width': 2, 'line-opacity': .9 });
  add(`lyr-${l.id}-point`,   'circle', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false], { 'circle-color': color, 'circle-radius': 5, 'circle-opacity': .9, 'circle-stroke-color': 'rgba(255,255,255,.6)', 'circle-stroke-width': 1 });
}

// ═════════════════════════════════════════════════════════════
// Status bar & notifications
// ═════════════════════════════════════════════════════════════

function updateStatusBar() {
  const n = state.layers.size;
  const total = [...state.layers.values()].reduce((s, l) => s + l.featureCount, 0);
  document.getElementById('status-layers').textContent =
    n === 0 ? 'No layers' : `${n} layer${n > 1 ? 's' : ''} · ${fmtN(total)} features`;
}

function notify(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.textContent = msg;
  document.getElementById('notifications').appendChild(el);
  const delay = type === 'error' ? 6000 : type === 'warning' ? 5000 : 3500;
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, delay);
}

function setLoading(on, msg = 'Loading…') {
  const el = document.getElementById('loading-overlay');
  el.hidden = !on;
  if (on) document.getElementById('loading-msg').textContent = msg;
}

// ═════════════════════════════════════════════════════════════
// Utilities
// ═════════════════════════════════════════════════════════════

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isURL(s) { return /^https?:\/\/\S+/.test(s); }

function fmtN(n) { return Number(n).toLocaleString(); }

function fmtBytes(b) {
  if (b < 1024)   return `${b} B`;
  if (b < 1e6)    return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1e9)    return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}
