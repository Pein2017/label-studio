## Why

COCO 2017 contains missed and occasionally incorrect instance boxes, while the current correction loop requires ad hoc inspection and cannot safely turn a fine-tuned detector's local suggestions into continuously maintained training JSONL. A lightweight localhost workflow built on the existing Label Studio checkout can preserve CoordExp's data contracts while making per-image correction, dense-scene review, and ROI-assisted annotation practical.

## What Changes

- Add one single-user Label Studio instance with independently governed `train` and `val` projects for the exact processed inputs `public_data/coco/rescale_32_1024_bbox_len12000/train.norm.jsonl` and `public_data/coco/rescale_32_1024_bbox_len12000/val.norm.jsonl`; reuse the existing images through validated references and never copy or mutate source images or source JSONL.
- Add an external CoordExp adapter that imports source objects into exactly one authoritative editable annotation per task, maintains a separate mutable `working.norm.jsonl` per split, and provides an explicit validated norm-to-current-coord materializer for training handoff.
- Make split-level batch `Commit` the human gate: the reviewer may edit and durably save Drafts across several images, then enqueue those exact snapshots once. Durable enqueue returns without waiting for the whole-file rewrite; one background worker applies the same-split batch atomically, while later edits remain newer Drafts and lost responses enter reconciliation rather than claiming failure.
- Provide bbox-only COCO-80 editing with the official English class names, spelling-tolerant search limited to those names, fast create/update/delete operations, navigation guards, and dense-scene overlay focus/hide controls.
- Distinguish nearby uncommitted inference-origin instances with a versioned deterministic high-contrast coloring policy, while preserving class identity as text and returning committed regions to the ordinary class-color presentation.
- Add saved inference profiles and a simple target-bound single-request ROI flow: draw one temporary ROI, select a default-1024-by-1024 target whose dimensions follow the processor-derived patch factor, reuse the current CoordExp prompt/parser/backend components through a new resident adapter without modifying offline batch inference, map results back through a replayable discrete letterbox transform, and insert valid results directly as editable annotations.
- Preserve existing boxes during inference. Potential duplicates are highlighted for human review but are never silently suppressed, replaced, or merged.
- Keep the first implementation single-user, same-machine, and loopback-only. In-app navigation durably saves the active Draft and continues; a persistent pending-Draft count/reminder drives explicit batch Commit, while hard reload/tab close uses the browser-native warning only for unsaved local edits. The first implementation does not support arbitrary JSONL schemas, image-only/no-coordinate tasks, COCO crowd regions, polygons or masks, pixel-level masking, reviewed-empty Commit, multi-user adjudication, multiple concurrent dataset batches per split, queued/batch ROI inference, or automatic dataset promotion.

## Capabilities

### New Capabilities

- `coco-refinement-projects`: Exact-source project bootstrap, immutable input/shared-image reuse, train/val separation, authoritative Draft plus asynchronous same-split batch Commit behavior, dynamic norm JSONL, coord materialization, journaling, and recovery.
- `coco-bbox-editing`: COCO-80 bbox CRUD, canonical-name search, dense-scene visualization, inference-origin coloring, durable Draft navigation, pending-batch status, and nonblocking background-Commit feedback.
- `coco-roi-inference`: Versioned inference profiles, temporary ROI interaction, target-resolution constraints, current-template model execution, reversible coordinate mapping, and direct editable result insertion.

### Modified Capabilities

None. Existing CoordExp data, inference, evaluation, and visualization contracts remain authoritative; this change adds adapters and UI behavior around them rather than changing their supported semantics.

## Impact

- Parent-repo adapter/service/config/test surfaces will be added outside the upstream checkout for project bootstrap, image-reference rebasing, JSONL synchronization/materialization, journaling, COCO category mapping, and ROI inference.
- A narrowly scoped Label Studio frontend extension is expected for rotation suppression, authoritative Commit coordination, AI Region controls, direct result insertion, canonical-name fuzzy selection, collision coloring, focus controls, and navigation guards. Upstream code remains vendor-owned outside those explicit extension points.
- Runtime state and mutable artifacts will live under a dedicated ignored output root, with one Label Studio state subtree, separate `train`/`val` data subtrees, and validated managed links to `public_data/coco/rescale_32_1024_bbox/images/`.
- Browser calls use a same-origin proxy to loopback services; Label Studio local-file storage records are bootstrapped per split rather than relying only on environment variables.
- The resident ROI adapter will reuse the checked-in coordexp-infras prompt, parser, no-resize image path, and backend components; the stable offline batch entrypoint/config/artifact behavior is unchanged.
- Implementation is gated before deep UI work on deterministic coordinate round trips, durable-enqueue and atomic-batch fault injection, fake-backend direct insertion, 1k/10k/full-project Label Studio scale probes, a foreground nonblocking-enqueue probe, full-size background batch throughput/RSS measurements, and one real-profile ROI smoke. Queue acceptance is not reported as dataset Commit success. The complete ordinary JSONL advances only at its atomic working-file publication point; after barrier-protected reconciliation, the terminal batch receipt reports that same published generation.
