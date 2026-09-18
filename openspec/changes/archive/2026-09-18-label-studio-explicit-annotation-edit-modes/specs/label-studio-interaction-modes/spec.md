## Purpose

Provides a visible and deterministic separation between creating new COCO
bounding boxes and modifying existing boxes in the local refinement editor.

## ADDED Requirements

### Requirement: Explicit refinement interaction modes

For an image control configured with `drawOver="true"`, the editor SHALL expose
two accessible mutually exclusive modes named `标注` and `修改`, with `标注`
active initially. Switching modes SHALL clear only transient region/label
selection state and SHALL not mutate annotation results.

#### Scenario: Reviewer opens a refinement image
- **WHEN** the image editor is ready
- **THEN** the mode controls are visible, `标注` is active, and no existing bbox is selected

#### Scenario: Reviewer enters modification mode
- **WHEN** the reviewer activates `修改`
- **THEN** the existing-region tool is active and the canvas is ready to select existing bboxes

#### Scenario: Reviewer returns to annotation mode
- **WHEN** the reviewer activates `标注`
- **THEN** transient selections are cleared and a new label can be chosen before drawing

### Requirement: Annotation mode creates only new regions

While `标注` is active, the editor SHALL NOT select or relabel an existing
region through the canvas or outliner. Clicking a label SHALL select that label
for the next drawing gesture, and drawing SHALL create a new axis-aligned bbox
with that label without changing any existing bbox.

#### Scenario: Overlapping existing boxes are present
- **WHEN** the reviewer drags across an existing bbox in `标注`
- **THEN** the drag starts a new bbox and no existing bbox becomes selected or moved

#### Scenario: Reviewer chooses a label before drawing
- **WHEN** the reviewer clicks a label and then draws a rectangle
- **THEN** the new rectangle receives the chosen label and all prior regions remain unchanged

#### Scenario: Reviewer clicks an existing bbox in annotation mode
- **WHEN** the reviewer clicks or clicks an outliner row for an existing bbox
- **THEN** the bbox is not selected and the editor remains in `标注`

### Requirement: Modification mode edits only existing regions

While `修改` is active, the editor SHALL allow selection, movement, resizing,
relabeling, hiding, and deletion of existing editable regions, but SHALL NOT
create a new region from a canvas drag or from a label click. Drawing tools and
label clicks that would start a new region SHALL be ignored or redirected to
the existing-region tool.

#### Scenario: Reviewer corrects an existing bbox
- **WHEN** the reviewer selects and drags an existing bbox in `修改`
- **THEN** only that existing bbox is moved or resized

#### Scenario: Reviewer drags empty canvas in modification mode
- **WHEN** the reviewer drags where no existing bbox is selected
- **THEN** no new bbox is created

#### Scenario: Reviewer clicks a label with no existing bbox selected
- **WHEN** the reviewer clicks a label in `修改` with no region selected
- **THEN** no new drawing tool is activated and no annotation result is created

### Requirement: Refinement mode state is non-semantic

Mode selection and overlay visibility SHALL remain editor-session state only.
They SHALL NOT change region geometry, labels, IDs, ordering, Draft semantic
hashes, exported annotations, or COCO materialization output unless the user
performs an actual region edit.

#### Scenario: Reviewer switches modes repeatedly
- **WHEN** the reviewer switches between `标注` and `修改` without editing a region
- **THEN** the annotation payload and dirty/commit state are unchanged

### Requirement: Non-refinement projects retain native behavior

Images not configured with `drawOver="true"` SHALL retain the existing Label
Studio tool-selection, region-selection, and drawing behavior and SHALL not
display the refinement mode controls.

#### Scenario: Ordinary project is opened
- **WHEN** an image without `drawOver="true"` is rendered
- **THEN** no refinement mode switch is shown and native interactions are unchanged
