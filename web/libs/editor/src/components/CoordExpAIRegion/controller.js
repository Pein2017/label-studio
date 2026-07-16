const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_ID = /^roi-receipt:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export const VISUAL_POLICY_VERSION = "visual_policy_v1";
export const VISUAL_NEIGHBORHOOD_BINS = 12;
export const DUPLICATE_IOU_THRESHOLD = 0.5;
export const DEFAULT_CANVAS = Object.freeze({ width: 1024, height: 1024 });
export const VISUAL_PALETTE = Object.freeze([
  "#005A9C",
  "#A64073",
  "#007A5E",
  "#B85C00",
  "#6B4C9A",
  "#006E90",
  "#9C2F2F",
  "#4D7000",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const nonEmptyText = (value) => typeof value === "string" && value.length > 0;
const clip = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

const contractError = (message, code = "invalid_response") => {
  const error = new Error(message);

  error.name = "CoordExpAIRegionContractError";
  error.code = code;
  return error;
};

export const isCanonicalUuid = (value) => typeof value === "string" && UUID_V4.test(value);

export const shouldRetireInferencePresentations = (status, { taskId, taskKey } = {}) => {
  if (!isRecord(status) || !Number.isInteger(taskId) || !nonEmptyText(taskKey)) return false;
  if (status.taskSemanticState !== "Committed") return false;

  const authority = status.authority;
  const local = status.local;

  if (!isRecord(authority) || !isRecord(local)) return false;
  if (!isRecord(authority.last_terminal_batch) || authority.last_terminal_batch.state !== "succeeded") return false;
  if (!Array.isArray(authority.members)) return false;

  const matchingMembers = authority.members.filter(
    (member) => isRecord(member) && member.task_id === taskId && member.task_key === taskKey,
  );

  if (matchingMembers.length !== 1) return false;
  const member = matchingMembers[0];

  return (
    member.last_terminal_batch_member === true &&
    member.draft_matches_last_terminal_batch === true &&
    member.draft_ahead_of_committed === false &&
    member.pending === false &&
    local.dirty === false &&
    local.saveInFlight === false &&
    local.roiRunning === false &&
    local.pendingTaskCount === 0
  );
};

export const clipPercentPoint = ({ x, y }) => ({ x: clip(x, 0, 100), y: clip(y, 0, 100) });

export const roiFromDrag = (start, end) => {
  if (![start?.x, start?.y, end?.x, end?.y].every(finite)) return null;
  const clippedStart = clipPercentPoint(start);
  const clippedEnd = clipPercentPoint(end);
  const left = Math.min(clippedStart.x, clippedEnd.x);
  const top = Math.min(clippedStart.y, clippedEnd.y);
  const right = Math.max(clippedStart.x, clippedEnd.x);
  const bottom = Math.max(clippedStart.y, clippedEnd.y);

  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const normalizePercentRoi = (roi) => {
  if (!isRecord(roi) || ![roi.x, roi.y, roi.width, roi.height].every(finite)) {
    throw contractError("AI Region must contain finite percentage coordinates.", "invalid_roi");
  }
  const normalized = roiFromDrag({ x: roi.x, y: roi.y }, { x: roi.x + roi.width, y: roi.y + roi.height });

  if (!normalized) throw contractError("AI Region has no in-bounds area.", "invalid_roi");
  return normalized;
};

export const percentRoiToOriginalPixels = (roi, originalWidth, originalHeight) => {
  const normalized = normalizePercentRoi(roi);

  if (!positiveInteger(originalWidth) || !positiveInteger(originalHeight)) {
    throw contractError("Original image dimensions must be positive integers.", "invalid_image_dimensions");
  }
  return {
    x: (normalized.x * originalWidth) / 100,
    y: (normalized.y * originalHeight) / 100,
    width: (normalized.width * originalWidth) / 100,
    height: (normalized.height * originalHeight) / 100,
  };
};

const validateProfile = (profile) => {
  const keys = [
    "selector",
    "display_label",
    "default_canvas",
    "processor_factor",
    "bounds",
    "generation_deadline_seconds",
  ];

  if (!hasExactKeys(profile, keys)) throw contractError("ROI profile has an unsupported shape.", "invalid_profiles");
  if (!nonEmptyText(profile.selector) || !nonEmptyText(profile.display_label)) {
    throw contractError("ROI profile identity is missing.", "invalid_profiles");
  }
  if (
    !hasExactKeys(profile.default_canvas, ["width", "height"]) ||
    !positiveInteger(profile.default_canvas.width) ||
    !positiveInteger(profile.default_canvas.height)
  ) {
    throw contractError("ROI profile default canvas is invalid.", "invalid_profiles");
  }
  if (
    !hasExactKeys(profile.bounds, ["min_axis_pixels", "max_axis_pixels", "max_total_pixels"]) ||
    !positiveInteger(profile.processor_factor) ||
    !positiveInteger(profile.bounds.min_axis_pixels) ||
    !positiveInteger(profile.bounds.max_axis_pixels) ||
    profile.bounds.min_axis_pixels > profile.bounds.max_axis_pixels ||
    !positiveInteger(profile.bounds.max_total_pixels) ||
    !finite(profile.generation_deadline_seconds) ||
    profile.generation_deadline_seconds <= 0
  ) {
    throw contractError("ROI profile processor constraints are invalid.", "invalid_profiles");
  }
  const { width, height } = profile.default_canvas;
  const { min_axis_pixels: minAxis, max_axis_pixels: maxAxis, max_total_pixels: maxTotal } = profile.bounds;

  if (
    width % profile.processor_factor !== 0 ||
    height % profile.processor_factor !== 0 ||
    width < minAxis ||
    width > maxAxis ||
    height < minAxis ||
    height > maxAxis ||
    width * height > maxTotal
  ) {
    throw contractError("ROI profile default canvas violates its processor constraints.", "invalid_profiles");
  }
  return profile;
};

export const validateProfilesResponse = (payload) => {
  if (!hasExactKeys(payload, ["profiles"]) || !Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    throw contractError("The service returned no valid ROI profiles.", "invalid_profiles");
  }
  const profiles = payload.profiles.map(validateProfile);
  const selectors = new Set(profiles.map((profile) => profile.selector));

  if (selectors.size !== profiles.length)
    throw contractError("ROI profile selectors must be unique.", "invalid_profiles");
  return profiles;
};

export const validateCanvasResolution = (profile, width, height) => {
  const numericWidth = typeof width === "string" && /^\d+$/.test(width) ? Number(width) : width;
  const numericHeight = typeof height === "string" && /^\d+$/.test(height) ? Number(height) : height;

  if (!profile) return { valid: false, error: "Select an inference profile." };
  if (!positiveInteger(numericWidth) || !positiveInteger(numericHeight)) {
    return { valid: false, error: "Width and height must be positive integers." };
  }
  const factor = profile.processor_factor;

  if (numericWidth % factor !== 0 || numericHeight % factor !== 0) {
    return { valid: false, error: `Width and height must be divisible by ${factor}.` };
  }
  const { min_axis_pixels: minAxis, max_axis_pixels: maxAxis, max_total_pixels: maxTotal } = profile.bounds;

  if (numericWidth < minAxis || numericWidth > maxAxis || numericHeight < minAxis || numericHeight > maxAxis) {
    return { valid: false, error: `Each axis must be between ${minAxis} and ${maxAxis} pixels.` };
  }
  if (numericWidth * numericHeight > maxTotal) {
    return { valid: false, error: `Canvas area must not exceed ${maxTotal} pixels.` };
  }
  return { valid: true, value: { width: numericWidth, height: numericHeight }, error: null };
};

const targetKeys = [
  "request_id",
  "project_id",
  "task_id",
  "task_epoch",
  "image_id",
  "annotation_id",
  "annotation_revision",
  "current_user_id",
  "draft_id",
  "draft_revision",
  "profile_fingerprint",
  "project_generation",
  "transform_fingerprint",
  "preexisting_draft_dirty",
];

const validateTarget = (target, frozen) => {
  if (!hasExactKeys(target, targetKeys)) throw contractError("ROI response target shape is invalid.");
  for (const key of targetKeys.filter((key) => !["project_generation", "preexisting_draft_dirty"].includes(key))) {
    if (!nonEmptyText(target[key])) throw contractError(`ROI response target ${key} is invalid.`);
  }
  if (
    !isCanonicalUuid(target.request_id) ||
    !nonNegativeInteger(target.project_generation) ||
    typeof target.preexisting_draft_dirty !== "boolean"
  ) {
    throw contractError("ROI response target contains invalid typed fields.");
  }
  const expected = {
    request_id: frozen.requestId,
    project_id: String(frozen.projectId),
    task_id: frozen.taskKey,
    annotation_id: String(frozen.annotationId),
    draft_id: String(frozen.draftId),
    draft_revision: frozen.draftRevision,
  };

  for (const [key, value] of Object.entries(expected)) {
    if (target[key] !== value)
      throw contractError(`ROI response target ${key} does not match the frozen target.`, "target_mismatch");
  }
  if (target.preexisting_draft_dirty !== false) {
    throw contractError("ROI response target carries pre-existing Draft dirtiness.", "target_mismatch");
  }
  return target;
};

const durableDraftReceiptKeys = [
  "task_id",
  "annotation_id",
  "draft_id",
  "status",
  "revision",
  "serialized_hash",
  "browser_semantic_projection_hash",
  "authoritative_semantic_hash",
];

export const validateDurableDraftReceipt = (receipt, expected) => {
  if (!hasExactKeys(receipt, durableDraftReceiptKeys)) {
    throw contractError("Draft save returned an unsupported receipt shape.", "invalid_draft_receipt");
  }
  if (
    !positiveInteger(receipt.draft_id) ||
    !Number.isInteger(receipt.status) ||
    receipt.status < 200 ||
    receipt.status >= 300 ||
    !nonEmptyText(receipt.revision) ||
    !nonEmptyText(receipt.serialized_hash) ||
    !nonEmptyText(receipt.browser_semantic_projection_hash) ||
    !(receipt.authoritative_semantic_hash === null || nonEmptyText(receipt.authoritative_semantic_hash))
  ) {
    throw contractError("Draft save receipt contains invalid fields.", "invalid_draft_receipt");
  }
  if (
    String(receipt.task_id) !== String(expected.taskId) ||
    String(receipt.annotation_id) !== String(expected.annotationId)
  ) {
    throw contractError("Draft save receipt target does not match the active editor.", "target_mismatch");
  }
  return receipt;
};

export const validateAbandonResponse = (response, { requestId, reason }) => {
  const keys = [
    "receipt_id",
    "request_id",
    "request_state",
    "terminal_status",
    "clear_roi",
    "insertion_payload",
    "failure",
    "counts",
  ];

  if (!hasExactKeys(response, keys)) throw contractError("ROI abandon response has an unsupported shape.");
  if (
    response.receipt_id !== `roi-receipt:${requestId}` ||
    response.request_id !== requestId ||
    response.request_state !== "abandoned_before_insertion" ||
    response.terminal_status !== "abandoned_before_insertion" ||
    response.clear_roi !== false ||
    response.insertion_payload !== null ||
    !hasExactKeys(response.failure, ["stage", "code"]) ||
    response.failure.stage !== "insertion" ||
    response.failure.code !== reason ||
    !hasExactKeys(response.counts, ["parsed", "inserted", "rejected"]) ||
    ![response.counts.parsed, response.counts.inserted, response.counts.rejected].every(nonNegativeInteger) ||
    response.counts.inserted !== 0 ||
    response.counts.rejected > response.counts.parsed
  ) {
    throw contractError("ROI abandon response is not the exact terminal receipt.");
  }
  return response;
};

const validateCounts = (counts) => {
  if (!hasExactKeys(counts, ["parsed", "produced", "rejected"])) throw contractError("ROI counts are invalid.");
  if (![counts.parsed, counts.produced, counts.rejected].every(nonNegativeInteger)) {
    throw contractError("ROI counts must be non-negative integers.");
  }
  if (counts.produced > counts.parsed) throw contractError("Produced ROI count exceeds parsed count.");
  return counts;
};

const expectedLsGeometry = (bbox) => ({
  x: (bbox[0] * 100) / 999,
  y: (bbox[1] * 100) / 999,
  width: ((bbox[2] - bbox[0]) * 100) / 999,
  height: ((bbox[3] - bbox[1]) * 100) / 999,
});

const validateInsertionRegion = (region, index, requestId) => {
  const keys = [
    "result_id",
    "category_name",
    "category_id",
    "bbox_2d",
    "request_id",
    "parser_object_span_id",
    "source_draft_revision",
    "region_key",
    "label_studio_result",
  ];

  if (!hasExactKeys(region, keys)) throw contractError(`ROI insertion region ${index} has an unsupported shape.`);
  if (
    ![
      region.result_id,
      region.category_name,
      region.parser_object_span_id,
      region.source_draft_revision,
      region.region_key,
    ].every(nonEmptyText) ||
    !positiveInteger(region.category_id) ||
    region.request_id !== requestId
  ) {
    throw contractError(`ROI insertion region ${index} identity is invalid.`);
  }
  const bbox = region.bbox_2d;

  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((value) => Number.isInteger(value) && value >= 0 && value <= 999) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3]
  ) {
    throw contractError(`ROI insertion region ${index} geometry is invalid.`);
  }
  const result = region.label_studio_result;
  const resultKeys = [
    "id",
    "type",
    "from_name",
    "to_name",
    "original_width",
    "original_height",
    "image_rotation",
    "value",
    "meta",
  ];

  if (!hasExactKeys(result, resultKeys))
    throw contractError(`ROI Label Studio result ${index} has an unsupported shape.`);
  if (
    result.id !== region.region_key ||
    result.type !== "rectanglelabels" ||
    result.from_name !== "bbox" ||
    result.to_name !== "image" ||
    !positiveInteger(result.original_width) ||
    !positiveInteger(result.original_height) ||
    result.image_rotation !== 0 ||
    !hasExactKeys(result.value, ["x", "y", "width", "height", "rotation", "rectanglelabels"]) ||
    result.value.rotation !== 0 ||
    !Array.isArray(result.value.rectanglelabels) ||
    result.value.rectanglelabels.length !== 1 ||
    result.value.rectanglelabels[0] !== region.category_name ||
    ![result.value.x, result.value.y, result.value.width, result.value.height].every(finite) ||
    result.value.width <= 0 ||
    result.value.height <= 0
  ) {
    throw contractError(`ROI Label Studio result ${index} is invalid.`);
  }
  const expected = expectedLsGeometry(bbox);

  if (Object.keys(expected).some((key) => Math.abs(result.value[key] - expected[key]) > 1e-9)) {
    throw contractError(`ROI Label Studio result ${index} disagrees with norm1000 geometry.`);
  }
  const meta = result.meta;
  const metaKeys = [
    "coordexp_region_key",
    "coordexp_inference_receipt_id",
    "coordexp_inference_request_id",
    "coordexp_inference_result_id",
    "coordexp_inference_source_draft_revision",
  ];

  if (!hasExactKeys(meta, metaKeys)) throw contractError(`ROI Label Studio result ${index} metadata is invalid.`);
  if (
    meta.coordexp_region_key !== region.region_key ||
    meta.coordexp_inference_receipt_id !== `roi-receipt:${requestId}` ||
    meta.coordexp_inference_request_id !== requestId ||
    meta.coordexp_inference_result_id !== region.result_id ||
    meta.coordexp_inference_source_draft_revision !== region.source_draft_revision
  ) {
    throw contractError(`ROI Label Studio result ${index} metadata linkage is invalid.`);
  }
  return result;
};

const failureStates = new Set([
  "profile_failure",
  "transport_failure",
  "runtime_failure",
  "timeout_failure",
  "abandoned_before_insertion",
]);

export const validateInferenceResponse = (response, frozen) => {
  const baseKeys = [
    "receipt_id",
    "request_id",
    "request_state",
    "terminal_status",
    "clear_roi",
    "insertion_payload",
    "failure",
  ];
  const resultKeys = [...baseKeys, "counts"];

  if (!isRecord(response) || !nonEmptyText(response.request_state)) {
    throw contractError("ROI inference response has an unsupported shape.");
  }
  if (!isCanonicalUuid(response.request_id) || response.request_id !== frozen.requestId) {
    throw contractError("ROI response request identity is invalid.", "target_mismatch");
  }
  const receiptMatch = typeof response.receipt_id === "string" ? response.receipt_id.match(RECEIPT_ID) : null;

  if (!receiptMatch || receiptMatch[1] !== response.request_id) throw contractError("ROI receipt identity is invalid.");
  const state = response.request_state;

  if (state === "produced") {
    if (!hasExactKeys(response, resultKeys)) throw contractError("Produced ROI response has an unsupported shape.");
    const counts = validateCounts(response.counts);

    if (
      response.terminal_status !== null ||
      response.clear_roi !== false ||
      response.failure !== null ||
      !hasExactKeys(response.insertion_payload, ["target", "mode", "regions"]) ||
      response.insertion_payload.mode !== "append_one_undo_action" ||
      !Array.isArray(response.insertion_payload.regions) ||
      response.insertion_payload.regions.length === 0 ||
      counts.produced !== response.insertion_payload.regions.length
    ) {
      throw contractError("Produced ROI response is internally inconsistent.");
    }
    const target = validateTarget(response.insertion_payload.target, frozen);
    const results = response.insertion_payload.regions.map((region, index) =>
      validateInsertionRegion(region, index, response.request_id),
    );
    const ids = new Set(results.map((result) => result.id));

    if (ids.size !== results.length) throw contractError("Produced ROI result IDs must be unique.");
    return {
      kind: "produced",
      status: counts.rejected > 0 ? "accepted_with_drops" : "accepted",
      receiptId: response.receipt_id,
      target,
      results,
      counts,
      clearRoi: true,
    };
  }

  if (state === "empty" || state === "all_rejected") {
    if (!hasExactKeys(response, resultKeys))
      throw contractError(`Terminal ROI ${state} response has an unsupported shape.`);
    const counts = validateCounts(response.counts);

    if (
      response.terminal_status !== state ||
      response.clear_roi !== true ||
      response.insertion_payload !== null ||
      response.failure !== null ||
      counts.produced !== 0 ||
      (state === "empty" && (counts.parsed !== 0 || counts.rejected !== 0))
    ) {
      throw contractError(`Terminal ROI ${state} response is inconsistent.`);
    }
    return { kind: state, status: state, counts, clearRoi: true, receiptId: response.receipt_id };
  }

  if (state === "response_failure") {
    if (!hasExactKeys(response, resultKeys)) {
      throw contractError("Terminal ROI response_failure response has an unsupported shape.");
    }
    const counts = validateCounts(response.counts);

    if (
      response.terminal_status !== state ||
      response.clear_roi !== false ||
      response.insertion_payload !== null ||
      response.failure !== null ||
      counts.produced !== 0
    ) {
      throw contractError("Terminal ROI response_failure response is inconsistent.");
    }
    return { kind: "failure", status: state, counts, clearRoi: false, receiptId: response.receipt_id };
  }

  if (failureStates.has(state)) {
    if (!hasExactKeys(response, baseKeys))
      throw contractError(`Terminal ROI ${state} response has an unsupported shape.`);
    if (
      response.terminal_status !== state ||
      response.clear_roi !== false ||
      response.insertion_payload !== null ||
      !hasExactKeys(response.failure, ["stage", "code"]) ||
      !nonEmptyText(response.failure.stage) ||
      !nonEmptyText(response.failure.code)
    ) {
      throw contractError(`Terminal ROI ${state} response is inconsistent.`);
    }
    return { kind: "failure", status: state, clearRoi: false, receiptId: response.receipt_id };
  }

  throw contractError(`Unsupported ROI request state '${String(state)}'.`);
};

export const frozenTargetStillCurrent = (
  frozen,
  { projectId, store, annotation, selectedProfile, browserSemanticProjectionHash },
) => {
  const currentTaskKey = store?.task?.dataObj?.coordexp_task_key ?? store?.task?.data?.coordexp_task_key;
  const currentAnnotationId = annotation?.pk ?? annotation?.id;

  return (
    String(projectId) === String(frozen.projectId) &&
    String(store?.task?.id) === String(frozen.taskId) &&
    currentTaskKey === frozen.taskKey &&
    String(currentAnnotationId) === String(frozen.annotationId) &&
    String(annotation?.draftId) === String(frozen.draftId) &&
    annotation?.draftSaved === frozen.draftRevision &&
    browserSemanticProjectionHash === frozen.browserSemanticProjectionHash &&
    selectedProfile?.selector === frozen.profileSelector
  );
};

export const labelStudioResultToDescriptor = (result) => {
  const meta = result?.meta;
  const value = result.value;

  if (!isRecord(meta) || !isRecord(value) || ![value.x, value.y, value.width, value.height].every(finite)) return null;
  const stableRegionKey = meta.stable_region_key ?? meta.coordexp_region_key ?? result.id;
  const categoryName = value.rectanglelabels?.[0];

  if (!nonEmptyText(stableRegionKey) || !nonEmptyText(categoryName) || value.width <= 0 || value.height <= 0)
    return null;
  return {
    stableRegionKey,
    categoryName,
    inferenceOrigin: nonEmptyText(meta.coordexp_inference_receipt_id),
    bbox: [
      clip((value.x * 999) / 100, 0, 999),
      clip((value.y * 999) / 100, 0, 999),
      clip(((value.x + value.width) * 999) / 100, 0, 999),
      clip(((value.y + value.height) * 999) / 100, 0, 999),
    ],
  };
};

export const labelStudioResultToInferenceDescriptor = (result) => {
  const descriptor = labelStudioResultToDescriptor(result);

  return descriptor?.inferenceOrigin ? descriptor : null;
};

export const expandedNeighbors = (a, b, expansion = VISUAL_NEIGHBORHOOD_BINS) => {
  const expand = (bbox) => [
    clip(bbox[0] - expansion, 0, 999),
    clip(bbox[1] - expansion, 0, 999),
    clip(bbox[2] + expansion, 0, 999),
    clip(bbox[3] + expansion, 0, 999),
  ];
  const aa = expand(a);
  const bb = expand(b);

  return aa[0] <= bb[2] && bb[0] <= aa[2] && aa[1] <= bb[3] && bb[1] <= aa[3];
};

export const intersectionOverUnion = (a, b) => {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;

  return union > 0 ? intersection / union : 0;
};

export const buildVisualPolicy = (descriptors, palette = VISUAL_PALETTE, comparisonDescriptors = descriptors) => {
  if (!Array.isArray(descriptors) || descriptors.some((item) => !nonEmptyText(item?.stableRegionKey))) {
    throw contractError("Inference presentation descriptors are invalid.", "invalid_visual_policy");
  }
  if (!Array.isArray(palette) || palette.length === 0 || palette.some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
    throw contractError("Inference presentation palette is invalid.", "invalid_visual_policy");
  }
  if (
    !Array.isArray(comparisonDescriptors) ||
    comparisonDescriptors.some((item) => !nonEmptyText(item?.stableRegionKey))
  ) {
    throw contractError("Inference comparison descriptors are invalid.", "invalid_visual_policy");
  }
  const ordered = [...descriptors].sort((a, b) => a.stableRegionKey.localeCompare(b.stableRegionKey));
  const duplicateKeys = new Map(ordered.map((item) => [item.stableRegionKey, []]));
  const conflictPairs = new Set();

  for (const inferred of ordered) {
    for (const candidate of comparisonDescriptors) {
      if (
        inferred.stableRegionKey === candidate.stableRegionKey ||
        inferred.categoryName !== candidate.categoryName ||
        intersectionOverUnion(inferred.bbox, candidate.bbox) < DUPLICATE_IOU_THRESHOLD
      ) {
        continue;
      }
      duplicateKeys.get(inferred.stableRegionKey).push(candidate.stableRegionKey);
      conflictPairs.add([inferred.stableRegionKey, candidate.stableRegionKey].sort().join("\u0000"));
    }
  }
  const presentations = [];

  ordered.forEach((item, index) => {
    const usedColors = new Set(
      presentations
        .filter((_entry, priorIndex) => expandedNeighbors(item.bbox, ordered[priorIndex].bbox))
        .map((entry) => entry.color),
    );
    const availableColor = palette.find((color) => !usedColors.has(color));

    presentations.push({
      stable_region_key: item.stableRegionKey,
      color: availableColor ?? palette[index % palette.length],
      numeric_badge: availableColor ? null : index + 1,
      advisory_conflict_keys: [...new Set(duplicateKeys.get(item.stableRegionKey))].sort(),
    });
  });
  return {
    version: VISUAL_POLICY_VERSION,
    neighborhood_expansion_bins: VISUAL_NEIGHBORHOOD_BINS,
    duplicate_iou_threshold: DUPLICATE_IOU_THRESHOLD,
    advisory_conflict_pair_count: conflictPairs.size,
    presentations,
  };
};

export const visualPolicyConflictCount = (policy) =>
  Number.isInteger(policy.advisory_conflict_pair_count)
    ? policy.advisory_conflict_pair_count
    : policy.presentations.reduce((total, entry) => total + entry.advisory_conflict_keys.length, 0) / 2;
