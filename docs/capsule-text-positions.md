# Text positions: draft → job → renderer

Positions are static frame-relative offsets. Animation/fade authoring stays in Ainimation Studio. The existing renderer's default transitions are retained; this change adds no animation controls to Stock.

`textPositions` is an optional object with `horizontal` / `vertical` maps. Supported boxes: `heading`, `gancho`, `giro`, `remate`, `fuente`, `marca`, `unidad`, `claim`. Each entry is exactly `{x, y}` with finite numbers in `[-1, 1]`, rounded to five decimals. X is relative to the complete output width, Y to its height, independent of the source video's aspect ratio. Zero offsets are omitted. Unknown keys, strings, booleans, missing coordinates and animation parameters are rejected.

`GET /capsula/url/director` returns the saved positions, `textPositionSchema: "admira.text-positions.v1"`, and `textPositionRendering`. `POST` validates and retains the positions with the script, existing ETag revision, authorization and archived original. Omitting positions preserves the saved layout for older clients; sending `{}` explicitly restores the template positions. Position-only edits still create a new version. Invalid layout is `400 invalid-text-positions`; a nonempty layout while the renderer gate is off is `503 position-renderer-unavailable`, before any queue/history write.

`guion_v5()` carries layout/schema into the render script. `render_url.py` uses `text_positions.py` to shift each text box by `(x*W, y*H)` in its own orientation. Heading movement does not move sentences or the unit implicitly. Each phase has its own identity, including when two phase strings happen to match. Media and logo are not translated. With no positions, the existing layout is retained.

## Activation and rollback

The gate is **off by default**: `CAPSULE_TEXT_POSITIONS_RENDERER` must equal `admira.text-positions.v1` before the API advertises support or accepts a positioned job. Do not set it based on local tests alone.

On the actual queue host, inspect the active queue process and directory first. Install `capsula_cola.py`, `render_url.py`, and `text_positions.py` together, preserving backups and any current job. Retain its existing fonts, source media, environment and publication authorization. The queue copies the helper into each new version directory. The current source also expects `editor_preview.py` from the earlier preview update; install it if the active host lacks it. Verify syntax, module hashes and local fixture outputs on that host before enabling the Worker gate. Do not run `--publicar` as a deployment test: fixture verification never contacts Stock.

After host verification, enable the gate through the normal Worker deployment/configuration and confirm the real GET endpoint advertises it. Test the browser's positioned submission with a controlled fixture, not a real capsule. Publish a real capsule only with approved copy. Disabling/removing the gate prevents new positioned jobs; retain the updated renderer for any positioned jobs already queued.

At preparation time, the saved GrokBotBox Tailscale node was offline and SSH timed out. Local verification is not proof of installation. Until connected-host verification succeeds, leave the gate disabled.

## Verification

`npm test` covers schema validation, capability gating, authorization, version/ETag protection and saved-job round trips.

With Python + Pillow + NumPy available and `CAPSULE_FONT_DIR` pointing to the three bundled capsule variable fonts, run `python3 test/render_text_positions_test.py`. `CAPSULE_RENDER_TEST_OUT` retains before/after frames; `CAPSULE_RENDER_TEST_VIDEO=1` also encodes short H.264 fixtures in both full-HD orientations. Tests exercise portrait, landscape and missing sources, every text box, orientation independence, queue propagation and actual rendered pixels. The test generates synthetic content and never publishes.
