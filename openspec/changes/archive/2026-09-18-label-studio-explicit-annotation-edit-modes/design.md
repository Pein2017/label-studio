## Context

The current refinement configuration already opts into `Image.drawOver`, and
the editor has separate drawing tools and `MoveTool`. Existing code disables
some Konva hit testing while a drawing tool is active, but label clicks can
still update a selected region or select a drawing tool implicitly. The
outliner also selects regions independently of canvas hit testing.

## Goals / Non-Goals

**Goals:**

- Make the two interaction contracts explicit in the existing image toolbar.
- Enforce the mode at shared tool and selection seams, not only in the new UI.
- Keep the change opt-in and session-local, with focused regression tests.

**Non-Goals:**

- No new annotation schema, server endpoint, persistence field, or dataset
  conversion behavior.
- No redesign of native Label Studio tools or removal of hiding/visibility
  controls.

## Decisions

### 1. Use `drawOver` as the existing opt-in boundary

The current four-image project already sets `drawOver="true"`. The mode switch
will render only for that opt-in, avoiding a project-ID check and leaving
ordinary Label Studio projects untouched. The existing draw-over hit-testing
path will be additionally gated by the selected mode.

### 2. Keep mode on the image editor as volatile state

`Image` will own an `interactionMode` value (`annotate` or `edit`) in its
volatile editor state. A mode action clears transient region/label selections;
entering edit mode selects `MoveTool`, while annotation mode waits for the user
to choose a label. Since the value is volatile, it cannot enter serialized
annotation results or dirty hashes.

### 3. Guard shared seams

- `ToolsManager.selectTool` rejects drawing-tool activation while an opted-in
  image is in edit mode and redirects to `MoveTool`.
- `Label.toggleSelected` refuses label-only creation in edit mode and skips its
  existing implicit drawing-tool switch there; selected-region relabeling stays
  available.
- Image/rectangle hit testing and the outliner selection handler refuse region
  selection in annotate mode and retain native hit testing in edit mode.
- The existing `drawOver` canvas path remains the single route for drawing over
  overlapping regions.

This is smaller and safer than adding a second annotation store or a parallel
mode-specific region model. A toolbar-only toggle was rejected because keyboard,
outliner, and label paths could still violate the selected mode.

### 4. Reuse existing toolbar primitives

The mode controls use the editor's existing `Tool`/toolbar styling and icon
components, with accessible labels and pressed/active state. No dependency or
new global state is introduced.

## Risks / Trade-offs

- [Risk] A stale drawing tool can remain selected after a mode transition.
  → The transition clears selections and explicitly selects `MoveTool` in edit
  mode; shared tool selection also fails closed.
- [Risk] Outliner and Konva event paths drift again.
  → Regression tests cover both canvas draw-over and outliner selection, plus
  the shared manager/label guards.
- [Risk] Existing projects use `drawOver` for a different purpose.
  → The switch is opt-in by that already-visible attribute; projects that need
  native behavior can omit it, and non-`drawOver` projects are untouched.
