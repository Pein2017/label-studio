## ADDED Requirements

### Requirement: Dynamic refinement label digit shortcuts

The refinement label control MUST assign digit shortcuts `1` through `9` to
the first nine labels in the current image's descending usage-count order.
Ties MUST retain the label configuration order.  Labels after the ninth MUST
not receive one of these refinement digit shortcuts.

#### Scenario: Frequency order drives digits

- **GIVEN** a refinement image whose label counts are `car=5`, `person=2`,
  and `bird=0`
- **WHEN** the label control is rendered and its hotkeys are active
- **THEN** `car` is bound to `1`, `person` to `2`, and `bird` to `3`

#### Scenario: Count updates rebind the same labels

- **GIVEN** the current image has `person` as the most-used label
- **WHEN** an edit makes `car` the most-used label
- **THEN** the active digit binding and displayed shortcut move with the new
  order without changing any result/config identity

#### Scenario: Ordinary projects remain native

- **GIVEN** an ordinary non-refinement labeling project
- **WHEN** its labels are rendered
- **THEN** its configured/generated Label Studio hotkeys remain unchanged

### Requirement: Single-candidate refinement selection

In refinement edit mode, a canvas click without Command/Ctrl MUST select only
one editable, visible rectangle: the smallest containing rectangle, with the
existing recent-edit and bounded-distance tie-break rules.  The selection MUST
clear any other selected rectangles.

#### Scenario: Nested boxes choose the smallest one

- **GIVEN** a large editable bbox contains a smaller editable bbox
- **WHEN** the user clicks inside both without a modifier
- **THEN** only the smaller bbox is selected

#### Scenario: Command/Ctrl is additive

- **GIVEN** one bbox is already selected
- **WHEN** the user clicks another candidate while holding Command on macOS or
  Ctrl on other platforms
- **THEN** the candidate is toggled additively and the existing selection is
  preserved

#### Scenario: Modifier state does not leak

- **GIVEN** a previous click used Command/Ctrl
- **WHEN** the next refinement click has no modifier held
- **THEN** it is treated as a single selection and cannot select multiple
  overlapping boxes
