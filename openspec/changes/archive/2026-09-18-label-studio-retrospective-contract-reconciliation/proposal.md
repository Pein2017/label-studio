## Why

Several durable Label Studio customizations were implemented before they were
captured in a coherent OpenSpec lifecycle.  The repository now has executable
code, tests, runtime evidence, and several overlapping historical changes, but
no single current contract that distinguishes implemented behavior from
superseded ideas and one-off operator setup.  This reconciliation records the
as-built refinement contract without rewriting Git history or claiming that the
old implementation was OpenSpec-driven.

## What Changes

- Create an evidence-backed inventory of the refinement customizations and
  classify each surface as `covered`, `superseded`, `missing`, or
  `operational-only`.
- Establish one current, upstream-first refinement contract for the durable
  user-visible behavior: native label-driven continuous bbox drawing, safe
  existing-region selection for overlapping boxes, native visibility and
  crosshair behavior, relation-free refinement payloads, self-contained
  norm1000 GT publication, and source-image identity display.
- Reconcile the existing Label Studio changes instead of duplicating them:
  preserve older mode-toolbar and shortcut requirements as historical evidence
  and mark them superseded by the upstream-first direction where applicable.
- Capture stable runtime boundary behavior separately from annotation
  semantics, including loopback auto-login and local-file serving, without
  turning tmux commands or browser sessions into product requirements.
- Record implementation and verification evidence by commit, test, browser
  smoke, API response, and export artifact.  This is a retrospective
  documentation/reconciliation change; it does not modify Label Studio code,
  source annotations, COCO JSONL, or runtime state.
- After the contract is accepted, sync only the stable requirements into
  `openspec/specs/` and archive or supersede completed historical changes.

### Retrospective inventory (initial)

| Surface | Current classification | Existing evidence or owner |
| --- | --- | --- |
| COCO refinement project, source subset, and norm1000 bbox GT publication | `covered` | `label-studio-coco-refinement`, `coco-refinement`, `fc898cfde`, `label_studio/coordexp_refinement/` |
| Native-first continuous drawing, overlap-safe bbox selection, visibility, crosshair, relation-free refinement boundary, and right-click cancellation | `covered; verification receipts should be consolidated` | `label-studio-upstream-first-refinement`, `e18616ccc`, `web/libs/editor/src/components/ImageView/`, `web/libs/editor/src/mixins/DrawingTool.js` |
| Explicit `标注`/`修改` toolbar and `Cmd/Ctrl+1/2` shortcuts | `superseded` | `label-studio-explicit-annotation-edit-modes`, `label-studio-annotation-productivity`; later upstream-first decision removes the custom toolbar/keymap contract |
| Image-local label frequency ordering and session-local recent-edit stack | `covered; needs canonical current-spec wording` | `label-studio-annotation-productivity`, `web/libs/editor/src/tags/control/Labels/`, `web/libs/editor/src/stores/RegionStore.js` |
| Loopback auto-login | `covered; missing from the current stable contract` | `c50519867`, `label_studio/` auth/runtime changes |
| Source image identifier display | `covered; missing from the current stable contract` | `d78db325c`, editor image identifier changes |
| Local-file path boundary and image serving | `covered by implementation; operational contract to be separated` | `b8d5bb6f5`, `label_studio/tasks/` local-file route |
| tmux commands, browser port, and one-off task import state | `operational-only` | Runtime/session evidence; not a product capability |
| Empty `label-studio-refinement-bbox-visibility` change scaffold | `unresolved historical residue` | Existing scaffold has no proposal/spec/design/tasks; decide whether to absorb or retire it |

## Capabilities

This phase intentionally has no spec delta.  It is a retrospective
documentation and evidence-reconciliation change, so `skip_specs: true` is set
in `.openspec.yaml`.  The inventory identifies the candidate stable capability
that should be promoted in a later, user-reviewed spec change; it does not
silently create a new normative contract in this phase.

## Impact

- OpenSpec only: the parent `/data/CoordExp` planning repository and its
  existing Label Studio change records.
- Evidence sources: the Label Studio Git history, current frontend/backend
  tests, the local Project 3 API and image-serving route, the served frontend
  bundle, and the refinement GT JSONL/export boundary.
- No application code, database, source image, annotation, or generated GT
  artifact is changed by this proposal.
- The reconciliation must keep the Label Studio fork and the parent OpenSpec
  repository as separate Git histories; both need explicit commits if the
  records are to be durable.
