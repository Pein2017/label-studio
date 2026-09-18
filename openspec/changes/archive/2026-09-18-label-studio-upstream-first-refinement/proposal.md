## Why

The local refinement editor currently carries a larger custom interaction
surface than this project needs: an explicit mode toolbar, custom draw-over
guards, relation/group UI, and managed draft/data-manager lifecycle code all
overlap with Label Studio behavior.  The next iteration should make upstream
Label Studio the primary owner while retaining only the one interaction that
upstream does not provide: selecting the smallest existing bbox under a click
when boxes overlap.

The current GT bridge also reaches into `/data/CoordExp/src`, so the fork is
not self-contained.  Vendoring the small, pure conversion boundary into this
repository will preserve the `[0,999]` norm1000 contract without making the
Label Studio fork depend on an external source tree or an install-time package.

## What Changes

- Use the native Label Studio label/tool lifecycle as the refinement annotation
  state: selecting a label enables continuous bbox drawing; `Escape` aborts
  the active draw (discarding an incomplete rectangle) and exits to
  existing-region selection by clearing the active label through the existing
  region-exit hotkey path.  The refinement project explicitly enables upstream
  `continuousLabeling` and `crosshair`; the upstream keymap is left untouched
  and no replacement mode toolbar is needed.
- Add a refinement-scoped right-click cancellation seam: while a label session
  is active, right-click aborts an incomplete current rectangle or removes only
  the last bbox created in that same label session, keeps the label selected,
  and prevents the browser context menu.  Right-click is a no-op in edit mode,
  after `Escape`, or after changing labels.
- Keep the native drawing predicate precise: a selected rectangle tool plus an
  active label and no selected existing region enters new-box drawing; selecting
  a label with an existing region selected retains upstream relabel/edit
  behavior.
- Add a rectangle-only spatial hit-test for the refinement project.  In
  existing-region selection, a click chooses the smallest visible bbox that
  contains the point; equal-area ties use the latest-edit stack order, and a
  small outside tolerance uses point-to-rectangle distance.  The selected
  region is then passed through upstream selection/transformer/history logic.
- Keep upstream crosshair rendering and native per-region/all-region
  visibility controls.  Hidden regions remain part of the annotation and GT
  export payload.
- Replace the external GT adapter imports with a self-contained copy under
  `label_studio/coordexp_refinement/`, preserving integer inclusive norm1000
  `xyxy` values in `0..999` and the current stable-ID/category checks.  Legacy
  relation records are dropped from the opt-in refinement annotation boundary;
  rectangle results are retained and saved annotations contain bbox results
  only.
- Make upstream behavior the default integration target.  Do not reintroduce
  local Relation/group UI or Managed Draft/Data Manager lifecycle behavior into
  the bbox path; remove legacy relation/group records from this opt-in
  refinement path and retain only the smallest project-scoped save/export seam
  required by the existing five-image workflow.
- Remove or bypass superseded local mode/state plumbing only after its callers,
  tests, and project boundary are verified; leave ordinary non-refinement
  Label Studio projects unchanged.

## Capabilities

### New Capabilities

- `label-studio-upstream-first-bbox-refinement`: Upstream-first bbox drawing,
  edit selection-through, visibility, crosshair, and self-contained norm1000
  GT publication for the opt-in refinement project.

### Modified Capabilities

- None.  There is no accepted repository-level Label Studio capability spec;
  the completed mode work remains historical implementation evidence until this
  change is verified.

## Impact

- Frontend editor seams: `ImageView`, rectangle region hit-testing, label/tool
  selection, existing region hotkeys, refinement project settings, right-click
  cancellation, and related focused tests.
- Local refinement backend: GT adapter imports and project-scoped export hook;
  no change to upstream Label Studio task/annotation wire format.
- Existing relation/group, managed draft/data-manager, and explicit mode files
  are candidates for de-scoping or deletion only where reachability and
  non-refinement compatibility checks prove they are not required.
- Validation includes focused editor tests, adapter contract tests, frontend
  build, and a browser/API smoke of the five-image project without modifying
  source annotations during the check.
