# Microgrid design tool

Pre-feasibility sizing, dispatch and LCOE tool for microgrids and AI data-centre power.
Runs entirely in the browser — no server, no backend, no data leaves the machine.

**Phase 1 of 6**: project context, location and resource library, load input
(CSV upload, parametric synthesis, AIDC derivation).

## Run locally

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Push this repository to GitHub with the default branch named `main`.
2. Repository → Settings → Pages → **Source: GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and
   publishes to `https://<user>.github.io/<repo>/`.

`vite.config.js` uses `base: "./"`, so the build works at any path without
hard-coding the repository name.

## Updating the tool

The whole tool is one file: `src/MicrogridDesignTool.jsx`. Replace it with a
newer phase and push — nothing else changes.

## Scope

This is a pre-feasibility tool. It is not a substitute for a protection study,
an EMT study, or a contractor's price. All physical and cost coefficients live
in the `CONSTANTS` and `LOCATION_LIBRARY` objects at the top of the component,
with units stated on every entry.
