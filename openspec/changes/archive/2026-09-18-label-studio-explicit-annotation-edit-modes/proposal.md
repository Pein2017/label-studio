## Why

The four-image COCO refinement project currently relies on `drawOver` and
implicit tool selection. That prevents many overlapping-box clicks from stealing
a new drag, but it does not give the reviewer a reliable, visible boundary
between creating a new bbox and editing an existing one.

## What Changes

- Add an explicit `标注` / `修改` mode switch for opt-in refinement images
  (`drawOver="true"`), defaulting to `标注`.
- In `标注` mode, block selection of existing regions through the canvas and
  outliner; a label click selects the class for the next new bbox and never
  relabels an existing region.
- In `修改` mode, select the existing-region tool, preserve move/resize/relabel/
  delete behavior, and reject new-region drawing or label-driven tool switching.
- Keep the mode and hidden/visible overlay state local to the editor session;
  do not add mode or visibility fields to annotation results or COCO exports.
- Leave projects that do not opt into `drawOver` unchanged.

## Capabilities

### New Capabilities

- `label-studio-interaction-modes`: Explicit, mutually exclusive annotation and
  existing-region editing behavior for refinement image editors.

### Modified Capabilities

- None.

## Impact

- Label Studio editor image interaction, toolbar rendering, tool selection,
  label selection, region hit-testing, and outliner selection.
- Focused frontend tests and the served development bundle; no backend/API,
  database, source image, annotation schema, or COCO materialization changes.
