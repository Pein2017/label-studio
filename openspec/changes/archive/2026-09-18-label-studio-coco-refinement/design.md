## Context

The selected source is the already normalized, nearly complete COCO pair at
`public_data/coco/rescale_32_1024_bbox_len12000/train.norm.jsonl` and
`public_data/coco/rescale_32_1024_bbox_len12000/val.norm.jsonl`.
Each row has immutable image identity and dimensions plus a non-empty `objects`
list whose boxes are integer `xyxy` coordinates on the inclusive `0..999`
lattice. Existing objects carry the official sparse COCO `category_id`, the
canonical English `category_name`/`desc`, and a positive `coco_ann_id`.

The source contains 117,266 train rows with 849,947 boxes and 4,952 validation
rows with 36,335 boxes. The selected rows contain no empty examples and no
non-positive boxes. Images already live under
`public_data/coco/rescale_32_1024_bbox/images/`; copying them into Label Studio
would add storage without adding provenance.

`label-studio/` is an upstream checkout (currently version `1.24.0.dev0`) and
already supplies image rectangle CRUD, region visibility/locking, zoom, label
filtering, tasks/projects, and ML-backend integration. CoordExp remains the
owner of data and inference semantics. The narrow UI behaviors that are not
native enough for this workflow are implemented at explicit Label Studio
extension points; project/data/inference ownership stays in the parent repo.

The pinned checkout can support the target shape through one Label Studio
instance and two projects, but its development runtime is not currently
bootstrapped: Yarn, frontend dependencies/build output, and the Python virtual
environment are absent. Source scale is also material: train alone contains
117,266 tasks, slightly above Label Studio's approximate 100k guidance. Runtime
bootstrap and progressive 1k/10k/full-project measurements are therefore Wave-0
gates rather than late launch checks.

The active inference implementation is `src/infer.py` plus
`src/inference/{pipeline,runtime,backend,prompt,parsing}.py`. The accepted
Qwen3-VL inference config and its exact prompt/parser contract remain the
authority. The older `src/infer/` package is historical and is not a service
API for this change.

The selected `.norm.jsonl` is the editing artifact, not a file the current Swift
loader can consume directly: that loader expects coordinate-token strings for
this seven-field source family. The legacy generic converter is not executable
in the live checkout because its referenced codec module is absent. This change
therefore owns a narrow, explicit norm-to-current-coord materializer and proves
its output through the actual loader; it does not introduce a new format or
change training input semantics.

This design intentionally supersedes the generic candidate/snapshot review
workflow described in `label-studio/AGENTS.md` only for this named change. The
user has selected a dynamic working dataset: successful inference results enter
the active editable annotation directly, durable Drafts accumulate across
images, and one explicit same-split batch Commit freezes those Draft snapshots
for asynchronous atomic publication. Queue acceptance returns before the
whole-file rewrite and never claims dataset success. Raw inputs remain
immutable and append-only queue/journal records preserve recovery and
provenance.

## Goals / Non-Goals

**Goals:**

- Provide one lightweight, single-user, same-machine loopback Web workflow with
  one Label Studio instance and distinct train/validation projects over the
  exact selected source.
- Reuse source images by reference and keep both source images and source JSONL
  byte-for-byte unchanged.
- Make bbox correction fast: add, resize, move, relabel, and delete official
  COCO-80 instances with keyboard-friendly canonical-name search.
- Make dense scenes legible with overlay-only focus/hide controls and visually
  distinct nearby inference-origin instances.
- Keep Draft state freely editable across Label Studio tasks while making one
  explicit same-split batch Commit the human gate into `working.norm.jsonl`,
  with background publication that never blocks later annotation/navigation.
- Run one ROI inference request at a time through a saved resident-model
  profile, invert an attested resize/letterbox transform, and insert valid
  results into the active annotation as ordinary editable boxes.
- Preserve enough receipts to recover interrupted commits and reproduce which
  model/profile/transform created an inference-origin box.
- Provide an explicit validated `working.norm.jsonl` to current coord-token
  materialization step without making it an automatic promotion.
- Keep the first delivery small enough to audit and operate locally.

**Non-Goals:**

- Arbitrary JSONL schemas, raw image-only tasks, or any input other than the
  exact `max_len12000` train/validation pair.
- COCO crowd regions, polygon/segmentation/rotated boxes, pixel masks, or model
  classes outside the official COCO-80 set.
- Chinese names, aliases, synonyms, or free-form object descriptions.
- Multi-user adjudication, permissions, remote SaaS deployment, queued/batch
  ROI requests, multiple concurrent dataset batches for one split, automatic
  active learning, or automatic dataset promotion.
- Automatic non-maximum suppression, duplicate deletion, replacement, or merge
  of existing and inferred boxes.
- Reviewed-empty Commit. V1 preserves an empty Draft but requires at least one
  object for Commit and coord materialization.
- LAN/remote-browser access or a desktop shell. Hard reload/tab close uses the
  browser-native Leave/Stay warning; rich asynchronous choices are in-app only.
- A new training/inference format. `.coord.jsonl` remains an explicit derived
  training surface produced from the committed working norm view.

## Decisions

### 1. Parent-owned adapter with narrow vendor UI extensions

The parent repository owns five cohesive components:

1. `Coco80Registry`: canonical English names and official sparse COCO IDs.
2. `RefinementProjectAdapter`: idempotent project/task bootstrap, fixed Label
   Studio config, image references, task identity, and manifest checks.
3. `WorkingDatasetStore`: validation, durable same-split batch enqueue,
   background all-or-nothing publication, queue/journal recovery, and
   generation receipts.
4. `WorkingCoordMaterializer`: explicit norm-int to current coord-token export
   with image-reference and loader attestation.
5. `RoiInferenceService`: profile loading, resident runtime calls, transform
   receipts, parser validation, and mapped result payloads.

The Label Studio checkout owns only presentation and interaction changes that
cannot be delivered through configuration/API: canonical fuzzy selection, the
AI Region control, direct insertion into the active annotation, inference-local
colors, focus controls, and the dirty-navigation/Commit affordance.

The browser calls the allowlisted parent service through a same-origin proxy
mounted beneath the Label Studio origin; it never sends an arbitrary filesystem
path. Label Studio's API/database owns mutable Draft persistence, while
`WorkingDatasetStore` owns frozen queue payloads and committed dataset truth. A
narrow authenticated Django enqueue seam selects only the current user's
authoritative project Drafts and copies their complete payloads, revisions, and
semantic hashes into the parent durable queue before returning `202`; it never
queues only mutable Draft IDs for later dereference. The batch worker consumes
only that immutable payload and never treats current live annotation state as
transaction input.

Alternatives considered:

- Building a new annotation UI was rejected because it would reimplement the
  mature rectangle editor, zoom, task navigation, and annotation state.
- Putting all logic inside Label Studio/Django was rejected because it would
  couple CoordExp data and model contracts to vendor internals.
- Running separate Label Studio instances per split was rejected because one
  instance with two isolated projects is simpler and already supplies project
  task/storage boundaries.
- Using read-only Label Studio `predictions` was rejected for the ROI path
  because the agreed interaction requires results to be immediately editable
  without an accept/copy step.
- Calling `src/inference/pipeline.py::run` online was rejected because that API
  owns offline JSONL planning, runtime construction, and run artifacts. The ROI
  adapter reuses owner-neutral prompt/parser/image/backend components without
  changing batch entrypoint, config, or artifact semantics.

### 2. Exact-source split projects and shared images

Bootstrap creates one Label Studio instance containing exactly two projects,
`train` and `val`, with one task per source row. Stable task identity is
`(split, image_id)` and the manifest also records source line number, source
path/hash, source and working image locator, image-root identity, storage ID,
adapter version, vendor revision, COCO-80 registry fingerprint, and label-config
fingerprint. Cross-split moves are not supported.

The runtime root is dedicated and ignored by Git:

```
outputs/label_studio_coco_refinement/rescale_32_1024_bbox_len12000/
  label-studio/
    state/
  train/
    project.json
    working.norm.jsonl
    task_index.json
    queue.jsonl
    journal.jsonl
    images -> /data/CoordExp/public_data/coco/rescale_32_1024_bbox/images
  val/
    project.json
    working.norm.jsonl
    task_index.json
    queue.jsonl
    journal.jsonl
    images -> /data/CoordExp/public_data/coco/rescale_32_1024_bbox/images
```

`working.norm.jsonl` is an ordinary derived file, not a symlink. Its atomic
replacement under the split transaction lock is the single dataset publication
authority; `project.json` and terminal log entries are verified projections of
that published file, not independent commit points. `task_index.json` is a
small immutable bootstrap sidecar mapping server-owned zero-based source-row
indexes to task/image identity; its hash and entry count are bound by
`project.json`. Immutable
semantic row fields (`file_name`, `image_id`, `width`, `height`, and source
metadata) are preserved. Because source `images[0]` values are relative to the
source JSONL directory, bootstrap deliberately rebases the working locator to
`images/{train2017|val2017}/...` and creates a validated managed link at each
split root. The manifest retains both locators and verifies the link resolves to
the one allowlisted shared image root. This changes location syntax, not image
identity or bytes.

For Label Studio image access, bootstrap sets the document root to the exact
shared images directory and idempotently creates project-bound local-file
storage records for `train2017/` and `val2017/`. A task is seeded with exactly
one editable `annotations` entity containing every source object; neither
source boxes nor ROI results use the read-only `predictions` collection. Native
creation/deletion of alternate annotations and native submit/skip paths are
disabled for these projects, while region CRUD remains enabled.

Startup fails closed on source hash, row identity, schema, image-link/storage,
class-registry, authoritative-annotation, or project-manifest drift.

### 3. Label Studio percentages are an editing view of the norm1000 lattice

Source imports map each norm1000 edge directly to Label Studio percentage space:

```
percent = 100 * bin / 999
```

Each authoritative region retains its stable region key and last committed
integer bbox. If its canonical geometry is unchanged, Commit reuses those exact
integers instead of re-quantizing binary floats. Edited rectangles use a
decimal/tolerance-aware outward quantizer: starts apply
`floor(percent * 999 / 100 + 1e-9)` and ends apply
`ceil(percent * 999 / 100 - 1e-9)`, then clip to `0..999` and require strict
`x1 < x2`, `y1 < y2`. Implementations must prove all 1000 edge bins through the
actual Label Studio JSON round trip; ordinary raw `floor/ceil` over binary
floats is forbidden because it expands known untouched end bins.

This rule is intentionally distinct from the executed inference parser's
current `round(bin * extent / 1000)` conversion. ROI inference first respects
that parser contract on the model canvas, then inverts the recorded letterbox
transform into original-image coordinates, and only then quantizes into the
working dataset's norm1000 lattice. Round-trip and boundary fixtures cover both
contracts separately, including `x + width` reconstruction in Label Studio.

### 4. Hidden identity and category compatibility

The UI exposes only the 80 official English class names. `Coco80Registry`
performs all name-to-official-sparse-ID mapping and rejects any unknown name or
name/ID mismatch. IDs are never editable in the browser.

Every imported region has a hidden stable region key mapped to its positive
`coco_ann_id`. Geometry and class edits preserve that mapping. A newly drawn or
inferred region becomes semantically associated with a stable split-local
negative integer ID at its first terminal-success batch. The worker may reserve
that ID earlier without making the region committed. The per-split allocator is
serialized under the worker lock, allocates deterministically across
source-row-ordered members, appends/fsyncs a reservation record before candidate
creation, and never reuses an issued ID. A reservation remains permanently bound
to `(split, stable_region_key)` across failure, recovery, or a corrected later
batch; another key can never receive it.
Region-key-to-ID mappings and tombstones are authoritative in the
journal/rebuildable store index and returned by the terminal receipt. They are
merged into equal or newer Draft metadata by stable region key without replacing
newer semantics; a lost response cannot cause a second allocation. IDs and
mapping metadata are never editable in the browser.

Committed objects contain only the current accepted object fields:
`bbox_2d`, `desc`, `category_id`, `category_name`, `coco_ann_id`, and optional
`metadata`. `desc` and `category_name` are the same canonical name. Output
objects preserve the current stable top-left ordering contract. The adapter
first orders known objects by their prior committed rank and new objects by
their stable creation ordinal, then applies the existing stable `(y1, x1)`
sort. Thus equal-top-left source objects retain their prior sequence rather than
being reordered by arbitrary UI order, while stable IDs carry identity across
ordinary geometry reorderings.

`working.norm.jsonl` is validated as the canonical editing output, not falsely
described as directly loader-compatible. On explicit operator request,
`WorkingCoordMaterializer` copies each committed row, replaces each norm integer
with the exact `<|coord_N|>` token, preserves IDs/classes/rebased image locators,
writes an atomic `working.coord.jsonl`, and proves it through the current Swift
loader. Its public constructor binds a real split-matched
`WorkingDatasetStore` and holds that store's exact
`committed_generation_guard` for the complete export; arbitrary callables and
the store's private raw recovery lock are not supported authority. The guard
fails closed on unresolved legacy or batch publication and projection drift,
then allows export after recovery. It refuses empty or otherwise invalid
working rows and does not promote the result automatically into a training
config.

### 5. Durable Draft catalog, asynchronous batch Commit, and recovery

Every task remains mutable through exactly one authoritative annotation.
Ordinary Label Studio saves update Draft state only. The authenticated Django
bridge records the durable server `draft_id`/`updated_at`, annotation identity,
canonical semantic hash, and complete result/meta payload for the current user.
There is no existing project-wide current-user Draft snapshot API, so the new
batch endpoint performs that bounded authoritative selection; browser-side task
enumeration and mutable Draft-ID-only queues are forbidden.

One explicit Commit coordinates a same-split batch:

1. If the active task has unsaved semantic changes, force/await its durable
   Draft save. Draft-save failure stops without creating a batch.
2. Select every eligible authoritative Draft whose semantic hash differs from
   its current committed baseline, attach the server-owned zero-based
   `source_row_index` (`source_line - 1` from the task manifest), sort members by
   that immutable order, require unique tasks and one split, and copy each full
   snapshot/revision/hash into an immutable payload. Capture per-row base hashes
   and the current base generation; global generation is provenance, while
   execution freshness is decided by each captured row hash. Enqueue verifies
   every index against the bootstrapped `(split, image_id)` task index and never
   trusts a browser-supplied position.
3. Derive `batch_payload_hash` over split, deterministic members, full retained
   metadata, Draft-save receipts, inference links, and row bases. Append/fsync a
   queue record keyed by `batch_id + batch_payload_hash`, then return `Queued`.
   This is not dataset Commit success and does not wait for candidate creation.
4. A single worker for that split claims the batch and acquires the dataset
   transaction lock. It validates every frozen member without rereading live
   Draft state. One invalid/stale row fails the whole batch before replacement.
5. Materialize all member rows in source-row order. For every unseen stable
   region key, append/fsync an explicit allocation-reservation journal record
   before candidate creation; it binds the negative ID permanently even when
   this batch later fails. Bind region mappings, tombstones, before/after rows,
   and receipt links to the batch/member identities. A corrected later batch for
   the same key reuses its reservation, while another key never can.
6. Under the split transaction lock, stream the exact currently published
   `working.norm.jsonl` once. Hash and count every input line while copying its
   original bytes or substituting validated canonical member bytes, and hash the
   candidate while writing. At end-of-stream, require the observed input hash,
   generation, explicit `working_line_count`, and row index to match the
   published manifest and bootstrapped task index. This
   proves the candidate derives from the last published generation without a
   separate pre-parse pass and preserves earlier committed rows. Fsync the
   candidate, then append/fsync the prepared transaction with both input and
   candidate attestations before replacement. A mismatch deletes/quarantines the
   candidate and fails closed before publication.
7. While still holding the transaction lock, atomically replace
   `working.norm.jsonl` with the complete candidate and fsync its directory. This
   replacement is the one dataset publication point: all members become
   committed together. Supported readers and the status endpoint take the same
   lock (or fail closed while recovery owns it), so they never observe the
   rename-before-fsync interval. Replace/fsync the manifest and append/fsync the
   authoritative transaction terminal projection before releasing the lock;
   then append the queue terminal projection. A crash before replacement leaves
   the prior generation authoritative. A crash after replacement is detected by
   the prepared candidate hash and is reconciled as the same successful
   generation before readers or another batch are admitted.

`queue.jsonl` is authoritative only for immutable enqueue identity and dispatch.
`journal.jsonl` plus the hash-attested published working file own allocation,
transaction, recovery, and terminal status. Queue running/terminal fields and
`project.json` are projections repaired from those authorities. Any disagreement
enters `Reconciling` and blocks another batch; no reader or admission decision is
made from the queue projection alone.

At most one batch is active per split; train and validation may run
independently. A second Commit while the split is active returns that batch
identity or remains unavailable, but Draft save, annotation, inference, and
navigation continue. No later Draft is auto-enqueued. Exact retries of
`batch_id + batch_payload_hash` return the existing queue/terminal receipt;
payload drift under the same ID conflicts. Startup reconstructs queued,
claimed, prepared, and post-replacement states and finalizes at most one new
generation. Queue and transaction locks are separate so a small durable enqueue
does not wait behind the full-file worker lock.

`working.norm.jsonl` remains an ordinary complete file at the last published
generation while a batch runs. Candidate construction never changes it, and
supported readers share the transaction/recovery barrier around publication.
The prior one-row implementation took 12.145
seconds because it parsed/validated the whole file, parsed it again during
rewrite, then rehashed the temporary file. The canonical batch path removes the
redundant passes but still measures full background wall time, amortized time per
member, RSS, bytes, fsyncs, and recovery. The foreground gate is structural: a
probe that blocks the worker before candidate creation must still observe a
durable enqueue response and successful independent Draft save/navigation.

V1 still rejects a batch containing a captured empty object list while
preserving that task as a Draft. Supporting reviewed-empty samples later
requires an explicit `verified_empty` working/training-projection change.

### 6. Nonblocking navigation, status overlays, and safe terminal merge

Task semantic state remains `Committed` or `Draft`; batch state is a separate
project/task overlay: `Queued`, `Running`, `Reconciling`, terminal `Succeeded`,
or terminal `Failed`. The UI also distinguishes `Draft ahead of active batch`
and `Draft ahead of committed batch`. Project generation, active batch ID,
member count, and Drafts accumulated after capture are displayed separately.
Queue acceptance never clears dirty state or changes the committed baseline.

All task-switch paths—row click, keyboard focus, Previous/Next, Back,
editor-close, route and popstate—pass through one navigation coordinator. It
awaits only the active durable Draft save and continues immediately afterward;
it never waits for queue processing or working-JSONL publication. A persistent
project-level pending-Draft count and Commit action replace per-navigation
Commit pressure. Polling through the existing query client is the initial
status transport; SSE remains a later browser-spike alternative rather than a
new dependency.

Each captured member carries
`batch_id + task_id + annotation_id + draft_id + draft_updated_at + queued_hash`.
On terminal success, the parent committed baseline/generation and stable ID
receipt update first. If the task is not loaded, the editor is untouched. If it
is loaded, the client reacquires the live annotation and may rehydrate the
committed snapshot plus reset history only when project/task/annotation,
durable Draft token/hash, and in-memory semantic hash all still equal the
captured token and no Draft save is running. Otherwise it merges only stable
identity/provenance metadata by region key and preserves newer geometry, class,
membership, Draft bytes, and post-enqueue undo history. Native Annotation save
is not used for terminal rebase because it deletes attached Drafts; persisted
mutation requires a transactional compare-and-swap endpoint or remains
parent-owned baseline state.

Hard reload/tab/window close uses the browser-native warning only for unsaved
in-memory edits. Durable Drafts and queued/running batches survive reload and do
not masquerade as unsaved local state. Enqueue failure creates no active batch;
terminal failure leaves the prior JSONL generation and every current Draft
intact with batch/member diagnostics. New semantic edits clear stale validation
errors but never erase durable batch status.

### 7. Canonical class search and dense-scene presentation

Class selection searches only `Coco80Registry` values. Ranking is deterministic:
exact match, prefix/substring match, then spelling distance. Case and repeated
whitespace are normalized for matching, but returned values are always the
canonical English names. There are no aliases, translated labels, synonyms, or
user-created labels.

Dense-scene controls affect overlays only; they never modify the image or
annotation payload. The reviewer can show all regions, dim non-selected
regions, hide non-selected regions, and restore all overlays. Per-region native
visibility remains available.

All uncommitted inference-origin regions in the active task participate in
versioned `visual_policy_v1`, including regions from sequential ROI requests.
Two boxes are color-neighbors when their norm1000 rectangles intersect after
each edge is expanded by 12 bins and clipped to `0..999`. Stable region keys are
sorted before deterministic greedy coloring from an accessible high-contrast
palette; palette exhaustion uses deterministic reuse plus a visible numeric
instance badge. A potential-duplicate cue is separately defined as same
canonical class with IoU at least `0.5`; it is advisory and never blocks Commit
or changes objects.

Request/region receipt IDs are persisted as non-training Draft metadata so
colors and conflict groups reproduce after save/navigation/restart. Canonical
class text remains visible. Color/group/badge state is presentation metadata,
not class or training metadata; Commit strips it from working objects, retains
journal links, and restores ordinary class colors. Insertion while other boxes
are hidden exits hide-non-selected and selects/flashes the new group; deleting
the focused region restores Show All.

### 8. Versioned resident-model profiles

An inference profile records a stable profile name, endpoint/bind target,
content-addressed fingerprints for resolved base weights, adapter/checkpoint,
embedding delta, tokenizer, model config, processor artifacts, resolved infer
config, and full system+user prompt policy; it also records parser/adapter/
ROI-transform versions, Transformers version, forced processor kwargs,
processor-derived patch/merge factor, default target width/height, axis and
total-pixel bounds, timeout/deadline policy, and optional runtime metadata.
Multiple profiles can be saved; exactly one is active per project, and the user
can switch through a compact selector. Activation/runtime matching fails before
inference if any payload changes at the same path. Journal/receipts record the
immutable resolved profile rather than only its display name. The evaluator's
contiguous category mapping is explicitly forbidden as a source for official
sparse COCO IDs.

The service assembles the current runtime once and keeps the selected backend
resident. It never invokes the offline pipeline run API. The already-letterboxed
canvas is passed through the accepted Qwen image path with `do_resize=False` and
the observed processor grid/canvas equality is asserted. Requests are
single-flight in V1 and carry a deadline/cancellation signal through generation;
the slot is released only after a terminal backend state. Cooperative stopping
and post-cancel model reuse are an early probe—failure blocks this resident
design rather than silently treating an HTTP timeout as cancellation.

### 9. One temporary ROI, explicit resolution, reversible mapping

AI Region is a temporary selection mode, not a COCO annotation class. The user:

1. draws one ROI on the original image;
2. chooses target width and height (default `1024 x 1024`, each divisible by
   the active profile's processor-derived factor, currently attested as `32`,
   and within its axis/total-pixel bounds);
3. clicks Infer and waits for the one request;
4. receives valid mapped boxes directly in the active editable annotation;
5. adjusts/deletes them normally, then continues with another ROI.

Drawing a new ROI replaces only the prior temporary ROI, never annotation
boxes. Existing and earlier inferred annotations remain. There is no implicit
context expansion: the submitted crop is exactly the selected ROI after
clipping to original-image bounds.

At submission the service freezes `request_id`, task ID/epoch, authoritative
annotation ID/revision, profile fingerprint, ROI, canvas, and pre-existing dirty
state. In-app task/annotation navigation plus ROI redraw, profile switching, and
resolution changes are locked until a terminal request state. Forced unload
marks the receipt `abandoned_before_insertion`; before insertion the browser
revalidates the frozen target, and any mismatch produces abandonment with zero
annotation mutation.

ROI percentages are converted to natural-image floating edges. The crop uses
clipped half-open integer edges
`[floor(left), floor(top), ceil(right), ceil(bottom))`. The adapter computes
`fit = min(canvas_w/crop_w, canvas_h/crop_h)`, rounds realized dimensions with a
versioned half-up rule, records the actual `scale_x` and `scale_y`, resizes once
with fixed Pillow bicubic resampling, and applies black centered letterbox
padding with the extra odd pixel on right/bottom. The same immutable transform
object prepares pixels and inverts boxes. The receipt records:

- task/image identity and immutable original width/height;
- floating and clipped integer ROI edges in original-image coordinates;
- crop edge convention, requested canvas, realized resize dimensions,
  `scale_x`/`scale_y`, each padding edge, resampler/pad value, pixel-center/edge
  convention, and pixel/processor fingerprint;
- resolved model/profile/checkpoint/template/parser identities;
- raw response text or durable content reference plus hash, parser status,
  parsed/inserted/rejected counts, and mapped result IDs.

For every parser-valid canvas box, mapping performs the inverse in this order:
remove padding, divide x/y by recorded `scale_x`/`scale_y`, clip to the ROI content rectangle,
offset by the ROI origin, clip to original-image bounds, and quantize to strict
norm1000 `xyxy`. Degenerate results after clipping are rejected and counted.
The same transform object used to prepare pixels owns the inverse operation;
parallel hand-written formulas are forbidden.

Terminal behavior is explicit:

- parser `accepted`: insert all mapped valid boxes atomically and clear ROI;
- `accepted_with_drops`: insert valid boxes atomically, show dropped reasons,
  and clear ROI;
- true parser `empty`: insert nothing, show zero, and clear ROI;
- syntactically valid parse whose classes/mappings are all rejected: insert
  nothing, show all-rejected reasons, and clear ROI;
- parser `all_spans_dropped` or `unsupported_format`: insert nothing and retain
  ROI as a response-level failure;
- transport/runtime/timeout/profile failure: insert nothing and retain ROI.

Every outcome preserves pre-existing Draft dirtiness. A successful insertion is
one undo step and marks the task dirty; zero/all-rejected/failure does not.

### 10. Direct insertion, equal status, and non-destructive conflicts

ROI output is class-validated against COCO-80 and inserted as ordinary editable
rectangle labels in the active annotation, not as read-only Label Studio
predictions and not behind a per-box accept/reject queue. Inference-origin
metadata remains in serializable result `meta` until Commit/reload for receipts,
but committed objects have the same training status and schema as human-created
objects. Direct insertion uses the existing active-annotation append seam as one
history action only after matching the frozen task/annotation epoch.

Inference appends to the active objects. It never removes, merges, relabels, or
changes an existing region. `visual_policy_v1` highlights same-class IoU>=0.5
potential duplicates and colors nearby instances for human inspection, with no
automatic NMS/replacement and no blocking conflict state. Terminal-success
dataset batch Commit is the sole human acceptance gate.

### 11. Local security and failure isolation

The approved V1 deployment is same-machine only. Label Studio and parent
services bind to loopback, while the browser reaches adapter/inference APIs
through an exact same-origin proxy namespace. State-changing requests require
Label Studio authentication, CSRF/capability protection, and expected
project/task/annotation/revision/generation; unknown origins or stale identities
are rejected. Direct credential-free cross-port mutation is forbidden.

Local image serving is rooted at the exact shared image directory, not the whole
repository or `/data`, and project-bound storage records restrict train/val
subdirectories. Paths and managed links are resolved and checked against that
root. Logs/receipts never include credentials. LAN access is out of V1 scope and
requires a later explicit bind/auth/CORS/image-serving change.

The fixed bbox project suppresses the rectangle `rotation` field/handle when
`canRotate=false`, and the parent Commit validator independently requires zero
rotation. This closes the native Info-panel path that would otherwise create an
unsupported rotated rectangle.

## Risks / Trade-offs

- **Background whole-file latency:** the complete 117,266-row JSONL is still
  rewritten for a batch, and image-count-independent wall time may remain
  material. Mitigation: one rewrite amortizes several samples, enqueue returns
  after only bounded durable queue publication, the worker uses one streaming
  copy/substitute/hash pass, and full wall time/RSS/amortized cost remain a
  measured operability gate rather than blocking the editor.
- **Frozen-snapshot versus newer-Draft races:** a queued task may be edited
  before terminal success. Mitigation: the queue stores full immutable payloads,
  workers never reread live Drafts, and terminal rebase is CAS-gated with
  identity-only merge for newer Drafts.
- **Label Studio scale/build feasibility:** the train project exceeds approximate
  100k guidance and the checkout lacks a ready frontend/runtime. Mitigation: pin
  Node/Yarn/Python receipts and probe 1k, 10k, then full task import/open/Next/
  Draft/restart latency and RSS before deep vendor work.
- **Vendor extension maintenance:** direct active-annotation insertion and the
  navigation guard touch Label Studio frontend behavior. Mitigation: isolate
  patches, pin the vendor revision, add browser-level fixtures, and avoid
  rewriting native rectangle CRUD.
- **Coordinate off-by-one drift:** source preparation, Label Studio floats, and
  the current inference parser use different scale conventions. Mitigation:
  preserve unchanged bins, use tolerance-aware quantization, record the full
  discrete affine/raster transform, and run exhaustive/browser golden tests.
- **Draft/working divergence:** Label Studio state can intentionally be newer
  than the last terminal JSONL and newer than an active frozen batch.
  Mitigation: one authoritative annotation, durable Draft catalog, explicit
  pending counts, per-task semantic hashes, batch overlays, idempotent status,
  and explicit outcome reconciliation.
- **Identity leakage/collision:** new boxes do not have official COCO annotation
  IDs. Mitigation: negative split-local allocator, tombstones, uniqueness checks,
  and a loader smoke over derived data.
- **Dense colors mistaken for labels:** instance colors could look semantic.
  Mitigation: keep class text visible, scope colors to uncommitted inference
  regions, and restore class colors after Commit.
- **Model/runtime coupling:** online inference could accidentally fork accepted
  offline semantics or time out while generation keeps running. Mitigation: a
  new adapter over owner-neutral components, full profile fingerprints,
  no-resize grid assertions, cancellation probes, and one real-profile smoke.
- **Local file exposure:** Label Studio local-file serving can expose too broad a
  root. Mitigation: exact project storage records, same-origin proxy protection,
  exact image-root allowlisting, and loopback-only binding.

## Migration Plan

1. Record source hashes, row/box counts, COCO-80 registry fingerprint, and the
   pinned Label Studio revision in fixtures; do not modify current data.
2. Implement/test durable multi-row enqueue, all-or-nothing batch publication,
   one-pass full-file replacement, and every queue/transaction crash boundary;
   separately measure foreground enqueue and background 1k/10k/full-train
   completion while retaining the 12.145-second synchronous result as redesign
   provenance.
3. Pin/build the Label Studio runtime and run exact source-annotation seeding,
   current-user Draft capture, nonblocking status/rebase, fake-backend direct
   insertion, and 1k/10k/full project scale probes.
4. Implement/test the remaining parent registry/project/store/materializer boundary, then
   bootstrap disposable train/val projects under the ignored runtime root with
   managed image links and storage records.
5. Implement the minimal editing UI extensions, project batch action/status,
   Draft-save navigation coordinator, CAS-safe terminal merge, and fake-backend
   browser flow.
6. Implement the resident ROI adapter/profile/discrete-transform boundary,
   deadline cancellation, and one real-profile smoke using the accepted
   CoordExp prompt/parser/no-resize path.
7. Validate working norm JSONL, explicitly materialize a bounded coord sample,
   load it with the current training loader, and attest source hashes are
   unchanged.
8. Perform user acceptance on a small train/val slice before opening the full
   projects. Rollback removes only the dedicated runtime root and vendor patch;
   immutable source artifacts need no restoration.

## Approved Product Decisions

- V1 rejects empty Commit but preserves an empty Draft.
- V1 is same-machine and loopback-only; no LAN browser access.
- V1 captures all eligible durable Drafts from one split into one immutable,
  all-or-nothing batch; at most one dataset batch is active per split.
- Durable enqueue returns before whole-file publication and is never presented
  as committed success. Annotation, inference, Draft save, and navigation remain
  available while the worker runs.
- `working.norm.jsonl` remains a complete ordinary last-terminal-generation
  file and changes only at atomic terminal batch success.
- Later edits to captured tasks remain newer Drafts and cannot be overwritten
  by terminal rebase; freshness is per-row base hash rather than unrelated
  global-generation equality.
- In-app navigation awaits only durable Draft save; hard reload/tab close uses
  the browser-native warning only for unsaved in-memory edits.

## Open Questions

None before implementation. If cooperative model cancellation cannot be made
safe while retaining a resident backend, implementation pauses and returns for
an explicit process-isolation/runtime decision.
