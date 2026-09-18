## Why

The refinement sidebar already presents labels by the current image's usage
count, but the label hotkeys still follow the static model order.  This makes
the most common classes slower to use and lets the display order disagree with
the keyboard order.  In the same refinement edit path, a retained Command/Ctrl
modifier can leak into a later click and cause several overlapping boxes to be
selected instead of the single smallest target.

## What Changes

- Bind the first nine refinement labels in current usage order to `1` through
  `9`, with stable source order as the tie-breaker.
- Keep the dynamic binding and its visible tooltip refinement-scoped; ordinary
  Label Studio projects retain their configured/native hotkeys.
- Rebind the refinement label digits when the current image's label counts
  change, without changing annotation result serialization or label identity.
- Make a no-modifier refinement canvas click select exactly one smallest
  visible containing rectangle; Command/Ctrl remains the explicit additive
  multi-select gesture.
- Stop reusing a previous pointer's Command/Ctrl state for refinement region
  clicks, and preserve upstream behavior outside the refinement project.

## Capabilities

### New Capabilities

- `label-studio-refinement-label-hotkeys-single-selection`: Dynamic top-nine
  label shortcuts and single-candidate refinement canvas selection.

### Modified Capabilities

- None.  The repository has no stable Label Studio capability spec; this
  change records the opt-in refinement behavior directly.

## Impact

- Frontend editor label ordering/hotkey registration and focused tests.
- Refinement rectangle click-through handling and focused tests.
- No API, annotation-result schema, relation payload, or ordinary-project
  behavior changes.
