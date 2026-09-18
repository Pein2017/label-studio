## Wave 0 — Freeze the boundary and prove the current failure

- [x] 0.1 **Lead**: record the `main` baseline (`721d4a216`), current upstream
  merge-base (`d0498f6d`), served project configuration, and focused
  editor/export test results; the working tree was intentionally preserved
  dirty and no unrelated files were staged.
- [x] 0.2 **Lead + frontend-interaction owner**: characterize the served
  refinement settings (`drawOver=true`, `crosshair=true`) and the
  refinement-scoped continuous-label lifecycle; assert that the upstream
  keymap is not overridden.
- [x] 0.3 **Lead + frontend-interaction owner**: add focused tests for
  the smallest-containing-bbox rule, active-label draw-over behavior, Escape
  abort/label clearing, right-click cancellation, hidden-region exclusion, and
  non-refinement behavior.  Include the selected-region relabel guard and keep
  the fixture to nested axis-aligned rectangles.
- [x] 0.4 **GT-adapter owner**: add a self-containment check and parity
  fixtures for percentage-to-norm1000 conversion, category/ID validation,
  hidden-region preservation, legacy relation removal, and atomic failure.

**Gate 0:** the failure evidence distinguishes the old topmost/implicit path
from the requested behavior; no source or annotation data is changed by the
characterization run.

## Wave 1 — Vendor the GT boundary first

- [x] 1.1 **GT-adapter owner**: copy the pure geometry, category, draft
  validation, and hash helper closure into
  `label_studio/coordexp_refinement/`; replace every external `src.*` import
  with local imports and do not vendor the durable CoordExp store/runtime.
- [x] 1.2 **GT-adapter owner**: switch `gt_export.py` and its tests to the local
  modules; assert the repository contains no runtime `import src` on the
  refinement export path and no `/data/CoordExp/src` filesystem lookup.
- [x] 1.3 **GT-adapter owner**: run conversion, validation, atomic replacement,
  hidden-region, legacy-relation-removal, stable-ID, and representative
  five-image JSONL parity checks; retain the previous working file on every
  rejected payload.

**Gate 1:** the self-contained adapter passes its contract tests and produces
the same norm1000 semantics and object counts as the current accepted export.

## Wave 2 — Reuse upstream label/tool lifecycle

- [x] 2.1 **Frontend-interaction owner**: keep the refinement project’s native
  crosshair configuration explicit, implement continuous labeling at the
  refinement lifecycle seam, and leave the upstream keymap unchanged.
- [x] 2.2 **Frontend-interaction owner**: extend the existing refinement-scoped
  `region:exit` path with an explicit abort for an incomplete rectangle, reset
  the RectangleTool two-point closure and pending throttled updates, balance
  history freeze/unfreeze, then clear the active label; preserve completed
  boxes and ordinary projects' upstream relation/selection behavior.
- [x] 2.3 **Lead**: remove or bypass the custom explicit mode toolbar and
  duplicated `interactionMode` guards only after the lifecycle tests pass;
  preserve label-driven continuous drawing and the native visibility and
  crosshair paths.
- [x] 2.4 **Lead**: verify that mode/session state does not enter result
  serialization, dirty hashes, stable IDs, or GT JSONL; keep label changes on a
  selected existing region as native editing behavior.
- [x] 2.5 **Frontend-interaction owner**: add refinement-scoped canvas
  `contextmenu` handling with strict precedence: abort incomplete drawing first;
  otherwise remove at most one last bbox created in the current label session,
  consume the marker, keep the label active, clear the marker on label,
  Escape, task/annotation switch, and successful Update, and leave
  edit-mode/non-refinement right-click inert.

**Gate 2:** selecting a label draws continuously, selected-region label clicks
retain upstream relabeling, Escape returns to editing and aborts pending
two-point state, right-click cancels only the current annotation action, and
ordinary Label Studio projects remain unchanged.

## Wave 3 — Add spatial selection-through at the native seam

- [x] 3.1 **Frontend-interaction owner**: implement a small rectangle candidate selector at the
  existing ImageView hit-test boundary: visible containing rectangles first,
  smallest positive area, latest-edit tie-break, bounded point-to-rectangle
  fallback, then no selection outside tolerance.
- [x] 3.2 **Frontend-interaction owner**: integrate the selector across mouse-down and click so a
  foreground bbox cannot steal a nested edit click, while an already selected
  bbox still moves/resizes through upstream transformer/history behavior.
- [x] 3.3 **Frontend-interaction owner**: keep annotation-state draw-over pass-through separate from
  edit-state candidate selection; do not add a second region store or a global
  plugin abstraction.
- [x] 3.4 **Frontend-interaction owner + Lead**: run focused frontend tests for
  nested, non-nested, equal-area, hidden, empty-space, click-vs-drag, and
  non-refinement cases.

**Gate 3:** a browser-shaped nested-box fixture selects the smallest target by
  direct click, edits it normally, and creates no accidental new bbox in edit
  state.

## Wave 4 — Reconcile entropy and upstream drift

- [x] 4.1 **Entropy-audit owner**: deliver a reachability-backed allowlist of
  relation/group, managed Draft/Data Manager, and superseded explicit-mode
  files/branches that have no required consumer in the refinement workflow.
- [x] 4.2 **Lead**: apply only the accepted allowlist as a separate reversible
  deletion slice; preserve upstream-compatible paths and dedicated tests for
  any remaining consumer.
- [x] 4.3 **Lead**: review the relevant `upstream/develop` diffs for
  `ImageView`, rectangle regions, label/tool lifecycle, visibility, and
  serialization; port only compatible upstream behavior and do not perform a
  full 854-commit merge in this change.

**Gate 4:** a residue search finds no active external adapter import or
superseded refinement-only caller beneath the selected cuts, and the exact
upstream-facing diff remains reviewable.

## Wave 5 — Integration and acceptance

- [x] 5.1 **Lead**: run targeted Jest/editor and Python adapter suites, then
  `git diff --check`; record pre-existing failures separately from new ones.
- [x] 5.2 **Lead**: rebuild the frontend with the repository's existing build
  command and verify the served bundle contains the native-first lifecycle,
  spatial selector, visibility, and crosshair behavior.
- [x] 5.3 **Lead**: run API health and a real-browser page/image smoke for the
  five-image project; feature branches are covered by the focused Jest and
  adapter suites.  Verify the two-rectangle-plus-legacy-relation fixture,
  current five-image counts, relation removal, and database Update versus
  JSONL publication status separately.
- [x] 5.4 **Lead**: validate the change with
  `openspec validate label-studio-upstream-first-refinement --type change
  --strict`, inspect the complete diff, and update this task list only after
  all gates pass.

**Stop rule:** stop after Gate 5 passes.  Do not expand into a plugin framework,
full upstream merge, relation redesign, managed lifecycle redesign, or dataset
schema change without a new user-approved change.
