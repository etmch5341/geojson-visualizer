---
name: GeoJSON Viewer project
description: Local fast GeoJSON visualizer with web UI and Python streaming backend
type: project
---

Full-stack local GeoJSON viewer built for large files (1–2 GB+).

**Why:** geojson.io is too slow for large files; needed a local alternative.

**Architecture:**
- `server.py` — Python HTTP server serving static files + `/api/load` (ijson streaming) + `/api/files` (data folder listing)
- `index.html` + `static/style.css` + `static/app.js` — MapLibre GL JS SPA
- `src/geojson_viewer.py` — original CLI renderer (matplotlib, pre-existing)

**How to run:** `python3 server.py` opens browser at localhost:8000 automatically.

**Key decisions:**
- MapLibre GL JS v4 via CDN (WebGL, no build step)
- CARTO basemaps (no API key needed)
- Satellite = Esri raster tiles (no key)
- Draw tools implemented manually (no mapbox-gl-draw) to avoid compatibility issues
- Inspector panel slides in from right as an overlay (doesn't shrink map)
- Layer colors cycle through a 10-color GitHub-dark-theme palette

**How to apply:** Reference this when making changes to the web frontend or server.
