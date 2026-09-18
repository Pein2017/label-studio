## Why

The four-image COCO refinement editor now has explicit `标注` and `修改`
states, but the next annotation is still slower than necessary: the label list
keeps the static COCO order even when one image is dominated by a few classes,
and the mode/label state is not yet optimized for repeated box creation. A
small, session-local editor improvement can reduce repeated scrolling and
mode clicks without changing annotation data or ordinary Label Studio
projects.

## What Changes

- For opt-in refinement images (`drawOver="true"`), order the visible labels
  by the number of matching labels already present on the current image,
  descending; use the original control/configuration order as the stable
  tie-breaker. Recompute the presentation order when the current image's
  regions or labels change without mutating config order, label hotkeys, or
  export category IDs.
- In `标注` mode, make the selected label persistent across successful new
  region creation so repeated boxes use the same label until the reviewer
  explicitly selects another label or changes mode. Keep `修改` mode free of
  new-region creation.
- Add mode shortcuts for the refinement editor: `⌘1` selects `修改` mode and
  `⌘2` selects `标注` mode on macOS; use the existing Label Studio
  non-macOS modifier mapping (`Ctrl+1`/`Ctrl+2`) for parity. Bind them only
  while an opted-in refinement image is active and keep the existing toolbar
  controls as an alternative.
- In the right-side annotations/outliner list, preserve the effective default
  order until a real annotation change occurs. Then maintain a session-local
  edit stack: the most recently created, moved, resized, or relabeled object
  appears first, repeated edits move it to the top, and untouched objects keep
  their previous order. Selection, hover, hide/show, lock, and manual sorting
  do not trigger or override this stack behavior.
- Keep all four behaviors session-local. Do not add fields to annotation
  results, task data, COCO exports, or backend APIs.

## Capabilities

### New Capabilities

- `label-studio-annotation-productivity`: Image-refinement label ordering,
  persistent annotation labels, and explicit mode keyboard shortcuts.

### Modified Capabilities

- None.

## Impact

- Frontend editor label rendering/ordering, image interaction-mode hotkeys,
  outliner/region ordering, and the existing draw-over annotation path.
- Focused frontend tests and the served development bundle.
- No backend, database, source-image, annotation-schema, export, or runtime
  data changes. Non-`drawOver` projects remain unchanged.
