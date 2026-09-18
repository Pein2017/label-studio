## ADDED Requirements

### Requirement: Saved versioned inference profiles
The system SHALL support multiple saved inference profiles and SHALL resolve one
active profile per project with content-addressed base-weight, adapter/
checkpoint, embedding-delta, tokenizer, model-config, processor-artifact,
resolved-infer-config, full system+user prompt-policy, parser/adapter/
ROI-transform, Transformers/forced-processor-kwargs, endpoint,
processor-derived patch factor, axis/total-pixel bounds, deadline, and runtime
identity. Profile activation SHALL fail before inference when any payload drifts
at an unchanged path.

#### Scenario: Reviewer switches profile
- **WHEN** the reviewer selects another valid saved profile
- **THEN** later ROI requests use and record its resolved immutable profile fields

#### Scenario: Profile identity drift is detected
- **WHEN** the endpoint runtime does not match the selected profile fingerprint
- **THEN** the request fails before annotation mutation and reports the mismatch

#### Scenario: Checkpoint bytes change at the same path
- **WHEN** resolved base, adapter, embedding-delta, tokenizer, or processor content no longer matches its saved fingerprint
- **THEN** profile activation fails before runtime inference even though the configured path is unchanged

### Requirement: Resident current CoordExp inference path
The inference service SHALL assemble and keep the selected backend resident,
SHALL reuse the accepted current coordexp-infras prompt, parser, no-resize Qwen
image path, and response grammar, and SHALL NOT call or alter the offline batch
pipeline entrypoint/config/artifact behavior. The already-letterboxed canvas
SHALL execute with `do_resize=False` and an asserted processor grid/canvas match.

#### Scenario: Valid ROI request executes
- **WHEN** an active profile and model are ready
- **THEN** the request uses the profile-pinned current prompt/parser/backend components and records their complete identities in its receipt

#### Scenario: Unsupported response class is parsed
- **WHEN** a parsed object name is outside canonical COCO-80
- **THEN** that result is rejected and never inserted as a new class

#### Scenario: Contiguous evaluator category mapping is offered
- **WHEN** category IDs are resolved for a parsed canonical class
- **THEN** the service uses the official sparse COCO registry and rejects reuse of the evaluator's contiguous 1-to-80 mapping

### Requirement: AI Region is temporary selection state
The editor SHALL provide an AI Region mode that holds at most one temporary ROI
and SHALL not serialize that ROI as a COCO object or working-data bbox.

#### Scenario: Reviewer draws an ROI
- **WHEN** AI Region mode is active and the reviewer drags over the image
- **THEN** one temporary ROI appears independently of the annotation object list

#### Scenario: Reviewer draws another ROI before inference
- **WHEN** a temporary ROI already exists
- **THEN** the new ROI replaces only the prior temporary ROI and leaves all annotations unchanged

### Requirement: Explicit patch-aligned resolution
The ROI controls SHALL default to width `1024` and height `1024`, SHALL permit
the reviewer to set width and height independently, and SHALL accept only values
divisible by the active profile's processor-derived factor (attested as `32` for
the accepted profile) and within its axis and total-pixel bounds.

#### Scenario: Valid rectangular target is selected
- **WHEN** the reviewer chooses `1280 x 768` and both dimensions are profile-valid multiples of the derived factor
- **THEN** the Infer action can submit that exact requested canvas size

#### Scenario: Invalid dimension is entered
- **WHEN** either dimension is non-positive, misaligned, or outside axis/total-pixel profile bounds
- **THEN** Infer remains unavailable and the editor explains the constraint

### Requirement: Single simple request flow
The editor SHALL submit at most one ROI inference request at a time and SHALL
require only a temporary ROI, valid resolution, active profile, and explicit
Infer action. Submission SHALL freeze request ID, task epoch, authoritative
annotation ID/revision, profile, ROI, canvas, and pre-existing dirty state;
in-app navigation plus ROI/profile/resolution changes SHALL remain locked until
a terminal backend state.

#### Scenario: Inference is running
- **WHEN** one ROI request is in flight
- **THEN** the request status is visible and another Infer action cannot start

#### Scenario: Prior ROI results exist
- **WHEN** the reviewer draws and infers a later ROI
- **THEN** prior annotation boxes remain and the later valid results append to the active annotation

#### Scenario: Target changes before a held response returns
- **WHEN** forced unload or a mismatched task/annotation epoch detaches the frozen request target
- **THEN** the receipt becomes abandoned-before-insertion and no annotation is mutated

#### Scenario: Request deadline expires
- **WHEN** generation reaches its profile deadline
- **THEN** cooperative cancellation reaches a terminal backend state before the single-flight slot is released and no late result is inserted

### Requirement: Exact clipped crop without hidden context
The system SHALL convert ROI percentages to natural-image floating edges, clip
them to immutable bounds, and use half-open integer crop edges
`[floor(left), floor(top), ceil(right), ceil(bottom))` as the exact crop without
automatic expansion, object completion, or hidden surrounding context.

#### Scenario: ROI crosses an image edge
- **WHEN** part of the temporary ROI lies outside the source image
- **THEN** the crop and receipt use the clipped in-bounds rectangle

#### Scenario: ROI is degenerate after clipping
- **WHEN** clipping leaves zero width or height
- **THEN** the request is rejected before model execution

### Requirement: Deterministic aspect-preserving letterbox
The inference adapter SHALL fit the exact ROI crop to the canvas using a
versioned half-up realized-size rule, record actual `scale_x`/`scale_y`, resize
once with fixed Pillow bicubic resampling, add black centered letterbox padding
with odd extra pixels on right/bottom, and use one immutable transform object for
pixel preparation and inverse mapping.

#### Scenario: ROI aspect differs from canvas
- **WHEN** a wide ROI is submitted to a square canvas
- **THEN** the receipt records realized width/height, both effective scales, every padding edge, resampler, and pad value without a second processor resize

#### Scenario: Transform is replayed
- **WHEN** the same source pixels, ROI, canvas, and processor version are prepared again
- **THEN** the same canvas and transform receipt are produced

### Requirement: Layered coordinate contracts remain explicit
The system SHALL distinguish source norm1000-to-percentage editing conversion,
the executed parser's canvas-bin-to-pixel conversion, the ROI letterbox inverse,
and final original-image-to-norm1000 quantization, with no unrecorded reuse of
one layer's scale formula in another.

#### Scenario: Full-image border box is round-tripped
- **WHEN** a golden bbox touches accepted norm1000 boundaries and is imported then committed without editing
- **THEN** its norm1000 coordinates remain unchanged

#### Scenario: ROI result maps through padding
- **WHEN** a parser-valid canvas bbox intersects the unpadded crop content
- **THEN** padding removal, x/y scale inversion, ROI offset, image clipping, and tolerance-aware outward norm1000 quantization occur in that order

### Requirement: Invalid mapped results are never inserted
Each parsed result SHALL be class-validated, inverse-mapped, clipped to ROI and
original-image content, quantized, and checked for strict non-degenerate
norm1000 `xyxy`; rejected results SHALL be counted with reasons.

#### Scenario: Result lies entirely in letterbox padding
- **WHEN** inverse mapping has no positive-area intersection with crop content
- **THEN** that result is rejected and no bbox is inserted for it

#### Scenario: Mixed valid and invalid results return
- **WHEN** the model cycle completes with both valid and rejected rows
- **THEN** all valid results are inserted together and the UI reports parsed, inserted, and rejected counts

### Requirement: Successful results enter the active annotation directly
All valid ROI results SHALL be inserted in one action as ordinary editable
COCO-80 rectangles in the frozen authoritative annotation, with serializable
inference-origin receipt metadata but without a prediction-copy or per-box
acceptance step. Insertion SHALL be one undo action and SHALL revalidate the
captured task/annotation epoch immediately before mutation.

#### Scenario: Model returns valid objects
- **WHEN** transport, execution, parsing, and mapping complete successfully
- **THEN** valid boxes appear immediately in the active editable annotation and mark the task dirty

#### Scenario: Inferred box is committed
- **WHEN** the reviewer leaves, adjusts, or relabels an inserted box and its frozen Draft snapshot reaches terminal success in a dataset batch
- **THEN** it is materialized with the same working-row status and schema as a human-created box; durable batch enqueue alone does not claim that status

### Requirement: ROI lifecycle follows request outcome
The editor SHALL implement this exact outcome table while preserving any
pre-existing Draft dirtiness: `accepted` inserts valid boxes and clears ROI;
`accepted_with_drops` inserts valid boxes, reports drops, and clears ROI; true
`empty` reports zero and clears ROI; valid parse with all class/mapped results
rejected reports all-rejected and clears ROI; `all_spans_dropped` or
`unsupported_format` mutates nothing and retains ROI; transport/runtime/timeout/
profile failure mutates nothing and retains ROI.

#### Scenario: Model returns no objects successfully
- **WHEN** the request completes with a valid empty result set
- **THEN** no annotation is added, the zero count is visible, and the temporary ROI clears

#### Scenario: Request fails before a valid result cycle
- **WHEN** transport, timeout, runtime, profile, `all_spans_dropped`, or `unsupported_format` fails
- **THEN** no annotation changes, the temporary ROI remains for retry, and the error is visible

#### Scenario: Valid parse has only rejected rows
- **WHEN** syntax is valid but every class or mapped geometry is rejected
- **THEN** no annotation is added, rejection reasons are visible, and the temporary ROI clears

#### Scenario: Partial valid response completes
- **WHEN** valid mapped rows and dropped rows are both present
- **THEN** valid rows are inserted atomically as one undo action, dropped reasons are visible, and the temporary ROI clears

### Requirement: Inference never changes existing objects automatically
The ROI path SHALL append valid new regions and SHALL never silently suppress,
replace, merge, relabel, resize, or delete an existing or newly returned region.

#### Scenario: Inferred box overlaps an existing box
- **WHEN** an inserted result has the same canonical class and IoU at least `0.5` with another box
- **THEN** both boxes remain and the editor highlights/groups the conflict for human review

#### Scenario: Several returned boxes overlap each other
- **WHEN** the model returns nearby or overlapping instances
- **THEN** every valid instance remains independently selectable and no automatic NMS runs

### Requirement: Complete inference receipts
Every completed ROI attempt SHALL record request/task/image/authoritative-
annotation identity and epoch, floating/integer ROI, crop edge convention,
requested/realized canvas, scales, padding, resampler/pad value, complete
profile/model/checkpoint/config/prompt/parser/processor/transform identities,
timing/terminal status, raw response text or durable reference plus hash, and
per result raw span/hash, coord bins, parser canvas bbox, class decision, reject
reason, inverse inputs/outputs, final norm1000 bbox, and region link without
storing credentials.

#### Scenario: Inference-assisted sample is audited
- **WHEN** an operator follows a committed inferred object's journal reference
- **THEN** the exact model profile and reversible transform that produced its initial geometry are identifiable

#### Scenario: Failed request is audited
- **WHEN** a request fails
- **THEN** its receipt identifies the failure stage without claiming annotation mutation

### Requirement: Local allowlisted service boundary
The inference and adapter services SHALL bind to loopback, SHALL be reached by
the browser only through an authenticated/CSRF-protected same-origin proxy,
SHALL accept only known project/task/annotation/revision/profile identities, and
SHALL not expose arbitrary filesystem paths or credentials through requests,
receipts, or logs.

#### Scenario: Unknown task or arbitrary path is submitted
- **WHEN** a client attempts inference outside the bootstrapped manifest
- **THEN** the service rejects the request before reading an image or invoking the model

#### Scenario: Cross-origin state-changing request is attempted
- **WHEN** an untrusted origin posts to the adapter or inference namespace
- **THEN** authentication/origin/CSRF checks reject it before project or model access
