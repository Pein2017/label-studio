## 1. Characterize the current refinement seams

- [x] 1.1 Add a focused label-order test fixture with repeated, hidden, zero-count, and tied labels; verify it records the current order and provides a failing expectation for frequency-first presentation.
- [x] 1.2 Add a regression test for selecting one label and committing two new regions in `标注` mode; verify the test fails if the label is cleared between commits and passes only when the selected label remains active.
- [x] 1.3 Add shortcut-routing tests for macOS/non-macOS keymap entries, non-refinement no-op behavior, current-annotation routing, and input focus; verify they fail before the new bindings exist.

## 2. Implement frequency-first label presentation

- [x] 2.1 Implement a pure stable ordering helper that ranks direct refinement labels by current-image usage count descending and original child index ascending; verify tie/zero-count and hidden-region cases with unit tests and assert that the source children remain unchanged.
- [x] 2.2 Wire the helper into the opted-in labels renderer and preserve the existing tree path for non-`drawOver` or mixed/non-label controls; verify create/delete/relabel updates reorder the visible labels without changing label hotkeys or export/config order.

## 3. Implement continuous annotation-label behavior

- [x] 3.1 Make the smallest draw-over commit-path change needed by the characterization test so `annotate` mode retains the active label after a successful region commit; verify explicit label changes still affect only the next region.
- [x] 3.2 Re-run mode guards around canvas, outliner, tool selection, and label selection; verify `修改` mode still rejects new-region drawing while existing-region edits remain available.

## 4. Add mode shortcuts

- [x] 4.1 Add named keymap entries for `Ctrl+1`/`Ctrl+2` and `Command+1`/`Command+2` with concise descriptions; verify keymap validation and platform lookup pass.
- [x] 4.2 Register the shortcuts through the existing hotkey lifecycle, resolve the active refinement image at invocation time, and call the existing mode transition action; verify mode changes, input filtering, and non-refinement no-op behavior through focused tests.
- [x] 4.3 Surface the shortcut hints on the existing refinement mode controls without adding a second toolbar or listener; verify accessible mode controls and shortcut labels render together.

## 5. Add the recent-edit annotation stack

- [x] 5.1 Add a failing Outliner/RegionStore test that proves the initial effective default order is unchanged before edits and that a qualifying edit moves one object to the top while untouched objects retain baseline order.
- [x] 5.2 Add session-local monotonic edit recency state without mutating `ouid`, region IDs, snapshots, or exports; verify repeated edits produce newest-first stack order and a newly created object enters at the top.
- [x] 5.3 Route touch notifications only from committed creation, geometry, and label changes; verify selection, hover, hide/show, lock, and in-progress pointer movement do not reorder the list.
- [x] 5.4 Make explicit user-selected Outliner sorting take precedence over the recent-edit stack; verify ordinary non-`drawOver` projects retain existing sorting behavior.
- [x] 5.5 Add a focused Outliner/browser regression covering the right-side list after two edits and a reload; verify the live session reorders correctly and reload starts from the default without writing annotation data.

## 6. Integration gate

- [x] 6.1 Run the focused editor unit suites for labels, image interaction, hotkeys, Outliner, RegionStore, and existing refinement mode guards; verify all new and prior tests pass and report unrelated pre-existing failures separately.
- [x] 6.2 Rebuild the frontend and verify the served bundle contains label ordering, continuous-label, shortcut, and recent-edit stack behavior; browser-smoke project 3 in both modes without changing task annotations.
- [x] 6.3 Run `openspec validate label-studio-annotation-productivity --type change --strict`, inspect the exact diff and worktree status, and record that no backend/data/export files changed.
