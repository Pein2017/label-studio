## Context

See `proposal.md` and `specs/label-studio-annotation-productivity/spec.md`
for the user-facing contract. The existing refinement path already exposes a
volatile `annotate`/`edit` state on image controls, uses the normal Label
Studio label-selection state, and has a shared `Hotkey` keymap. The COCO
refinement labels are rendered from the control's children, while each label
already has a count view over the current annotation's regions.

The implementation must preserve the current draw-over mode boundary: ordinary
Label Studio image projects must not acquire a new ordering, continuity, or
shortcut behavior.

## Goals / Non-Goals

**Goals:**

- Make the current refinement label list useful for dense images without
  changing canonical label/configuration order.
- Keep one selected label active while creating consecutive regions in
  `标注` mode, with explicit mode transitions remaining authoritative.
- Register platform-correct mode shortcuts through the existing hotkey
  lifecycle and route them to the currently active refinement image.
- Make the right-side annotation list behave as a session-local recent-edit
  stack after the first real object change, without changing serialized order.
- Leave executable tests and a browser smoke receipt that prove the behavior
  without writing task or annotation data.

**Non-Goals:**

- No project-ID-specific branch, backend endpoint, database migration, or
  persisted mode/ordering preference.
- No change to label hotkey assignment, COCO category IDs, export order, hidden
  region semantics, or the existing `修改` interaction contract.
- No general redesign of Label Studio's label component or hotkey framework.

## Decisions

### 1. Gate the behavior on the existing refinement opt-in

Use the image control's existing `drawOver=true` attribute as the sole feature
boundary. This reuses the boundary already used by the explicit mode change
and avoids coupling the editor to project 3 or to a task-data field. A
project-specific check was rejected because it would make future refinement
projects silently behave differently from the current one.

### 2. Sort only the rendered label presentation

Add a small pure ordering helper at the labels rendering seam. It will derive
each label's current count from the existing region-count behavior, sort by
`count DESC`, and use the original child index as the stable tie-breaker. The
helper will return a new view array; it will not reorder the MST children.

Only direct label children participate in the frequency sort. If a control has
non-label children or is not an opted-in refinement control, the existing tree
render path is retained. This protects dynamic labels, configured hotkeys,
serialized config order, and export/category identity. Because the labels view
is an observer and the count reads observable region state, creation,
deletion, hiding, and relabeling can refresh the order without a second store
or polling loop.

Alternatives rejected:

- Mutating `item.children` would make a presentation preference look like
  configuration and could disturb hotkey/export order.
- Maintaining a second count cache would duplicate the region store and create
  invalidation risk for a four-image editor.

### 3. Preserve the existing selected-label state for annotation mode

First characterize the current new-region commit path with a focused failing
test. If a commit already leaves the selected label intact, the implementation
is limited to the regression test and any mode-specific guard required by the
test fixture. If a draw-over commit clears it, remove only that clearing path
for `annotate` mode; do not add a separate continuity store.

The explicit mode transition continues to clear transient selections as today,
and `edit` mode continues to select the move/edit tool. A click on another
label remains the only normal way to change the active label during continuous
drawing. This keeps the behavior compatible with the existing selection and
relabeling guards.

### 4. Add named platform-aware mode shortcuts at the existing global seam

Add two keymap entries with `key: ctrl+1/ctrl+2` and `mac: command+1/command+2`,
then register them in the existing hotkey attachment lifecycle. The handler
will resolve the selected annotation's active image/tool manager, no-op unless
that image has `drawOver=true`, and call the same `setInteractionMode` action
used by the toolbar. The default hotkey scope already excludes text inputs;
the handler will retain that behavior rather than adding ad-hoc DOM listeners.

Registering through the shared keymap was chosen over a per-canvas
`keydown` listener because it preserves platform translation, cleanup, hotkey
descriptions, and input filtering. The handler must resolve the current
selected image at invocation time so annotation/task switches cannot retain a
stale component closure.

### 5. Keep verification at the real seams

Tests will cover the pure label ordering, the rendered control refresh, the
continuous-label commit, and shortcut routing/gating. The final gate will run
the focused editor suites, rebuild the frontend, and browser-smoke project 3
in both modes without modifying task annotations. A failure in the ordinary
non-`drawOver` path blocks acceptance even if the refinement path works.

### 6. Own recent-edit ordering in the existing region store

Keep the current effective outliner ordering as the baseline. Add a volatile,
monotonic edit sequence owned by the active region store (or an equivalent
session-local region presentation state), rather than changing `ouid`, region
IDs, or serialized result order. A qualifying commit assigns the touched
region the next sequence number; the outliner comparator then places touched
regions by sequence descending and leaves untouched regions in their captured
baseline order. New region creation is a qualifying commit, so a new object
also enters at the top.

The touch operation must be called at successful edit boundaries, not on every
pointer move: geometry drag/resize completion, label application, and new
region commit. Selection, hover, hide/show, and lock actions do not call it.
If the user chooses another outliner sort, the normal `RegionStore` sort path
wins until the user returns to the default ordering; the stack must not
silently replace an explicit choice.

A volatile sequence is preferred over mutating the default `ouid` because it
preserves initial ordering, region hotkey/index contracts, undoable annotation
state, and export identity. A timestamp was rejected because equal or
non-monotonic clock values can make rapid edits nondeterministic. A second
persistent result field was rejected because recency is a UI-session concern,
not annotation meaning.

## Risks / Trade-offs

- [Risk] A label count update does not trigger a render. → Read the existing
  observable region collection through the labels observer and add a test that
  changes a region label and observes the order update.
- [Risk] A global shortcut targets an old image after navigation. → Resolve the
  selected annotation/image inside each handler invocation and test an
  annotation switch before pressing the key.
- [Risk] `Ctrl+1`/`Ctrl+2` collides with browser tab shortcuts on non-macOS. →
  Register through the existing prevent-default hotkey path only when the
  active image is a refinement image; document the platform mapping in the
  mode toolbar tooltip. If the host browser still claims the key before the
  page receives it, keep the toolbar controls as the fallback and record that
  host limitation rather than changing annotation semantics.
- [Risk] Presentation sorting changes the visual order while tests or users
  rely on canonical COCO order. → Keep the sort opt-in, stable on ties, and
  explicitly assert unchanged child/config/export order.
- [Risk] Pointer-move patches reorder the list dozens of times during one
  drag. → Touch only at the existing committed geometry/label boundaries and
  test that an in-progress drag does not churn the outliner.
- [Risk] An explicit outliner sort is silently replaced by the stack. → Track
  user-selected sort state through the existing RegionStore controls and let
  non-default choices bypass recent-edit ordering.

## Migration Plan

No data migration is required. Rebuild and serve the frontend bundle, then
reload the editor; volatile mode and presentation order reset naturally on
reload. Rollback is the previous frontend bundle/runtime, with no database or
annotation cleanup.
