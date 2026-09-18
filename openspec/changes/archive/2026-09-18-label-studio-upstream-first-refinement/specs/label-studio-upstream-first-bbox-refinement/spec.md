## Purpose

This capability provides a small, upstream-compatible bbox refinement workflow
for the opt-in COCO project: native label-driven drawing, Escape-based return
to editing, deterministic selection of nested boxes, native visibility and
crosshair behavior, and a self-contained norm1000 GT export boundary.

## ADDED Requirements

### Requirement: Native-first annotation and edit lifecycle

For an opted-in refinement image, selecting a label SHALL activate continuous
new-bbox drawing using the existing Label Studio label/tool behavior.  The
refinement project configuration SHALL explicitly enable upstream
`continuousLabeling`; the active label therefore remains selected across
  successful drags.  New-box drawing SHALL require the native rectangle tool,
  an active label, and no selected existing region.  While that drawing state
  is active, canvas and outliner interactions SHALL NOT select an existing
  region.  `Escape` SHALL abort any incomplete
  current rectangle without publishing it, clear the active label, and return
  the editor to existing-region selection.  A rectangle already completed
  before `Escape` SHALL remain unchanged.  In that state, a canvas drag on
  empty space SHALL NOT create a new bbox.  The upstream keymap SHALL remain
  authoritative; this capability SHALL not add or override mode shortcuts, a
  custom mode toolbar, or parallel mode state.  If an existing region is
  selected when a label is clicked, upstream relabel/edit behavior SHALL be
  preserved; the reviewer can press `Escape` to clear the selection before
  starting a new label session.

#### Scenario: Label selection starts continuous annotation

- **WHEN** the reviewer selects a bbox label and drags on the image, including
  across existing boxes
- **THEN** a new axis-aligned bbox is created with that label and the existing
  boxes remain unselected and unchanged

#### Scenario: Continuous label remains active

- **WHEN** the reviewer draws two or more valid bboxes without changing the
  selected label
- **THEN** every new bbox uses that label until the reviewer changes the label
  or exits the drawing state

#### Scenario: Escape returns to editing

- **WHEN** the reviewer presses `Escape` after drawing or selecting a label
- **THEN** any incomplete current rectangle is discarded, the active label is
  cleared, and existing regions become selectable without a new mode panel

#### Scenario: Edit mode does not create a new region

- **WHEN** no label is active and the reviewer drags on empty image space
- **THEN** no new bbox or annotation result is created

#### Scenario: Label click starts a new continuous annotation session

- **WHEN** the reviewer is in the post-Escape edit state and clicks a bbox label
- **THEN** that label becomes active, no existing region is selected, and the
  next drag starts a continuous annotation session; existing regions remain
  unselected until a new bbox is drawn

#### Scenario: Selected-region label click keeps upstream relabeling

- **WHEN** the reviewer has selected an existing bbox and clicks a different
  label
- **THEN** the selected bbox follows upstream relabel/edit behavior, and no
  unrelated new bbox is created; pressing `Escape` clears the selection before
  the next label click starts a new annotation session

### Requirement: Refinement right-click cancellation

In the opt-in refinement project, a right-click on the image canvas while a
label session is active SHALL prevent the browser context menu and cancel only
the current annotation action.  If an incomplete rectangle exists, it SHALL
be discarded without entering history or GT.  If the current label session has
a most recently completed bbox, that bbox SHALL be removed through the native
annotation/history path.  These cases SHALL have strict precedence: abort an
incomplete rectangle first; otherwise remove at most one eligible completed
bbox and consume its session marker.  The active label SHALL remain selected so
the reviewer can continue drawing.  Right-click SHALL be a no-op for existing
regions in edit mode, after `Escape`, or after the reviewer changes labels; it
SHALL NOT delete an older GT region.  The eligible marker SHALL also be
cleared on task/annotation switch and successful `Update`, and the referenced
region SHALL still belong to the current annotation before removal.

#### Scenario: Right-click aborts an incomplete rectangle

- **WHEN** the reviewer has started dragging a new rectangle and right-clicks
  before releasing the left button
- **THEN** the transient rectangle disappears, no annotation result or history
  entry is created, all rectangle-tool pending-point state is reset, the label
  remains active, and the reviewer can draw again

#### Scenario: Right-click removes the last completed bbox in-session

- **WHEN** the reviewer has just completed a bbox in the active label session
  and right-clicks before changing labels or pressing `Escape`
- **THEN** only that newly created bbox is removed through native history,
  the marker is consumed so a second right-click cannot walk backward through
  older boxes, earlier GT regions remain unchanged, and the label remains active

#### Scenario: Right-click is inert outside annotation state

- **WHEN** the reviewer right-clicks in edit mode, after `Escape`, after
  changing labels, or outside the refinement image canvas
- **THEN** no annotation, history, or mode state changes

#### Scenario: Escape resets an incomplete rectangle safely

- **WHEN** the reviewer clicks once or begins dragging a rectangle and presses
  `Escape` before completion
- **THEN** the transient rectangle and pending two-point tool state are reset,
  delayed mouse events cannot commit it, the label is cleared, and existing
  annotations remain unchanged

### Requirement: Deterministic nested-bbox selection

In the existing-region selection state, clicking inside one or more visible
axis-aligned bbox regions SHALL select the region with the smallest positive
area that contains the pointer.  Equal-area candidates SHALL be resolved by
latest-edit stack order.  If no region contains the pointer, a bounded hit
tolerance MAY select the visible region with the smallest point-to-rectangle
distance; clicks outside that tolerance SHALL select nothing.  The selected
region SHALL continue through the native selection, transformer, drag, resize,
history, and delete behavior.

#### Scenario: Small bbox inside a large bbox

- **WHEN** the reviewer clicks inside a small visible bbox that is fully or
  partially contained by a larger visible bbox
- **THEN** the small bbox is selected rather than the larger bbox

#### Scenario: Large bbox area outside nested objects

- **WHEN** the reviewer clicks inside a visible large bbox but outside all
  smaller contained bboxes
- **THEN** the large bbox is selected

#### Scenario: Equal-area overlap

- **WHEN** multiple visible bboxes of equal area contain the pointer
- **THEN** the most recently edited candidate is selected deterministically

#### Scenario: Hidden regions are not hit-test candidates

- **WHEN** a region is hidden through the native visibility control and the
  pointer lies within its former geometry
- **THEN** that region is not selected or moved by the canvas hit test

### Requirement: Native visibility and crosshair remain available

The refinement editor SHALL retain the upstream per-region and all-region
visibility controls and SHALL render the dashed x/y crosshair while the pointer
is over the image.  The refinement project configuration SHALL explicitly set
the upstream `crosshair` option to enabled.  Visibility changes SHALL be
editor presentation state only:
they SHALL NOT delete, relabel, reorder, or exclude regions from the saved
annotation or GT export.

#### Scenario: Hide a dense set before editing

- **WHEN** the reviewer hides one region or all regions and then edits a visible
  region or draws a new one
- **THEN** the hidden state controls presentation and hit testing only, while
  the saved annotation still contains the hidden regions

#### Scenario: Crosshair follows the pointer

- **WHEN** the reviewer moves the pointer over the image
- **THEN** the horizontal and vertical dashed guides follow the pointer and
  disappear when it leaves the image

### Requirement: Self-contained norm1000 GT publication

The refinement export boundary SHALL be implemented entirely inside the
Label Studio repository with no runtime import from `/data/CoordExp/src` and no
install-time dependency on that tree.  On publication, every bbox SHALL be a
strict integer inclusive `xyxy` box with each edge in `0..999`, with canonical
COCO category and stable object identity validation.  Relation/group results
from legacy annotations SHALL be dropped at the opt-in refinement annotation
boundary, so the canonical saved annotation and bbox GT projection contain
rectangle results only.  Unsupported non-relation results SHALL remain
invalid.  The immutable COCO source rows SHALL NOT be modified.  Publication
SHALL fail closed before replacing the working JSONL when a rectangle result
violates the contract.  A database Update and JSONL replacement need not be a
single transaction; a failed export SHALL preserve the previous working JSONL
and report the failure without claiming database rollback.

#### Scenario: Edited rectangle is published in training coordinates

- **WHEN** the reviewer updates an annotation containing valid rectangle
  results
- **THEN** the project GT JSONL contains the corresponding integer norm1000
  `xyxy` boxes, canonical category IDs, and stable object IDs

#### Scenario: Legacy relation is removed from refinement data

- **WHEN** an annotation contains two valid rectangle results and one legacy
  relation result
- **THEN** publication succeeds with the two rectangles in the bbox GT JSONL,
  removes the relation from the canonical refinement annotation payload, and
  does not expose relation/group UI for that project

#### Scenario: Hidden regions remain in GT

- **WHEN** a valid region is hidden in the editor before publication
- **THEN** the region remains present in the published GT JSONL with its last
  edited geometry

#### Scenario: Invalid geometry is rejected atomically

- **WHEN** a result has non-finite, non-integer/out-of-range, degenerate, or
  otherwise invalid geometry or category identity
- **THEN** publication fails without replacing the previous working JSONL

### Requirement: Native behavior outside the refinement boundary

Images and projects that do not opt into the refinement workflow SHALL retain
upstream Label Studio label selection, region hit testing, drawing, visibility,
crosshair configuration, and serialization behavior.

#### Scenario: Ordinary Label Studio project

- **WHEN** an image is loaded without the refinement opt-in
- **THEN** no refinement-specific hit-test or Escape label-clearing behavior is
  applied
