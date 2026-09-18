## Purpose

This capability makes the opt-in image-refinement editor faster for dense
single-image work while keeping mode state and label presentation ephemeral,
with no changes to stored annotations, task data, or exports.

## ADDED Requirements

### Requirement: Refinement labels are ranked by current-image frequency

For an active image control with `drawOver="true"`, the editor SHALL present
its label choices in descending order of the number of matching labels on the
currently active image. The count SHALL be based on the current editable
annotation's existing regions, including regions that are temporarily hidden;
suggestions or regions from another image SHALL NOT affect the count. Labels
with equal counts SHALL retain their original configuration order, and the
presentation sort SHALL NOT mutate configuration order, label hotkeys, or
export category identity.

#### Scenario: Frequently used labels appear first

- **WHEN** the active image has three `person` regions, one `car` region, and
  no `dog` regions
- **THEN** the visible label choices order `person` before `car` before `dog`

#### Scenario: Ties and zero-count labels are deterministic

- **WHEN** several labels have the same count, including a group of labels with
  zero regions
- **THEN** each tied group keeps the original configuration order and the
  result is stable across re-renders

#### Scenario: Counts refresh after an edit

- **WHEN** a region is created, deleted, hidden, or relabeled on the active
  image
- **THEN** the label presentation reflects the new counts without changing
  the saved annotation schema or the static label configuration

#### Scenario: Ordinary projects keep their existing order

- **WHEN** the active image does not opt into `drawOver="true"`
- **THEN** its label presentation and behavior remain unchanged

### Requirement: Annotation mode keeps the active label for continuous drawing

In `标注` mode, after a new region is successfully committed, the editor SHALL
keep the label selected for the next region. The label SHALL change only when
the reviewer explicitly selects another label, clears it through an existing
label-control action, or changes interaction mode. This continuity SHALL NOT
enable region selection or relabeling in `标注` mode, and SHALL NOT change
`修改` mode behavior.

#### Scenario: Repeated boxes reuse one label

- **WHEN** the reviewer selects `person` in `标注` mode and commits two new
  bounding boxes
- **THEN** both boxes use `person` and `person` remains selected for the next
  box

#### Scenario: Explicit label selection changes the next box

- **WHEN** `person` is active and the reviewer selects `car`
- **THEN** the next new region uses `car` and the previous `person` selection
  is no longer active for drawing

#### Scenario: Mode transition clears drawing selection safely

- **WHEN** the reviewer changes between `标注` and `修改`
- **THEN** transient region/label selection is cleared according to the
  existing mode contract, and continuous drawing does not leak into `修改`
  mode

### Requirement: Refinement modes have keyboard shortcuts

While an opted-in refinement image is active, the editor SHALL support
`command+1` (`⌘1`) to enter `修改` mode and `command+2` (`⌘2`) to enter
`标注` mode on macOS. On non-macOS platforms the same commands SHALL use the
existing keymap convention of `Ctrl+1` and `Ctrl+2`. The shortcuts SHALL invoke
the same state transitions as the visible mode controls, SHALL be unavailable
for non-refinement images, and SHALL not intercept typing inside text inputs.

#### Scenario: Command-one enters edit mode

- **WHEN** a refinement image is active and the reviewer presses `⌘1`
- **THEN** the editor enters `修改` mode, selects the existing-region editing
  tool, and refuses new-region drawing

#### Scenario: Command-two enters annotation mode

- **WHEN** a refinement image is active and the reviewer presses `⌘2`
- **THEN** the editor enters `标注` mode, allows drawing over existing boxes,
  and preserves the currently chosen label for the next new region

#### Scenario: Shortcuts are scoped and session-local

- **WHEN** a non-refinement image is active, or focus is inside an input,
  textarea, or select control
- **THEN** the mode shortcuts do not change the editor state

#### Scenario: Shortcut state is not persisted

- **WHEN** the task, annotation, or page is reloaded
- **THEN** no shortcut or interaction-mode field is written to annotation
  results, task data, or exports

### Requirement: Refinement annotations use a session-local recent-edit stack

For an opted-in refinement image, the right-side annotation/outliner list SHALL
retain its effective default order until a qualifying annotation change occurs.
Creating a region, moving it, resizing it, or changing its label SHALL record
that object as the newest edit. After the first qualifying change, edited
objects SHALL be ordered newest-first, repeated edits SHALL move the object to
the top, and objects that have not been edited SHALL retain their prior
default-order relative position below the edited objects. Selection, hover,
hide/show, and lock actions SHALL NOT update the edit stack. An explicit user
choice of another outliner sort SHALL take precedence over the stack.

The edit stack SHALL be session-local and volatile: it MUST NOT change stored
annotation order, region IDs, serialized results, task data, or exports. Images
and projects without `drawOver="true"` SHALL retain their existing outliner
behavior.

#### Scenario: Initial order remains unchanged

- **WHEN** a refinement image is opened and no qualifying annotation change
  has happened
- **THEN** the annotation list uses the same effective default order as the
  existing outliner

#### Scenario: The latest edited object is placed first

- **WHEN** object A is moved and then object B is resized
- **THEN** object B is first, object A is next, and untouched objects follow in
  their original order

#### Scenario: Repeated edits behave like a stack

- **WHEN** object A is edited, object B is edited, and object A is edited again
- **THEN** the order is A, B, followed by the untouched objects

#### Scenario: Non-edit interactions do not reorder objects

- **WHEN** the reviewer selects, hovers, hides/shows, or locks an object
- **THEN** the recent-edit order is unchanged

#### Scenario: Manual sorting wins

- **WHEN** the reviewer explicitly selects another outliner ordering
- **THEN** the chosen ordering is displayed and the recent-edit stack does not
  silently override it

#### Scenario: Recent-edit state is not persisted

- **WHEN** the task or page is reloaded
- **THEN** the list starts from its effective default order and no edit-stack
  field appears in annotation results, task data, or exports
