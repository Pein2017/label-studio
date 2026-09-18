## 1. Characterize the interaction boundary

- [x] 1.1 Add focused tests for default refinement mode, mode controls, and no-selection behavior over overlapping regions.
- [x] 1.2 Add focused tests for edit-mode drawing rejection, label-click no-op without a selected region, and ordinary non-`drawOver` behavior.

## 2. Implement the shared mode contract

- [x] 2.1 Add volatile `annotate`/`edit` state and a mode transition action on image controls; verify transitions clear transient state and select `MoveTool` only for edit mode.
- [x] 2.2 Enforce edit-mode drawing rejection and annotate-mode region-selection rejection in the shared tool manager, label-selection path, image/rectangle hit testing, and outliner; verify focused unit tests pass.
- [x] 2.3 Render accessible `标注`/`修改` controls using existing toolbar primitives, with one active mode and no controls for non-`drawOver` images; verify component tests pass.

## 3. Integration verification

- [x] 3.1 Run the focused editor Jest suites for ImageView, Image, Label, ToolsManager, and outliner interactions; record unrelated pre-existing failures separately.
- [x] 3.2 Rebuild the frontend, verify the served bundle contains the mode implementation, confirm `/api/health` is `UP`, and browser-smoke project 3 for both modes without changing task annotations.
- [x] 3.3 Run `openspec validate label-studio-explicit-annotation-edit-modes --type change --strict`, inspect the exact diff, and record the local runtime/commit status; do not push unless separately requested.
