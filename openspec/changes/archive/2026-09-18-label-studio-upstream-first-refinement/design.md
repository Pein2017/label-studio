## Context

The current `main` checkout is clean and already contains a refinement-specific
mode toolbar, draw-over guards, relation/group additions, managed draft/data
manager lifecycle code, and a project-scoped GT export hook.  Upstream
`develop` already owns the useful primitives: label selection activates the
corresponding drawing tool, drawing tools return from `drawing` to `viewing`,
`region:exit` is bound to Escape, `region:cycle` exists as a fallback, native
visibility controls operate on regions, and the ImageView renders a dashed
crosshair when configured.

The remaining product gap is spatial selection of a bbox obscured by another
bbox.  The export gap is repository ownership: the current adapter reaches into
`/data/CoordExp/src` even though its required behavior is a small pure
conversion/validation boundary.  Upstream defaults also leave
`continuousLabeling` and the crosshair disabled, so the opt-in refinement
configuration must set both explicitly.

## Goals / Non-Goals

**Goals:**

- Make upstream Label Studio the owner of ordinary label/tool/region lifecycle
  behavior and keep the refinement-specific code at two narrow seams: spatial
  bbox selection and norm1000 GT publication.
- Preserve the agreed nested-bbox rule (smallest containing visible rectangle,
  latest-edit tie-break), native visibility, crosshair, continuous label-driven
  drawing, right-click cancellation, Escape return to editing, and the upstream
  keymap without overrides.
- Vendor the adapter's pure dependency closure into the Label Studio repository
  without importing `src` or the external CoordExp tree at runtime.
- Remove or bypass superseded local mode/UI/lifecycle code only after callers,
  project scope, and tests show it is not load-bearing.
- Keep ordinary non-refinement projects on the upstream path.

**Non-Goals:**

- No generic editor plugin framework, new annotation schema, or new backend
  service.
- No changes to upstream Relation/group semantics or Data Manager lifecycle
  beyond excluding local refinement-only behavior from this path.
- No change to the norm1000 training contract, image data, COCO categories, or
  stable object identity rules.
- No full merge of all upstream commits in this change; upstream integration is
  selective and bounded by the touched surfaces.

## Decisions

### 1. Reuse native label selection as the annotation-state boundary

The upstream label control already selects the matching drawing tool and keeps
the label active for consecutive rectangles when `continuousLabeling` is
enabled.  New-box drawing is recognized only when the native rectangle tool is
selected, a label is active, and no existing region is selected.  This avoids
mistaking upstream label-driven relabeling of a selected region for a new-box
gesture.  The existing `region:exit` hotkey path will abort any incomplete
rectangle, clear the active refinement label, and return to editing.  No custom
keyboard mode mapping is added; upstream key bindings remain the only shortcut
contract.

**Alternative rejected:** keep the custom `interactionMode` model and toolbar.
It duplicates tool state, adds selection guards to label/outliner paths, and
creates conflicts in `ImageView`, `AppStore`, `Label`, and `ToolsManager` when
upstream is advanced.

### 2. Own spatial selection in one canvas hit-test seam

The ImageView click/mousedown boundary will compute candidates only for the
opted-in rectangle refinement path.  It will exclude hidden/read-only or
non-rectangle candidates, rank containing rectangles by positive area, use the
recent-edit order for equal areas, and apply a bounded distance fallback only
when no rectangle contains the pointer.  It will then call the existing native
region selection action rather than duplicating transformer, history, or delete
logic.

**Alternative rejected:** rely only on upstream `region:cycle` (`Alt+.`) or
Outliner selection.  Those are useful fallbacks but do not satisfy the direct
click requirement for nested boxes.

The hit-test must participate before a foreground rectangle starts a drag; a
click-vs-drag guard will preserve normal movement of an already selected region.

### 3. Add one refinement-scoped cancellation seam

Upstream filters right-clicks and does not expose a rectangle abort action.  The
refinement canvas will handle `contextmenu` only while a label session is active:
prevent the browser menu, first discard an incomplete `currentArea`, otherwise
remove at most one last bbox created in the current label session through the
native annotation history path.  The completed-bbox marker is consumed after
removal and cleared on label change, `Escape`, task/annotation switch, and
successful `Update`; the referenced region must still belong to the current
annotation.  It will keep the active label selected.  Edit-mode and
non-refinement right-click behavior remains untouched.

The same narrow abort operation is used by `Escape` before clearing the active
label.  It must reset the RectangleTool two-point closure (`startPoint`,
`endPoint`, `currentMode`, `modeAfterMouseMove`), cancel pending throttled draw
updates, balance history freeze/unfreeze, and clear the transient drawing
region without calling a broad undo that could remove an existing annotation.

### 4. Keep visibility and crosshair upstream-owned

No new visibility model or crosshair implementation will be added.  The
refinement configuration will set the upstream `crosshair` option to enabled
and use the native per-region/all-region controls.  Hidden flags remain
presentation state and the GT adapter serializes the complete saved result
list.

### 5. Vendor only the adapter's pure closure

The local `coordexp_refinement` package will own the conversion boundary.  The
implementation will copy the behavior of the existing geometry, category, and
draft validation code, replace absolute `src.*` imports with local imports, and
copy only the small hash/validation helpers it actually calls.  It will not
vendor the large durable store/runtime or introduce a package dependency.

The bbox-only projection will select rectangle results for validation and
publication and strip legacy relation/group result records from the canonical
refinement annotation payload on the first successful refinement `Update`.
Immutable source rows remain untouched.  This cleanup is limited to the opt-in
refinement project; ordinary Label Studio projects retain upstream relation
behavior.  Any other unsupported result type remains a contract error.

The project export hook remains the only caller.  It writes atomically and
fails closed before replacement, so upstream task/annotation serialization stays
unchanged.  The Label Studio database Update happens before this hook; a failed
export preserves the previous JSONL but does not roll back the database write.

**Alternative rejected:** importing the external `src` tree or packaging it as
an install dependency.  Both keep the fork non-self-contained and make a public
Label Studio checkout depend on CoordExp filesystem layout.

### 6. Use deletion as the upstream migration mechanism

Relation/group UI, managed Draft/Data Manager lifecycle additions, and the
custom mode toolbar are not part of the accepted bbox contract.  The first
implementation wave will inventory their production callers; later waves may
delete only proven refinement-only paths and their dedicated tests/config.  If
an upstream or ordinary-project consumer exists, the path remains on the
upstream-compatible side rather than being mechanically removed.

## Risks / Trade-offs

- **[Risk]** A shape can intercept mouse-down before the ranked candidate is
  selected. → Gate both mouse-down and click for the opt-in edit state, and
  test a nested large/small fixture with both click and drag.
- **[Risk]** Clearing a label on Escape could surprise non-refinement projects.
  → Apply the behavior only at the refinement opt-in boundary; run an ordinary
  project regression test.
- **[Risk]** A right-click could delete an existing GT region or fire after a
  label switch. → Track only the last region created in the active label
  session, clear the marker on label change/Escape, and make edit-mode clicks
  inert.
- **[Risk]** A right-click during a browser/Konva event sequence could leave a
  stale drawing region. → Test incomplete drag, completed last bbox, and empty
  canvas separately; assert drawing state, history, and serialized results.
- **[Risk]** Database Update and JSONL publication are separate operations.
  → Keep JSONL replacement fail-closed, preserve the previous JSONL on export
  failure, and report database/file status separately instead of claiming a
  cross-store rollback.
- **[Risk]** A hidden flag may be accidentally treated as deletion by export.
  → Add an export fixture that hides a region and asserts the same object remains
  in the JSONL.
- **[Risk]** Copying the adapter can drift from the external implementation.
  → Preserve contract tests for conversion, category/ID validation, atomic
  failure, legacy-relation removal, and representative five-image output before
  retiring the external import.
- **[Risk]** A project setting can silently fall back to upstream defaults.
  → Assert the served refinement configuration enables both
  `continuousLabeling` and `crosshair` in the browser/API smoke.
- **[Risk]** Removing custom code during upstream integration may remove an
  unrelated consumer. → Require a reachability/ownership audit and keep
  deletion in a separate reversible slice.
- **[Trade-off]** The smallest-area rule intentionally chooses the smaller
  object when sibling bboxes overlap; that is deterministic and matches the
  dense-scene workflow, but it is not a semantic object-identity oracle.

## Migration Plan

1. Freeze the current clean baseline and capture focused editor/export test
   results; do not merge upstream in the user's main runtime yet.
2. Set and characterize the refinement-only upstream settings
   (`continuousLabeling` and `crosshair`), leaving the upstream keymap
   untouched.
3. Vendor and test the self-contained adapter while the existing export path is
   still available for parity comparison.
4. Implement the upstream-first label/Escape boundary, right-click cancellation,
   and spatial selection in an isolated frontend slice; preserve native
   visibility and crosshair.
5. Reconcile the old custom mode/relation/managed paths using the entropy audit;
   remove only paths with no required consumer, then rebuild the frontend.
6. Run focused unit tests, adapter contract tests, frontend build, API health,
   and a browser smoke on nested boxes, hidden boxes, crosshair, continuous
   label drawing, right-click cancellation, Escape, Update, relation removal,
   and five-image JSONL publication.
7. Keep rollback simple: revert the frontend slice or adapter slice
   independently; no database migration or persisted annotation schema change
   is required.
