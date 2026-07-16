import { Button } from "@humansignal/ui";
import {
  FF_DEV_1752,
  FF_DEV_2186,
  FF_DEV_2887,
  FF_DEV_3034,
  FF_LSDV_4620_3_ML,
  FF_FIT_1304_STRICT_OVERLAP,
  isFF,
} from "../utils/feature-flags";
import { isActive, FF_FIT_720_LAZY_LOAD_ANNOTATIONS } from "@humansignal/core/lib/utils/feature-flags";
import { isDefined } from "../utils/utils";
import { Modal } from "../components/Common/Modal/Modal";
import { CommentsSdk } from "./comments-sdk";
// import { LSFHistory } from "./lsf-history";
import { annotationToServer, taskToLSFormat } from "./lsf-utils";
import { when, runInAction } from "mobx";
import { isAlive } from "mobx-state-tree";
import { imageCache } from "@humansignal/core";
import { invalidateAnnotationCache, invalidateDistributionCache } from "@humansignal/core/lib/utils/annotation-cache";

const waitForPaint = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

const DEFAULT_INTERFACES = [
  "basic",
  "controls",
  "submit",
  "update",
  "predictions",
  "topbar",
  "predictions:menu", // right menu with prediction items
  "annotations:menu", // right menu with annotation items
  "annotations:current",
  "side-column", // entity
  "edit-history", // undo/redo
];

let LabelStudioDM;

const resolveLabelStudio = () => {
  if (LabelStudioDM) {
    return LabelStudioDM;
  }
  if (window.LabelStudio) {
    return (LabelStudioDM = window.LabelStudio);
  }
};

// Returns true to suppress (swallow) the error, false to bubble to global handler.
// We allow certain errors to bubble so the app-level ApiProvider can show modals:
// - 403 PAUSED: User is paused in the project
// - 400 OVERLAP_REACHED: Annotation overlap limit has been reached (only when feature flag is enabled)
const errorHandlerAllowSpecialErrors = (result) => {
  const isPaused =
    result?.status === 403 &&
    typeof result?.response === "object" &&
    result?.response?.display_context?.reason === "PAUSED";

  // Only handle OVERLAP_REACHED when feature flag is enabled
  const isOverlapReached =
    isFF(FF_FIT_1304_STRICT_OVERLAP) &&
    result?.status === 400 &&
    typeof result?.response === "object" &&
    result?.response?.display_context?.reason === "OVERLAP_REACHED";

  // Return false to allow these errors to bubble up to the global handler
  return !(isPaused || isOverlapReached);
};

// Support portal URL constants used to construct error reporting links
// These are used in showOperationToast() to create support links with request IDs
// for better error tracking and customer support
export const SUPPORT_URL = "https://support.humansignal.com/hc/en-us/requests/new";
export const SUPPORT_URL_REQUEST_ID_PARAM = "tf_37934448633869"; // request_id field ID in ZD

// Toast ID for overlap reached message - used to dismiss this specific toast
// without affecting other toasts like "Annotation Saved"
const OVERLAP_TOAST_ID = "overlap-reached-toast";

export const COORDEXP_MANAGED_PROJECT_PREFIX = "coordexp-refinement-project-identity:";

const MANAGED_DRAFT_MAX_SAVE_ATTEMPTS = 4;
const MANAGED_DRAFT_DETACHED_RESULT = Object.freeze({ detached: true, reason: "destroyed", status: "cancelled" });
const MANAGED_COMMITTED_META_FIELDS = Object.freeze(["coordexp_region_key", "coco_ann_id", "last_committed_bbox"]);

// These fields are deliberately persisted with a Draft so inference colors can
// be reconstructed after reload, but they are presentation-only.  Excluding
// them from the browser dirtiness projection prevents focus/color changes from
// masquerading as an unsaved object edit.  This projection is only a local
// navigation guard; authoritative semantic hashes always come from the managed
// status endpoint.
const MANAGED_PRESENTATION_META_FIELDS = new Set([
  "coordexp_visual_presentation",
  "visual_policy_presentation",
  "visual_policy_v1",
]);

const stableSerialize = (value) => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item ?? null)).join(",")}]`;
      }

      const entries = Object.keys(value)
        .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`);

      return `{${entries.join(",")}}`;
    }
    default:
      return "null";
  }
};

const stableHash = (value) => {
  const serialized = stableSerialize(value);
  let hash = 0x811c9dc5;

  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const cloneManagedJson = (value) => JSON.parse(stableSerialize(value));

const managedSemanticProjection = (value, parentKey = null) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => managedSemanticProjection(item, parentKey));

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => parentKey !== "meta" || !MANAGED_PRESENTATION_META_FIELDS.has(key))
      .map(([key, item]) => [key, managedSemanticProjection(item, key)]),
  );
};

const identitiesEqual = (left, right) => (left == null && right == null) || String(left) === String(right);

export class CoordExpDraftSaveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoordExpDraftSaveError";
    this.code = code;
  }
}

export class LSFWrapper {
  /** @type {HTMLElement} */
  root = null;

  /** @type {DataManager} */
  datamanager = null;

  /** @type {Task} */
  task = null;

  /** @type {Annotation} */
  initialAnnotation = null;

  /** @type {LabelStudio} */
  lsf = null;

  /** @type {LSFHistory} */
  // history = null;

  /** @type {boolean} */
  labelStream = false;

  /** @type {boolean} */
  isInteractivePreannotations = false;

  /** @type {function} */
  interfacesModifier = (interfaces) => interfaces;

  /**
   *
   * @param {DataManager} dm
   * @param {HTMLElement} element
   * @param {LSFOptions} options
   */
  constructor(dm, element, options) {
    // we need to pass the rest of the options to LSF below
    const {
      task,
      preload,
      isLabelStream,
      annotation,
      interfacesModifier,
      isInteractivePreannotations,
      user,
      keymap,
      messages,
      ...restOptions
    } = options;

    this.datamanager = dm;
    this.store = dm.store;
    this.root = element;
    this.task = task;
    this.preload = preload;
    this.labelStream = isLabelStream ?? false;
    this.initialAnnotation = annotation;
    this.interfacesModifier = interfacesModifier;
    this.isInteractivePreannotations = isInteractivePreannotations ?? false;

    this._managedDraftSaves = new Map();
    this._managedDraftBaselines = new Map();
    this._managedAnnotationHydrations = new Map();
    this._managedAnnotationTaskIds = new WeakMap();
    this._managedLocalPendingDrafts = new Map();
    this._managedLocalSaveVersion = 0;
    this._managedPollSequence = 0;
    this._managedAcceptedPollSequence = 0;
    this._managedAuthoritativeObservedLocalSaveVersion = -1;
    this._managedNavigationSequence = 0;
    this._managedNavigationCurrent = null;
    this._managedNavigationQueue = [];
    this._managedCoordinatorDestroyed = false;
    this._managedSelectionReplay = false;
    this._managedRoiRunning = false;
    this._managedAuthoritativeState = null;
    this._managedTerminalLifecycleKeys = new Set();
    this._managedPersistentError = null;
    this.managedStatusState = null;
    this.lastPersistedDraftResult = null;

    if (this.isManagedRefinementProject) {
      this._managedBeforeUnloadHandler = this._handleManagedBeforeUnload;
      window.addEventListener("beforeunload", this._managedBeforeUnloadHandler);
    }

    // Listen for overlap error modal events (only when feature flag is enabled)
    if (isFF(FF_FIT_1304_STRICT_OVERLAP)) {
      this.handleOverlapNextTask = () => this.loadTask();
      this.handleOverlapCloseTask = () => this.closeTask();
      this.handleOverlapExitStream = () => this.exitStream();
      window.addEventListener("overlap-error-next-task", this.handleOverlapNextTask);
      window.addEventListener("overlap-error-close-task", this.handleOverlapCloseTask);
      window.addEventListener("overlap-error-exit-stream", this.handleOverlapExitStream);
    }

    let interfaces = [...DEFAULT_INTERFACES];

    if (this.project.enable_empty_annotation === false) {
      interfaces.push("annotations:deny-empty");
    }

    if (window.APP_SETTINGS.annotator_reviewer_firewall_enabled && this.labelStream) {
      interfaces.push("annotations:hide-info");
    }

    if (this.labelStream) {
      interfaces.push("infobar");
      if (!window.APP_SETTINGS.label_stream_navigation_disabled) interfaces.push("topbar:prevnext");
      if (FF_DEV_2186 && this.project.review_settings?.require_comment_on_reject) {
        interfaces.push("comments:update");
      }
      if (this.project.show_skip_button) {
        interfaces.push("skip");
      }
    } else {
      interfaces.push(
        "infobar",
        "annotations:add-new",
        "annotations:view-all",
        "annotations:delete",
        "annotations:tabs",
        "predictions:tabs",
        "annotations:copy-link",
      );
    }

    if (this.datamanager.hasInterface("instruction")) {
      interfaces.push("instruction");
    }

    if (!this.labelStream && this.datamanager.hasInterface("groundTruth")) {
      interfaces.push("ground-truth");
    }

    if (this.datamanager.hasInterface("autoAnnotation")) {
      interfaces.push("auto-annotation");
    }

    if (isFF(FF_DEV_2887)) {
      interfaces.push("annotations:comments");
      interfaces.push("comments:resolve-any");
    }

    if (this.project.review_settings?.require_comment_on_reject) {
      interfaces.push("comments:reject");
    }

    if (this.interfacesModifier) {
      interfaces = this.interfacesModifier(interfaces, this.labelStream);
    }

    if (!this.shouldLoadNext()) {
      interfaces = interfaces.filter((item) => {
        return !["topbar:prevnext", "skip"].includes(item);
      });
    }

    const queueTotal = dm.store.project.reviewer_queue_total || dm.store.project.queue_total;
    const queueDone = dm.store.project.queue_done;
    const queueLeft = dm.store.project.queue_left;
    const queuePosition = queueDone ? queueDone + 1 : queueLeft ? queueTotal - queueLeft + 1 : 1;
    const commentClassificationConfig = dm.store.project.comment_classification_config;

    const lsfProperties = {
      user: options.user,
      config: this.lsfConfig,
      task: taskToLSFormat(this.task),
      description: this.instruction,
      interfaces,
      users: dm.store.users.map((u) => u.toJSON()),
      keymap: options.keymap,
      forceAutoAnnotation: this.isInteractivePreannotations,
      forceAutoAcceptSuggestions: this.isInteractivePreannotations,
      messages: options.messages,
      queueTotal,
      queuePosition,
      commentClassificationConfig,

      /* EVENTS */
      onSubmitDraft: this.onSubmitDraft,
      onLabelStudioLoad: this.onLabelStudioLoad,
      onTaskLoad: this.onTaskLoad,
      onPresignUrlForProject: this.onPresignUrlForProject,
      onStorageInitialized: this.onStorageInitialized,
      onSubmitAnnotation: this.onSubmitAnnotation,
      onUpdateAnnotation: this.onUpdateAnnotation,
      onDeleteAnnotation: this.onDeleteAnnotation,
      onSkipTask: this.onSkipTask,
      onUnskipTask: this.onUnskipTask,
      onGroundTruth: this.onGroundTruth,
      onEntityCreate: this.onEntityCreate,
      onEntityDelete: this.onEntityDelete,
      onSelectAnnotation: this.onSelectAnnotation,
      onNextTask: this.onNextTask,
      onPrevTask: this.onPrevTask,

      ...restOptions,
    };

    this.initLabelStudio(lsfProperties);
  }

  /** @private */
  initLabelStudio(settings) {
    try {
      const LSF = resolveLabelStudio();

      this.lsfInstance = new LSF(this.root, settings);

      this.lsfInstance.on("presignUrlForProject", this.onPresignUrlForProject);

      const names = Array.from(this.datamanager.callbacks.keys()).filter((k) => k.startsWith("lsf:"));

      names.forEach((name) => {
        this.datamanager.getEventCallbacks(name).forEach((clb) => {
          this.lsfInstance.on(name.replace(/^lsf:/, ""), clb);
        });
      });

      if (isFF(FF_DEV_2887)) {
        new CommentsSdk(this.lsfInstance, this.datamanager);
      }

      this.datamanager.invoke("lsfInit", this, this.lsfInstance);
    } catch (err) {
      console.error("Failed to initialize LabelStudio", settings);
      console.error(err);
    }
  }

  _managedAnnotationTaskId(annotation) {
    if (!annotation) return null;
    return (
      this._managedAnnotationTaskIds.get(annotation) ?? (annotation === this.currentAnnotation ? this.task?.id : null)
    );
  }

  _claimManagedDraftSaveOwner(annotation) {
    if (!this.isManagedRefinementProject || !annotation) return;
    if (typeof annotation.setExternalDraftSaveOwner === "function") {
      annotation.setExternalDraftSaveOwner(true);
    } else {
      annotation.pauseAutosave?.();
    }
  }

  _claimManagedDraftSaveOwners(annotations = this.annotations ?? []) {
    if (!this.isManagedRefinementProject) return;
    for (const annotation of annotations) this._claimManagedDraftSaveOwner(annotation);
  }

  _bindManagedAnnotationTask(annotation, task = this.task) {
    if (!annotation || !task?.id) return null;
    if (!this._managedAnnotationTaskIds.has(annotation)) this._managedAnnotationTaskIds.set(annotation, task.id);
    return this._managedAnnotationTaskIds.get(annotation);
  }

  _managedAnnotationIdentity(annotation) {
    const taskId = this._managedAnnotationTaskId(annotation);

    if (!annotation || !taskId) return null;

    const annotationId = annotation.pk ?? annotation.id;

    if (!isDefined(annotationId)) return null;
    return `${taskId}:${annotationId}`;
  }

  _pruneManagedAnnotationHydrations(annotation = this.currentAnnotation) {
    if (!this.isManagedRefinementProject) return;

    const identity = this._managedAnnotationIdentity(annotation);

    for (const [candidateIdentity, hydration] of this._managedAnnotationHydrations) {
      if (candidateIdentity !== identity || hydration.annotation !== annotation) {
        if (hydration.status === "pending" || this._managedDraftSaves.has(candidateIdentity)) continue;
        this._managedAnnotationHydrations.delete(candidateIdentity);
      }
    }
  }

  async _awaitManagedAnnotationHydration(annotation) {
    if (!this.isManagedRefinementProject || !annotation) return;

    const identity = this._managedAnnotationIdentity(annotation);

    if (!identity) return;

    // A retry replaces the prior failed generation. Always re-read the
    // identity-scoped record after awaiting so a save cannot race past a newer
    // hydration attempt.
    let observed = false;

    for (;;) {
      const hydration = this._managedAnnotationHydrations.get(identity);

      if (!hydration) {
        if (!observed) return;
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_SUPERSEDED",
          "The annotation changed while its authoritative result was loading. No Draft was saved.",
        );
      }
      observed = true;
      if (hydration.annotation !== annotation) {
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_SUPERSEDED",
          "The annotation changed while its authoritative result was loading. No Draft was saved.",
        );
      }
      if (hydration.status === "pending") await hydration.promise;
      if (this._managedCoordinatorDestroyed) return;
      if (this._managedAnnotationHydrations.get(identity) !== hydration) {
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_SUPERSEDED",
          "The annotation changed while its authoritative result was loading. No Draft was saved.",
        );
      }
      if (hydration.status === "ready") return;

      throw (
        hydration.error ??
        this._managedDraftError(
          "ANNOTATION_HYDRATION_FAILED",
          "The authoritative annotation could not be loaded. No Draft was saved.",
        )
      );
    }
  }

  _serializeManagedAnnotation(annotation) {
    const result = annotation?.serializeAnnotation?.({ fast: true });

    if (Array.isArray(result)) return result;
    if (Array.isArray(annotation?.versions?.draft)) return annotation.versions.draft;
    return [];
  }

  _managedSemanticProjection(annotation) {
    return managedSemanticProjection(this._serializeManagedAnnotation(annotation));
  }

  _managedHistoryEpoch(annotation) {
    const history = annotation?.history;

    return `${history?.undoIdx ?? 0}:${history?.lastAdditionTime ?? ""}`;
  }

  _initializeManagedDraftBaseline(annotation) {
    if (!this.isManagedRefinementProject || !annotation) return;

    this._claimManagedDraftSaveOwner(annotation);
    this._bindManagedAnnotationTask(annotation);
    const identity = this._managedAnnotationIdentity(annotation);

    if (!identity || this._managedDraftBaselines.has(identity)) return;

    const projection = this._managedSemanticProjection(annotation);
    const serialized = stableSerialize(projection);

    this._managedDraftBaselines.set(identity, {
      browserSemanticHash: stableHash(projection),
      serialized,
      hydrated: true,
      receipt: null,
    });
  }

  _initializeManagedDraftBaselines() {
    if (!this.isManagedRefinementProject) return;

    for (const annotation of this.annotations ?? []) {
      this._initializeManagedDraftBaseline(annotation);
    }

    // The editor treats every resolved submitDraft callback as success. Managed
    // projects save through the strict wrapper coordinator instead.
    this._claimManagedDraftSaveOwner(this.currentAnnotation);
    this._publishManagedStatus();
  }

  _finalizeManagedDraftBaselineAfterLoad(annotation) {
    if (!this.isManagedRefinementProject || !annotation) return;

    this._claimManagedDraftSaveOwner(annotation);
    this._bindManagedAnnotationTask(annotation);
    const identity = this._managedAnnotationIdentity(annotation);

    if (!identity) return;
    const projection = this._managedSemanticProjection(annotation);
    this._managedDraftBaselines.set(identity, {
      browserSemanticHash: stableHash(projection),
      serialized: stableSerialize(projection),
      hydrated: true,
      receipt: null,
    });

    this._publishManagedStatus();
  }

  _isManagedAnnotationDirty(annotation = this.currentAnnotation) {
    if (!this.isManagedRefinementProject || !annotation) return false;

    const identity = this._managedAnnotationIdentity(annotation);
    const baseline = identity ? this._managedDraftBaselines.get(identity) : null;

    if (!baseline) return this.needsDraftSave(annotation);
    return stableSerialize(this._managedSemanticProjection(annotation)) !== baseline.serialized;
  }

  _isManagedDraftSaving(annotation = this.currentAnnotation) {
    const identity = this._managedAnnotationIdentity(annotation);

    return Boolean(annotation?.isDraftSaving || (identity && this._managedDraftSaves.has(identity)));
  }

  hasManagedUnsavedWork = () => {
    if (!this.isManagedRefinementProject) return false;
    return this._isManagedAnnotationDirty(this.currentAnnotation);
  };

  requiresManagedNavigationSave = () => {
    return (
      this.isManagedRefinementProject &&
      (this._managedRoiRunning ||
        this._isManagedDraftSaving(this.currentAnnotation) ||
        this._isManagedAnnotationDirty(this.currentAnnotation))
    );
  };

  _handleManagedBeforeUnload = (event) => {
    if (!this.hasManagedUnsavedWork()) return;

    event.preventDefault();
    event.returnValue = "";
    return "";
  };

  setManagedRoiRunning = (running) => {
    if (typeof running !== "boolean") throw new TypeError("running must be a boolean");
    this._managedRoiRunning = running;
    this._publishManagedStatus();
    this.datamanager.invoke("managedRoiStateChanged", { running: this._managedRoiRunning });
  };

  beginManagedProjectStatePoll = () => {
    return Object.freeze({
      pollSequence: ++this._managedPollSequence,
      localSaveVersion: this._managedLocalSaveVersion,
    });
  };

  _managedStatusError(error, domain) {
    const normalized =
      error instanceof CoordExpDraftSaveError
        ? error
        : this._managedDraftError("MANAGED_STATUS_ERROR", "Managed refinement status could not be verified.");

    return Object.freeze({
      code: normalized.code,
      message: normalized.message,
      domain,
      at: new Date().toISOString(),
    });
  }

  _setManagedPersistentError(error, domain) {
    this._managedPersistentError = this._managedStatusError(error, domain);
    this._publishManagedStatus();
  }

  _clearManagedPersistentError(domain = null) {
    if (!this._managedPersistentError) return;
    if (domain && this._managedPersistentError.domain !== domain) return;
    this._managedPersistentError = null;
  }

  clearManagedStatusError = () => {
    this._managedPersistentError = null;
    return this._publishManagedStatus();
  };

  _managedServerMembers(state = this._managedAuthoritativeState) {
    const members = state?.members ?? state?.task_states ?? state?.tasks;

    if (Array.isArray(members)) return members;
    if (members && typeof members === "object") return Object.values(members);
    return [];
  }

  _managedAuthoritativeMember(taskId) {
    return this._managedServerMembers().find((member) => identitiesEqual(member?.task_id ?? member?.taskId, taskId));
  }

  _managedMemberDraftTokenMatches(member, local) {
    if (!member || !local?.receipt) return false;

    const draftId = member.draft_id ?? member.draftId;
    const draftUpdatedAt = member.draft_updated_at ?? member.draftUpdatedAt;

    return (
      identitiesEqual(draftId, local.receipt.draft_id) &&
      typeof draftUpdatedAt === "string" &&
      draftUpdatedAt === local.receipt.revision
    );
  }

  _managedMemberProvesCommitted(member) {
    const draftHash = member?.draft_semantic_hash ?? member?.draftSemanticHash;
    const committedHash = member?.committed_semantic_hash ?? member?.committedSemanticHash;

    return (
      typeof draftHash === "string" &&
      Boolean(draftHash) &&
      typeof committedHash === "string" &&
      Boolean(committedHash) &&
      draftHash === committedHash
    );
  }

  _managedTaskSemanticState(taskId = this.task?.id) {
    if (!isDefined(taskId)) return "Unknown";
    if (this._managedLocalPendingDrafts.has(String(taskId))) return "Draft";
    if (identitiesEqual(taskId, this.task?.id) && this._isManagedAnnotationDirty(this.currentAnnotation))
      return "Draft";

    const member = this._managedAuthoritativeMember(taskId);
    if (this._managedMemberProvesCommitted(member)) return "Committed";

    const draftHash = member?.draft_semantic_hash ?? member?.draftSemanticHash;
    const committedHash = member?.committed_semantic_hash ?? member?.committedSemanticHash;

    return typeof draftHash === "string" && draftHash && typeof committedHash === "string" && committedHash
      ? "Draft"
      : "Unknown";
  }

  _buildManagedStatusState() {
    const authoritative = this._managedAuthoritativeState;
    const pending = this._managedPendingDraftPayload();
    const annotation = this.currentAnnotation;
    const browserProjection = annotation ? this._managedSemanticProjection(annotation) : null;

    return Object.freeze({
      authority: authoritative,
      generation: authoritative?.generation ?? null,
      version: authoritative?.version ?? null,
      taskSemanticState: this._managedTaskSemanticState(),
      batchState: pending.batchState,
      activeBatchId: pending.activeBatchId,
      pendingDraftCount: pending.pendingDraftCount,
      local: Object.freeze({
        dirty: this._isManagedAnnotationDirty(annotation),
        roiRunning: this._managedRoiRunning,
        saveInFlight: this._isManagedDraftSaving(annotation),
        pendingTaskCount: this._managedLocalPendingDrafts.size,
        browserSemanticProjectionHash: browserProjection ? stableHash(browserProjection) : null,
        authority: false,
      }),
      error: this._managedPersistentError,
    });
  }

  _publishManagedStatus() {
    if (!this.isManagedRefinementProject) return null;
    this.managedStatusState = this._buildManagedStatusState();
    this.datamanager.invoke("managedStatusChanged", this.managedStatusState);
    return this.managedStatusState;
  }

  getManagedStatusState = () => {
    return this._publishManagedStatus();
  };

  updateManagedProjectState = (state = {}, pollToken = {}) => {
    const generation = state.generation ?? state.project_generation ?? state.projectGeneration;
    const version = state.version ?? state.status_version ?? state.statusVersion;

    if (!Number.isInteger(generation) || generation < 0 || !Number.isInteger(version) || version < 0) {
      const error = this._managedDraftError(
        "INVALID_STATUS_VERSION",
        "Managed status is missing a valid generation/version and was ignored.",
      );

      this._setManagedPersistentError(error, "status");
      return this.managedStatusState;
    }

    const pollSequence = pollToken?.pollSequence;

    if (pollSequence !== undefined && (!Number.isInteger(pollSequence) || pollSequence <= 0)) {
      const error = this._managedDraftError(
        "INVALID_POLL_TOKEN",
        "Managed status poll token is invalid and was ignored.",
      );

      this._setManagedPersistentError(error, "status");
      return this.managedStatusState;
    }

    const current = this._managedAuthoritativeState;
    const isStale =
      current && (generation < current.generation || (generation === current.generation && version < current.version));

    if (isStale) return this.getManagedStatusState();

    const normalized = JSON.parse(stableSerialize({ ...state, generation, version }));

    if (
      current &&
      generation === current.generation &&
      version === current.version &&
      stableSerialize(normalized) !== stableSerialize(current)
    ) {
      const error = this._managedDraftError(
        "STATUS_VERSION_CONFLICT",
        "Managed status changed without advancing its authoritative version and was ignored.",
      );

      this._setManagedPersistentError(error, "status");
      return this.managedStatusState;
    }

    if (
      Number.isInteger(pollSequence) &&
      pollSequence < this._managedAcceptedPollSequence &&
      current &&
      generation === current.generation &&
      version === current.version
    ) {
      return this.getManagedStatusState();
    }

    this._managedAuthoritativeState = Object.freeze(normalized);
    if (Number.isInteger(pollSequence)) {
      this._managedAcceptedPollSequence = Math.max(this._managedAcceptedPollSequence, pollSequence);
    }

    const observedLocalSaveVersion =
      pollToken?.localSaveVersion ?? state.observed_local_save_version ?? state.observedLocalSaveVersion ?? -1;
    this._managedAuthoritativeObservedLocalSaveVersion = observedLocalSaveVersion;
    const incomingPendingCount = Number(state.pending_draft_count ?? state.pendingDraftCount ?? 0);
    const serverHasPending = Number.isInteger(incomingPendingCount) && incomingPendingCount > 0;

    for (const [taskId, local] of this._managedLocalPendingDrafts) {
      if (local.localSaveVersion > observedLocalSaveVersion) continue;
      const member = this._managedAuthoritativeMember(taskId);

      if (
        this._managedMemberDraftTokenMatches(member, local) &&
        (serverHasPending || this._managedMemberProvesCommitted(member))
      ) {
        this._managedLocalPendingDrafts.delete(taskId);
      }
    }

    this._clearManagedPersistentError("status");
    const status = this._publishManagedStatus();

    this.datamanager.invoke("managedPendingDraftsChanged", this._managedPendingDraftPayload());
    return status;
  };

  prepareManagedTaskLifecycle = (requestedAction = "reconcile") => {
    if (!this.isManagedRefinementProject) return null;
    if (!new Set(["reconcile", "discard"]).has(requestedAction)) {
      throw new TypeError("managed task lifecycle action must be reconcile or discard");
    }
    const annotation = this.currentAnnotation;
    const taskId = this.task?.id;
    const member = this._managedAuthoritativeMember(taskId);
    const identity = this._managedAnnotationIdentity(annotation);
    const baseline = identity ? this._managedDraftBaselines.get(identity) : null;
    const draftId = member?.draft_id ?? member?.draftId;
    const draftUpdatedAt = member?.draft_updated_at ?? member?.draftUpdatedAt;
    const draftSemanticHash = member?.draft_semantic_hash ?? member?.draftSemanticHash;

    if (
      !annotation ||
      !identity ||
      this._isManagedDraftSaving(annotation) ||
      annotation.history?.isFrozen === true ||
      !Number.isInteger(Number(draftId)) ||
      Number(draftId) <= 0 ||
      typeof draftUpdatedAt !== "string" ||
      !draftUpdatedAt ||
      typeof draftSemanticHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(draftSemanticHash)
    ) {
      return null;
    }

    const terminal =
      this._managedAuthoritativeState?.last_terminal_batch ?? this._managedAuthoritativeState?.lastTerminalBatch;
    if (requestedAction === "reconcile") {
      const terminalState = terminal?.state ?? terminal?.status;
      const terminalMember = member?.last_terminal_batch_member === true || member?.lastTerminalBatchMember === true;

      if (terminalState !== "succeeded" || !terminalMember) return null;
    }

    const loadedDraftTokenMatches = baseline?.receipt
      ? this._managedMemberDraftTokenMatches(member, { receipt: baseline.receipt })
      : identitiesEqual(annotation.draftId, draftId);
    const localExact =
      loadedDraftTokenMatches &&
      !this._isManagedDraftSaving(annotation) &&
      baseline?.serialized === stableSerialize(this._managedSemanticProjection(annotation));
    const action = requestedAction === "discard" ? "discard" : localExact ? "reconcile" : "inspect";
    const lifecycleKey =
      requestedAction === "reconcile"
        ? [
            terminal?.batch_id ?? terminal?.batchId,
            terminal?.generation,
            taskId,
            draftId,
            draftUpdatedAt,
            draftSemanticHash,
          ].join(":")
        : null;

    if (lifecycleKey && this._managedTerminalLifecycleKeys.has(lifecycleKey)) return null;
    return Object.freeze({
      action: requestedAction,
      lifecycleKey,
      request: Object.freeze({
        action,
        taskId: Number(taskId),
        expectedDraft: Object.freeze({
          draftId: Number(draftId),
          draftUpdatedAt,
          draftSemanticHash,
        }),
      }),
      source: this._captureManagedSource(annotation),
      sourceBrowserSemanticSerialized: stableSerialize(this._managedSemanticProjection(annotation)),
    });
  };

  _mergeManagedCommittedMetadata(annotation, committedResult) {
    const committedByKey = new Map(
      committedResult
        .filter((item) => item && typeof item.id === "string" && item.meta && typeof item.meta === "object")
        .map((item) => [item.id, item.meta]),
    );

    const history = annotation?.history;
    const freezeKey = Symbol("coordexp-managed-identity-merge");
    let mergeError = null;
    let releaseError = null;

    history?.freeze?.(freezeKey);
    try {
      for (const area of annotation?.areas?.values?.() ?? []) {
        const key = area?.presentationRegionKey ?? area?.id ?? area?.cleanId;
        const committedMeta = committedByKey.get(key);

        if (!committedMeta) continue;
        for (const result of area.results ?? []) {
          if (result?.type !== "rectanglelabels" || typeof result?.setMetaValue !== "function") continue;
          for (const field of MANAGED_COMMITTED_META_FIELDS) {
            if (Object.hasOwn(committedMeta, field)) {
              result.setMetaValue(field, cloneManagedJson(committedMeta[field]));
            }
          }
        }
      }
    } catch (error) {
      mergeError = error;
    } finally {
      try {
        const aborted = history?.abortFreeze?.(freezeKey, true) === true;

        if (!aborted) history?.safeUnfreeze?.(freezeKey);
      } catch (error) {
        history?.abortFreeze?.(freezeKey, true);
        releaseError = error;
      }
    }
    if (mergeError) throw mergeError;
    if (releaseError) throw releaseError;
  }

  applyManagedTaskLifecycle = (prepared, response) => {
    if (!prepared || !response || typeof response !== "object") {
      throw this._managedDraftError("INVALID_TASK_LIFECYCLE", "Managed task state returned an invalid response.");
    }
    const payload = response.payload ?? response;
    const committedResult = payload?.committed?.result;
    const responseDraft = payload?.draft;
    const annotation = prepared.source?.annotation;
    const stillAttached =
      !this._managedCoordinatorDestroyed &&
      annotation === this.currentAnnotation &&
      identitiesEqual(payload.task_id, prepared.source.taskId) &&
      identitiesEqual(payload.annotation_id, annotation?.pk ?? annotation?.id);

    if (!Array.isArray(committedResult) || !responseDraft || !stillAttached) {
      throw this._managedDraftError(
        "TASK_LIFECYCLE_DETACHED",
        "Managed task state no longer matches the loaded annotation.",
      );
    }
    if (this._isManagedDraftSaving(annotation) || annotation.history?.isFrozen === true) {
      // The response crossed an async boundary after prepare. Never fold
      // identity metadata into a Draft save or the user's active undo
      // transaction. Leaving the lifecycle key unconsumed makes the next idle
      // project-state poll re-read authority and retry safely.
      return this._publishManagedStatus();
    }
    const exactLocal =
      prepared.sourceBrowserSemanticSerialized === stableSerialize(this._managedSemanticProjection(annotation));
    const exactDisposition = payload.disposition === "rebased" || payload.disposition === "reset";

    if (exactDisposition && exactLocal) {
      annotation.deserializeResults(committedResult);
      annotation.reinitHistory?.();
      annotation.setDraftId?.(responseDraft.draft_id);
      annotation.setDraftSaved?.(responseDraft.draft_updated_at);
      const projection = this._managedSemanticProjection(annotation);
      const receipt = Object.freeze({
        task_id: prepared.source.taskId,
        annotation_id: payload.annotation_id,
        draft_id: responseDraft.draft_id,
        status: 200,
        revision: responseDraft.draft_updated_at,
        serialized_hash: stableHash(committedResult),
        browser_semantic_projection_hash: stableHash(projection),
        authoritative_semantic_hash: responseDraft.draft_semantic_hash,
      });

      this._managedDraftBaselines.set(prepared.source.annotationIdentity, {
        browserSemanticHash: receipt.browser_semantic_projection_hash,
        serialized: stableSerialize(projection),
        hydrated: true,
        receipt,
      });
      this.lastPersistedDraftResult = receipt;
      this._managedLocalPendingDrafts.delete(String(prepared.source.taskId));
    } else {
      this._mergeManagedCommittedMetadata(annotation, committedResult);
    }
    if (prepared.lifecycleKey) this._managedTerminalLifecycleKeys.add(prepared.lifecycleKey);
    this._clearManagedPersistentError(prepared.action === "discard" ? "discard" : "terminal");
    return this._publishManagedStatus();
  };

  failManagedTaskLifecycle = (error, action = "reconcile") => {
    const managedError =
      error instanceof CoordExpDraftSaveError
        ? error
        : this._managedDraftError(
            action === "discard" ? "DRAFT_DISCARD_FAILED" : "TERMINAL_RECONCILIATION_FAILED",
            action === "discard"
              ? "Draft reset failed. The current Draft and local edits were preserved."
              : "Committed task state could not be reconciled. The current Draft was preserved.",
          );

    this._setManagedPersistentError(managedError, action === "discard" ? "discard" : "terminal");
    return managedError;
  };

  _managedPendingDraftPayload() {
    const serverCount = Number(
      this._managedAuthoritativeState?.pending_draft_count ?? this._managedAuthoritativeState?.pendingDraftCount ?? 0,
    );
    const authoritativePendingCount = Number.isInteger(serverCount) && serverCount >= 0 ? serverCount : 0;
    const localPendingTaskCount = this._managedLocalPendingDrafts.size;
    const postPollLocalPendingTaskCount = Array.from(this._managedLocalPendingDrafts.values()).filter(
      (local) => local.localSaveVersion > this._managedAuthoritativeObservedLocalSaveVersion,
    ).length;
    const observedLocalPendingTaskCount = localPendingTaskCount - postPollLocalPendingTaskCount;
    const pendingDraftCount =
      Math.max(authoritativePendingCount, observedLocalPendingTaskCount) + postPollLocalPendingTaskCount;

    return Object.freeze({
      pendingDraftCount,
      authoritativePendingCount,
      localPendingTaskCount,
      postPollLocalPendingTaskCount,
      batchState: this._managedAuthoritativeState?.batch_state ?? this._managedAuthoritativeState?.batchState ?? null,
      activeBatchId:
        this._managedAuthoritativeState?.active_batch_id ?? this._managedAuthoritativeState?.activeBatchId ?? null,
      generation: this._managedAuthoritativeState?.generation ?? null,
      version: this._managedAuthoritativeState?.version ?? null,
      error: this._managedPersistentError,
    });
  }

  _captureManagedSource(annotation = this.currentAnnotation) {
    const taskId = this._managedAnnotationTaskId(annotation);

    return Object.freeze({
      taskId,
      annotation,
      annotationIdentity: this._managedAnnotationIdentity(annotation),
      serializedHash: annotation ? stableHash(this._serializeManagedAnnotation(annotation)) : null,
      historyEpoch: this._managedHistoryEpoch(annotation),
    });
  }

  _assertManagedSourceIdentity(source) {
    if (!identitiesEqual(this.task?.id, source.taskId)) {
      throw new CoordExpDraftSaveError(
        "SOURCE_TASK_CHANGED",
        "The task changed while its Draft was being saved. Please retry from the current task.",
      );
    }

    if (!source.annotation) return;

    const selected = this.currentAnnotation;
    const selectedIdentity = this._managedAnnotationIdentity(selected);

    if (selected !== source.annotation || selectedIdentity !== source.annotationIdentity) {
      throw new CoordExpDraftSaveError(
        "SOURCE_ANNOTATION_CHANGED",
        "The selected annotation changed while its Draft was being saved. Please retry.",
      );
    }
  }

  _managedDraftError(code, message) {
    return new CoordExpDraftSaveError(code, message);
  }

  _validateManagedDraftResponse(response, source, requestIdentity) {
    if (!response || typeof response !== "object") {
      throw this._managedDraftError("EMPTY_RESPONSE", "Draft save did not return a valid response. Please retry.");
    }

    if (response.error != null || response.response?.error != null) {
      throw this._managedDraftError("RESOLVED_API_ERROR", "Draft save failed. Your local edits are still present.");
    }

    const status = response.$meta?.status;

    if (!Number.isInteger(status)) {
      throw this._managedDraftError("MISSING_RESPONSE_STATUS", "Draft save could not be verified. Please retry.");
    }

    if (status < 200 || status >= 300) {
      throw this._managedDraftError("DRAFT_HTTP_ERROR", "Draft save failed. Your local edits are still present.");
    }

    if (!Number.isInteger(response.id) || response.id <= 0) {
      throw this._managedDraftError("INVALID_DRAFT_ID", "Draft save returned an invalid Draft identity. Please retry.");
    }

    if (requestIdentity.draftId !== null && !identitiesEqual(response.id, requestIdentity.draftId)) {
      throw this._managedDraftError("DRAFT_ID_MISMATCH", "Draft update returned a different Draft identity.");
    }

    if (!Object.hasOwn(response, "task") || !identitiesEqual(response.task, source.taskId)) {
      throw this._managedDraftError("DRAFT_TASK_MISMATCH", "Draft save returned a different task identity.");
    }

    if (!Object.hasOwn(response, "annotation")) {
      throw this._managedDraftError("DRAFT_ANNOTATION_MISMATCH", "Draft save did not return its annotation identity.");
    }

    if (requestIdentity.annotationId === null && response.annotation !== null) {
      throw this._managedDraftError(
        "DRAFT_ANNOTATION_MISMATCH",
        "Draft save returned a different annotation identity.",
      );
    }

    if (requestIdentity.annotationId !== null && !identitiesEqual(response.annotation, requestIdentity.annotationId)) {
      throw this._managedDraftError(
        "DRAFT_ANNOTATION_MISMATCH",
        "Draft save returned a different annotation identity.",
      );
    }

    if (typeof response.updated_at !== "string" || !response.updated_at.trim()) {
      throw this._managedDraftError("MISSING_DRAFT_UPDATED_AT", "Draft save did not return a durable server revision.");
    }

    this._assertManagedSourceIdentity(source);
    return status;
  }

  _managedDraftRevision(response) {
    return response.updated_at;
  }

  _managedReceipt(response, source, annotation, payloadHash, browserSemanticHash) {
    return Object.freeze({
      task_id: source.taskId,
      annotation_id: annotation.pk ?? annotation.id,
      draft_id: response.id,
      status: response.$meta.status,
      revision: this._managedDraftRevision(response),
      serialized_hash: payloadHash,
      browser_semantic_projection_hash: browserSemanticHash,
      authoritative_semantic_hash: null,
    });
  }

  async _performManagedDraftRequest(annotation, serializedResult, source, params = {}) {
    if (this._managedCoordinatorDestroyed) return MANAGED_DRAFT_DETACHED_RESULT;

    const taskId = source.taskId;
    const requestIdentity = Object.freeze({
      draftId: annotation.draftId > 0 ? annotation.draftId : null,
      annotationId: annotation.pk ?? null,
    });
    const data = { body: this.prepareData(annotation, { isNewDraft: true }) };
    const requestParams = { ...params };

    delete requestParams.useToast;
    data.body.result = serializedResult;
    Object.assign(data.body, requestParams);

    try {
      await this.saveUserLabels();
      if (this._managedCoordinatorDestroyed) return MANAGED_DRAFT_DETACHED_RESULT;
      this._assertManagedSourceIdentity(source);

      let response;
      if (requestIdentity.draftId !== null) {
        response = await this.datamanager.apiCall("updateDraft", { draftID: requestIdentity.draftId }, data);
      } else if (!annotation.pk) {
        response = await this.datamanager.apiCall("createDraftForTask", { taskID: taskId }, data);
      } else {
        response = await this.datamanager.apiCall(
          "createDraftForAnnotation",
          { taskID: taskId, annotationID: annotation.pk },
          data,
        );
      }

      if (this._managedCoordinatorDestroyed) return MANAGED_DRAFT_DETACHED_RESULT;
      const status = this._validateManagedDraftResponse(response, source, requestIdentity);

      if (requestIdentity.draftId === null) annotation.setDraftId(response.id);

      const semanticProjection = managedSemanticProjection(serializedResult);
      const payloadHash = stableHash(serializedResult);
      const browserSemanticHash = stableHash(semanticProjection);
      const serialized = stableSerialize(semanticProjection);
      const receipt = this._managedReceipt(response, source, annotation, payloadHash, browserSemanticHash);
      const identity = source.annotationIdentity;

      this._managedDraftBaselines.set(identity, {
        browserSemanticHash,
        serialized,
        hydrated: false,
        receipt,
      });
      this.lastPersistedDraftResult = receipt;
      this._managedLocalPendingDrafts.set(String(source.taskId), {
        localSaveVersion: ++this._managedLocalSaveVersion,
        receipt,
      });
      this._clearManagedPersistentError("draft");
      this.datamanager.invoke("submitDraft", this, annotation, response);
      this.datamanager.invoke("managedPendingDraftsChanged", this._managedPendingDraftPayload());
      this._publishManagedStatus();

      return { browserSemanticHash, payloadHash, response, receipt, status };
    } catch (error) {
      if (this._managedCoordinatorDestroyed) return MANAGED_DRAFT_DETACHED_RESULT;
      const managedError =
        error instanceof CoordExpDraftSaveError
          ? error
          : this._managedDraftError("DRAFT_REQUEST_FAILED", "Draft save failed. Your local edits are still present.");

      this._setManagedPersistentError(managedError, "draft");
      throw managedError;
    }
  }

  async _runManagedDraftSave(annotation, { force = false, params = {} } = {}) {
    const source = this._captureManagedSource(annotation);
    const seenProgress = new Set();
    let lastResult = null;

    annotation.setDraftSaving?.(true);

    try {
      for (let attempt = 0; attempt < MANAGED_DRAFT_MAX_SAVE_ATTEMPTS; attempt++) {
        const serializedResult = this._serializeManagedAnnotation(annotation);
        const semanticProjection = managedSemanticProjection(serializedResult);
        const browserSemanticHash = stableHash(semanticProjection);
        const serialized = stableSerialize(semanticProjection);
        const progressKey = `${browserSemanticHash}:${this._managedHistoryEpoch(annotation)}`;
        const baseline = this._managedDraftBaselines.get(source.annotationIdentity);
        const needsSave = force || baseline?.serialized !== serialized;

        if (!needsSave) return lastResult;

        this._assertManagedSourceIdentity(source);

        if (seenProgress.has(progressKey)) {
          throw this._managedDraftError(
            "DRAFT_SAVE_NO_PROGRESS",
            "Draft edits did not stabilize while saving. Please pause editing and retry.",
          );
        }
        seenProgress.add(progressKey);

        lastResult = await this._performManagedDraftRequest(annotation, serializedResult, source, params);
        if (lastResult === MANAGED_DRAFT_DETACHED_RESULT) return lastResult;
        force = false;

        const latestSerialized = stableSerialize(this._managedSemanticProjection(annotation));

        if (latestSerialized === serialized) {
          annotation.setDraftSaved?.(lastResult.receipt.revision ?? new Date().toISOString());
          return lastResult;
        }
      }

      throw this._managedDraftError(
        "DRAFT_SAVE_DID_NOT_STABILIZE",
        "Draft edits kept changing while saving. Please pause editing and retry.",
      );
    } finally {
      if (!this._managedCoordinatorDestroyed) annotation.setDraftSaving?.(false);
    }
  }

  _saveManagedDraft(annotation, options = {}) {
    if (this._managedCoordinatorDestroyed) return Promise.resolve(MANAGED_DRAFT_DETACHED_RESULT);
    if (!annotation) return Promise.resolve(null);

    const identity = this._managedAnnotationIdentity(annotation);

    if (!identity) {
      return Promise.reject(
        this._managedDraftError("MISSING_ANNOTATION_IDENTITY", "The current annotation has no stable local identity."),
      );
    }

    const inFlight = this._managedDraftSaves.get(identity);

    if (inFlight) {
      const hasPersistedParams = Object.keys(options.params ?? {}).some((key) => key !== "useToast");

      if (hasPersistedParams) return inFlight.then(() => this._saveManagedDraft(annotation, options));
      if (options.force === true) {
        return inFlight.then((result) => (result?.receipt ? result : this._saveManagedDraft(annotation, options)));
      }
      return inFlight;
    }

    let hydration = this._managedAnnotationHydrations.get(identity);

    // Every explicit managed save owns the load-before-save ordering. This is
    // required even when the UI's deferred FIT-720 selection callback has not
    // registered the lazy stub yet. A task reload also starts a new generation
    // when it replaces the MST node under the same stable identity.
    if (!hydration || hydration.annotation !== annotation) {
      this._hydrateStubAnnotation(annotation);
      hydration = this._managedAnnotationHydrations.get(identity);
    }
    const saveOperation =
      hydration?.status !== "ready"
        ? this._awaitManagedAnnotationHydration(annotation)
            .then(() => {
              if (this._managedCoordinatorDestroyed) return MANAGED_DRAFT_DETACHED_RESULT;
              return this._runManagedDraftSave(annotation, options);
            })
            .catch((error) => {
              if (error instanceof CoordExpDraftSaveError) this._setManagedPersistentError(error, "draft");
              throw error;
            })
        : this._runManagedDraftSave(annotation, options);
    const operation = saveOperation.finally(() => {
      if (this._managedDraftSaves.get(identity) === operation) this._managedDraftSaves.delete(identity);
      this._pruneManagedAnnotationHydrations();
    });

    this._managedDraftSaves.set(identity, operation);
    return operation;
  }

  ensureDurableDraft = async () => {
    if (!this.isManagedRefinementProject) {
      throw this._managedDraftError(
        "PROJECT_NOT_MANAGED",
        "Durable refinement Draft receipts are only available for managed refinement projects.",
      );
    }

    const annotation = this.currentAnnotation;

    this._claimManagedDraftSaveOwner(annotation);
    const result = await this._saveManagedDraft(annotation, { force: true });

    if (!result?.receipt) {
      throw this._managedDraftError("MISSING_DRAFT_RECEIPT", "Draft save did not produce a durable receipt.");
    }

    return result.receipt;
  };

  _notifyManagedNavigationBlocked(error, reason) {
    if (this._managedPersistentError?.domain !== "draft") {
      this._setManagedPersistentError(error, "navigation");
    }
    this.datamanager.invoke("managedNavigationBlocked", { error, reason });
    this.datamanager.invoke("toast", { message: error.message, type: "error" });
  }

  _emitManagedNavigationReminder(reason) {
    if (this._managedCoordinatorDestroyed) return;
    const pending = this._managedPendingDraftPayload();

    if (pending.pendingDraftCount <= 0 && pending.localPendingTaskCount <= 0) return;
    this.datamanager.invoke("managedNavigationReminder", { ...pending, reason });
  }

  _managedNavigationCancelledDisposition(intentOrKey) {
    const intentKey = typeof intentOrKey === "string" ? intentOrKey : (intentOrKey?.intentKey ?? null);

    return Object.freeze({ intentKey, reason: "destroyed", status: "cancelled" });
  }

  _cancelManagedNavigationCoordinator() {
    if (this._managedCoordinatorDestroyed) return;

    this._managedCoordinatorDestroyed = true;
    const intents = [this._managedNavigationCurrent, ...this._managedNavigationQueue].filter(Boolean);

    this._managedNavigationCurrent = null;
    this._managedNavigationQueue = [];
    for (const intent of new Set(intents)) {
      intent.cancelled = true;
      intent.phase = "cancelled";
      intent.resolve(this._managedNavigationCancelledDisposition(intent));
    }
  }

  _executeManagedNavigation = async (intent) => {
    try {
      if (this._managedCoordinatorDestroyed || intent.cancelled) {
        return this._managedNavigationCancelledDisposition(intent);
      }
      intent.phase = "saving";
      if (this._managedRoiRunning) {
        throw this._managedDraftError(
          "ROI_RUNNING",
          "Wait for the current AI Region inference before leaving this annotation.",
        );
      }

      const annotation = intent.sourceAnnotation ?? this.currentAnnotation;

      this._claimManagedDraftSaveOwner(annotation);
      const source = this._captureManagedSource(annotation);

      this._assertManagedSourceIdentity(source);

      if (this._isManagedAnnotationDirty(annotation) || this._isManagedDraftSaving(annotation)) {
        await this._saveManagedDraft(annotation);
      }

      if (this._managedCoordinatorDestroyed || intent.cancelled) {
        return this._managedNavigationCancelledDisposition(intent);
      }

      this._assertManagedSourceIdentity(source);

      if (this._isManagedAnnotationDirty(annotation)) {
        throw this._managedDraftError("DRAFT_REMAINED_DIRTY", "The latest edits were not durably saved. Please retry.");
      }

      intent.phase = "acting";
      const result = await intent.action();
      if (this._managedCoordinatorDestroyed || intent.cancelled) {
        return this._managedNavigationCancelledDisposition(intent);
      }
      this._pruneManagedAnnotationHydrations();
      const navigationResult = intent.supersededIntentKeys?.length
        ? Object.freeze({
            finalIntentKey: intent.intentKey,
            result,
            status: "coalesced",
            supersededIntentKeys: Object.freeze([...intent.supersededIntentKeys]),
          })
        : result;

      this._clearManagedPersistentError("navigation");
      this._publishManagedStatus();
      this._emitManagedNavigationReminder(intent.reason);
      return navigationResult;
    } catch (error) {
      if (this._managedCoordinatorDestroyed || intent.cancelled) {
        return this._managedNavigationCancelledDisposition(intent);
      }
      if (!(error instanceof CoordExpDraftSaveError)) throw error;
      this._notifyManagedNavigationBlocked(error, intent.reason);
      return false;
    } finally {
      if (!intent.cancelled) intent.phase = "settled";
    }
  };

  _drainManagedNavigationQueue() {
    if (
      this._managedCoordinatorDestroyed ||
      this._managedNavigationCurrent ||
      this._managedNavigationQueue.length === 0
    )
      return;

    const intent = this._managedNavigationQueue.shift();

    this._managedNavigationCurrent = intent;
    Promise.resolve()
      .then(() => this._executeManagedNavigation(intent))
      .then(intent.resolve, intent.reject)
      .finally(() => {
        if (this._managedNavigationCurrent === intent) this._managedNavigationCurrent = null;
        this._drainManagedNavigationQueue();
      });
  }

  coordinateManagedNavigation = (
    action,
    { coalesceKey: requestedCoalesceKey, reason = "navigation", sourceAnnotation, intentKey: requestedIntentKey } = {},
  ) => {
    if (!this.isManagedRefinementProject) return Promise.resolve().then(action);
    if (this._managedCoordinatorDestroyed) {
      return Promise.resolve(this._managedNavigationCancelledDisposition(requestedIntentKey ?? null));
    }
    if (typeof action !== "function") return Promise.reject(new TypeError("navigation action must be a function"));

    const intentKey =
      typeof requestedIntentKey === "string" && requestedIntentKey.trim()
        ? requestedIntentKey
        : `${reason}:intent-${++this._managedNavigationSequence}`;
    const coalesceKey =
      typeof requestedCoalesceKey === "string" && requestedCoalesceKey.trim() ? requestedCoalesceKey : null;
    const duplicate =
      (this._managedNavigationCurrent?.intentKey === intentKey && this._managedNavigationCurrent) ||
      this._managedNavigationQueue.find((intent) => intent.intentKey === intentKey);

    if (duplicate) return duplicate.promise;

    const coalescible = coalesceKey
      ? [this._managedNavigationCurrent, ...this._managedNavigationQueue].find(
          (intent) => intent?.coalesceKey === coalesceKey && intent.phase !== "acting" && intent.phase !== "settled",
        )
      : null;

    if (coalescible) {
      coalescible.supersededIntentKeys ??= [];
      coalescible.supersededIntentKeys.push(coalescible.intentKey);
      coalescible.action = action;
      coalescible.intentKey = intentKey;
      coalescible.reason = reason;
      return coalescible.promise;
    }

    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const intent = {
      action,
      coalesceKey,
      intentKey,
      phase: "queued",
      promise,
      reason,
      reject,
      resolve,
      sourceAnnotation,
    };

    this._managedNavigationQueue.push(intent);
    this._drainManagedNavigationQueue();
    return promise;
  };

  /** @private */
  async preloadTask() {
    const { comment: commentId, task: taskID } = this.preload;
    const api = this.datamanager.api;
    const params = { taskID };

    if (commentId) {
      params.with_comment = commentId;
    }

    if (params) {
      const task = await api.call("task", { params });
      const noData = !task || (!task.annotations?.length && !task.drafts?.length);
      const body = `Task #${taskID}${commentId ? ` with comment #${commentId}` : ""} was not found!`;

      if (noData) {
        Modal.modal({
          title: "Can't find task",
          body,
        });
        return false;
      }

      // for preload it's good to always load the first one
      const annotation = task.annotations[0];

      await this.selectTask(task, annotation?.id, true);
    }

    return false;
  }

  async loadTask(taskID, annotationID, fromHistory = false) {
    if (!this.isManagedRefinementProject) {
      return this._loadTaskUncoordinated(taskID, annotationID, fromHistory);
    }

    return this.coordinateManagedNavigation(() => this._loadTaskUncoordinated(taskID, annotationID, fromHistory), {
      intentKey: `task:${taskID ?? "next"}:annotation:${annotationID ?? "auto"}`,
      reason: "load-task",
    });
  }

  /** @private */
  async _loadTaskUncoordinated(taskID, annotationID, fromHistory = false) {
    if (!this.lsf) {
      return console.error("Make sure that LSF was properly initialized");
    }

    const nextAction = async () => {
      const tasks = this.datamanager.store.taskStore;

      const newTask = await this.withinLoadingState(async () => {
        let nextTask;

        if (!isDefined(taskID)) {
          nextTask = await tasks.loadNextTask();
        } else {
          nextTask = await tasks.loadTask(taskID);
        }

        /**
         * If we're in label stream and there's no task – end the stream
         * Otherwise allow user to continue exploring tasks after finished labelling
         */
        const noTask = this.labelStream && !nextTask;

        this.lsf.setFlags({ noTask });

        return nextTask;
      });

      // Add new data from received task
      if (newTask) await this.selectTask(newTask, annotationID, fromHistory);
    };

    if (isFF(FF_DEV_2887) && this.lsf?.commentStore?.hasUnsaved) {
      Modal.confirm({
        title: "You have unsaved changes",
        body: "There are comments which are not persisted. Please submit the annotation. Continuing will discard these comments.",
        onOk() {
          nextAction();
        },
        okText: "Discard and continue",
      });
      return;
    }

    await nextAction();
  }

  exitStream() {
    const exit = () => this.datamanager.invoke("navigate", "projects");

    if (!this.isManagedRefinementProject) return exit();
    return this.coordinateManagedNavigation(exit, { intentKey: "exit-stream", reason: "exit-stream" });
  }

  async selectTask(task, annotationID, fromHistory = false) {
    const needsAnnotationsMerge = task && this.task?.id === task.id;
    const annotations = needsAnnotationsMerge ? [...this.annotations] : [];

    this.task = task;

    if (needsAnnotationsMerge) {
      this.task.mergeAnnotations(annotations);
    }

    this.loadUserLabels();

    await this.setLSFTask(task, annotationID, fromHistory);
  }

  async setLSFTask(task, annotationID, fromHistory, selectPrediction = false) {
    if (!this.lsf) return;

    if (isFF(FF_FIT_1304_STRICT_OVERLAP)) {
      this.dismissOverlapToast();
    }

    const hasChangedTasks = this.lsf?.task?.id !== task?.id && task?.id;

    this.setLoading(true, hasChangedTasks);

    // Let the browser paint the loading indicator before heavy store operations
    await waitForPaint();

    if (!this.lsf) return;

    // Pure data preparation (no MobX mutations)
    const lsfTask = taskToLSFormat(task);
    const isRejectedQueue = isDefined(task.default_selected_annotation);
    const taskList = this.datamanager.store.taskStore.list;
    const taskHistory = taskList
      .map((task) => this.taskHistory.find((item) => item.taskId === task.id))
      .filter(Boolean);

    const extracted = taskHistory.find((item) => item.taskId === task.id);

    if (!fromHistory && extracted) {
      taskHistory.splice(taskHistory.indexOf(extracted), 1);
      taskHistory.push(extracted);
    }

    if (!extracted) {
      taskHistory.push({ taskId: task.id, annotationId: null });
    }

    if (isRejectedQueue && !annotationID) {
      annotationID = task.default_selected_annotation;
    }

    // Batch store reset and interface mutations in a single MobX transaction
    // so reactions fire only once instead of cascading after each action.
    // initializeStore must run OUTSIDE this batch because it calls afterReset()
    // which re-attaches shared stores (e.g. Taxonomy). If detach() and re-attach
    // happen in the same transaction, MST throws "already part of state tree".
    runInAction(() => {
      if (hasChangedTasks) {
        this.lsf.resetState();
      } else {
        this.lsf.resetAnnotationStore();
      }

      this.lsf.toggleInterface("postpone", this.task.allow_postpone !== false);
      this.lsf.toggleInterface("topbar:task-counter", true);

      if (isFF(FF_FIT_1304_STRICT_OVERLAP)) {
        const overlapReached = this.task.overlap_reached === true;
        this.overlapReached = overlapReached;
        this.overlapReachedMessage =
          this.task.overlap_reached_message ||
          "Annotation overlap has been reached for this task. Your draft is preserved but cannot be submitted.";

        this.lsf.setFlags({
          overlapReached,
          overlapReachedMessage: this.overlapReachedMessage,
        });
      } else {
        this.overlapReached = false;
        this.overlapReachedMessage = "";
      }

      this.lsf.assignTask(task);
    });

    this.lsf.initializeStore(lsfTask);

    this._claimManagedDraftSaveOwners();

    await this.setAnnotation(annotationID, fromHistory || isRejectedQueue, selectPrediction);
    this._finalizeManagedDraftBaselineAfterLoad(this.currentAnnotation);
    this.setLoading(false);

    if (isFF(FF_FIT_1304_STRICT_OVERLAP) && this.overlapReached) {
      this.showOverlapReachedMessage();
    }
  }

  /**
   * Show informational message when overlap is reached
   * @private
   */
  showOverlapReachedMessage() {
    // Use info toast to communicate the overlap status
    // This is informational, not an error, so we use a neutral tone
    // Use a specific ID so we can dismiss this toast without affecting others
    this.datamanager.invoke("toast", {
      id: OVERLAP_TOAST_ID,
      message: (
        <div className="flex items-center justify-between">
          <span>{this.overlapReachedMessage}</span>
          <Button
            onClick={() => {
              this.datamanager.invoke("toast:dismiss", { id: OVERLAP_TOAST_ID });
              this.handleOverlapNextTask();
            }}
            className="ml-4"
            size="small"
            look="outlined"
          >
            Next Task
          </Button>
        </div>
      ),
      type: "info",
      duration: -1,
    });
  }

  /**
   * Dismiss the overlap reached toast if it's showing
   * @private
   */
  dismissOverlapToast() {
    this.datamanager.invoke("toast:dismiss", { id: OVERLAP_TOAST_ID });
  }

  /**
   * Ensure annotation is fully loaded (for lazy loading - FIT-720)
   * If the annotation is a stub, fetch the full annotation data from the server.
   * @param {string} annotationPk - The annotation pk to load
   * @returns {Promise<Object|null>} The full annotation data or null if not a stub
   * @private
   */
  async ensureAnnotationLoaded(annotationPk) {
    if (!isFF(FF_FIT_720_LAZY_LOAD_ANNOTATIONS) || !this.labelStream) {
      return null;
    }

    // Check if this annotation is a stub in the original task data
    const taskAnnotation = this.task?.annotations?.find((a) => String(a.id) === String(annotationPk));
    if (!taskAnnotation?.is_stub) {
      return null;
    }

    // Fetch full annotation from backend
    try {
      const taskStore = this.datamanager.store.taskStore;
      const fullAnnotation = await taskStore.loadAnnotation(annotationPk);

      if (fullAnnotation && !fullAnnotation.error) {
        // IMPORTANT: Re-fetch the annotation from the store after async operation
        // The original reference might be stale (user navigated, scrolled, etc.)
        // which causes MST "object is protected" errors
        const lsfAnnotation = this.annotations.find((a) => String(a.pk) === String(annotationPk));
        if (!lsfAnnotation) {
          // Annotation no longer exists in the store
          return fullAnnotation;
        }
        if (!isAlive(lsfAnnotation) || !isAlive(lsfAnnotation.trackedState)) {
          // Annotation node was detached while hydration request was in-flight
          return fullAnnotation;
        }

        // Check if already hydrated while we were fetching
        const versionsResult = lsfAnnotation.versions?.result;
        const hasVersionsResult = Array.isArray(versionsResult) && versionsResult.length > 0;
        const hasRegions = lsfAnnotation.areas?.size > 0;

        if (hasVersionsResult || hasRegions) {
          // Already hydrated
          return fullAnnotation;
        }

        if (fullAnnotation.result) {
          if (!isAlive(lsfAnnotation) || !isAlive(lsfAnnotation.trackedState)) return fullAnnotation;
          lsfAnnotation.history.freeze();
          lsfAnnotation.deserializeResults(fullAnnotation.result);
          // Critical: updateObjects() is required to render visual regions after deserializing
          lsfAnnotation.updateObjects();
          lsfAnnotation.history.safeUnfreeze();
          lsfAnnotation.history.reinit();
        }

        return fullAnnotation;
      }
    } catch {
      // Failed to load annotation - will retry on next attempt
    }

    return null;
  }

  /** @private */
  async setAnnotation(annotationID, selectAnnotation = false, selectPrediction = false) {
    const id = annotationID ? annotationID.toString() : null;
    const { annotationStore: cs } = this.lsf;
    let annotation;
    const activeDrafts = cs.annotations.map((a) => a.draftId).filter(Boolean);

    if (this.task.drafts) {
      for (const draft of this.task.drafts) {
        if (activeDrafts.includes(draft.id)) continue;
        let c;

        if (draft.annotation) {
          // Annotation existed - add draft to existed annotation
          const draftAnnotationPk = String(draft.annotation);

          c = cs.annotations.find((c) => c.pk === draftAnnotationPk);
          if (c) {
            c.history.freeze();
            c.addVersions({ draft: draft.result });
            c.deleteAllRegions({ deleteReadOnly: true });
          } else {
            // that shouldn't happen
            console.error(`No annotation found for pk=${draftAnnotationPk}`);
            continue;
          }
        } else {
          // Annotation not found - restore annotation from draft
          c = cs.addAnnotation({
            draft: draft.result,
            userGenerate: true,
            comment_count: draft.comment_count,
            unresolved_comment_count: draft.unresolved_comment_count,
            createdBy: draft.created_username,
            createdAgo: draft.created_ago,
            createdDate: draft.created_at,
          });
        }
        cs.selectAnnotation(c.id);
        c.deserializeResults(draft.result);
        c.setDraftId(draft.id);
        c.setDraftSaved(draft.created_at);
        c.history.safeUnfreeze();
        c.history.reinit();
      }
    }
    const first = this.annotations?.length ? this.annotations[0] : null;
    // if we have annotations created automatically, we don't need to create another one
    // automatically === created here and haven't saved yet, so they don't have pk
    // @todo because of some weird reason pk may be string uid, so check flags then
    const hasAutoAnnotations = !!first && (!first.pk || (first.userGenerate && first.sentUserGenerate === false));
    const showPredictions = this.project.show_collab_predictions === true;

    if (this.labelStream) {
      if (first?.draftId) {
        // not submitted draft, most likely from previous labeling session
        annotation = first;
      } else if (isDefined(annotationID) && selectAnnotation) {
        // Lazy load annotation if it's a stub (FIT-720)
        await this.ensureAnnotationLoaded(annotationID);
        annotation = this.annotations.find(({ pk }) => pk === annotationID);
      } else if (showPredictions && this.predictions.length > 0 && !this.isInteractivePreannotations) {
        annotation = cs.addAnnotationFromPrediction(this.predictions[0]);
      } else {
        annotation = cs.createAnnotation();
      }
    } else {
      if (selectPrediction) {
        annotation = this.predictions.find((p) => p.pk === id);
        annotation ??= first; // if prediction not found, select first annotation and resume existing behaviour
      } else if (this.annotations.length === 0 && this.predictions.length > 0 && !this.isInteractivePreannotations) {
        const predictionByModelVersion = this.predictions.find((p) => p.createdBy === this.project.model_version);
        annotation = cs.addAnnotationFromPrediction(predictionByModelVersion ?? this.predictions[0]);
      } else if (this.annotations.length > 0 && id && id !== "auto") {
        annotation = this.annotations.find((c) => c.pk === id || c.id === id);
      } else if (this.annotations.length > 0 && (id === "auto" || hasAutoAnnotations)) {
        annotation = first;
      } else {
        annotation = cs.createAnnotation();
      }
    }

    if (annotation) {
      // We want to be sure this is explicitly understood to be a prediction and the
      // user wants to select it directly
      if (selectPrediction && annotation.type === "prediction") {
        cs.selectPrediction(annotation.id);
      } else {
        // Otherwise we default the behaviour to being as was before
        cs.selectAnnotation(annotation.id);
      }
      this.datamanager.invoke("annotationSet", annotation);
    }
  }

  saveUserLabels = async () => {
    const body = [];
    const userLabels = this.lsf?.userLabels?.controls;

    if (!userLabels) return;

    for (const from_name in userLabels) {
      for (const label of userLabels[from_name]) {
        body.push({
          value: label.path,
          title: [from_name, JSON.stringify(label.path)].join(":"),
          from_name,
          project: this.project.id,
        });
      }
    }

    if (!body.length) return;

    await this.datamanager.apiCall("saveUserLabels", {}, { body });
  };

  async loadUserLabels() {
    if (!this.lsf?.userLabels) return;

    const userLabels = await this.datamanager.apiCall("userLabelsForProject", {
      project: this.project.id,
      expand: "label",
    });

    if (!userLabels) return;

    const controls = {};

    for (const result of userLabels.results ?? []) {
      // don't trust server's response!
      if (!result?.label?.value?.length) continue;

      const control = result.from_name;

      if (!controls[control]) controls[control] = [];
      controls[control].push(result.label.value);
    }

    this.lsf.userLabels.init(controls);
  }

  onLabelStudioLoad = async (ls) => {
    this.datamanager.invoke("labelStudioLoad", ls);
    this.lsf = ls;

    if (!this.lsf.task) this.setLoading(true);

    const _taskHistory = await this.datamanager.store.taskStore.loadTaskHistory({
      projectId: this.datamanager.store.project.id,
    });

    this.lsf.setTaskHistory(_taskHistory);

    await this.loadUserLabels();

    if (this.canPreloadTask && isFF(FF_DEV_1752)) {
      await this.preloadTask();
    } else if (this.labelStream) {
      await this.loadTask();
    }

    this.setLoading(false);
  };

  /** @private */
  onTaskLoad = async (...args) => {
    this.datamanager.invoke("onSelectAnnotation", ...args);
  };

  /**
   * Proxy urls to presign them if storage is connected
   * @param {*} _ LS instance
   * @param {string} url http/https are not proxied and returned as is
   */
  onPresignUrlForProject = (_, url) => {
    // if URL is a relative, presigned url (url matches /tasks|projects/:id/resolve/.*) make it absolute
    const presignedUrlPattern = /^\/(?:tasks|projects)\/\d+\/resolve\/?/;
    if (presignedUrlPattern.test(url)) {
      url = new URL(url, document.location.origin).toString();
    }

    const parsedUrl = new URL(url);

    // return same url if http(s)
    if (["http:", "https:"].includes(parsedUrl.protocol)) return url;

    const api = this.datamanager.api;
    const projectId = this.project.id;
    const fileuri = btoa(url);

    return api.createUrl(api.endpoints.presignUrlForProject, { projectId, fileuri }).url;
  };

  onStorageInitialized = async (ls) => {
    this._claimManagedDraftSaveOwners();
    this.datamanager.invoke("onStorageInitialized", ls);

    if (this.task && this.labelStream === false) {
      const annotationID =
        this.initialAnnotation?.pk ?? this.task.lastAnnotation?.pk ?? this.task.lastAnnotation?.id ?? "auto";

      await this.setAnnotation(annotationID);
      this._finalizeManagedDraftBaselineAfterLoad(this.currentAnnotation);
    }
  };

  /** @private */
  showOperationToast(status, successMessage, errorAction, result) {
    if (status === 200 || status === 201) {
      this.datamanager.invoke("toast", { message: successMessage, type: "info" });
    } else if (status !== undefined) {
      // Skip toast for errors that are handled by global modal handlers via display_context
      // These errors bubble up to ApiProvider which shows appropriate modals
      // Note: display_context is in result.response for API error responses
      const displayReason = result?.response?.display_context?.reason;
      const isPausedError = displayReason === "PAUSED";
      const isOverlapError = isFF(FF_FIT_1304_STRICT_OVERLAP) && displayReason === "OVERLAP_REACHED";
      if (isPausedError || isOverlapError) {
        // Also update local state for overlap reached (only when feature flag is enabled)
        if (isOverlapError) {
          this.overlapReached = true;
          this.overlapReachedMessage =
            result?.response?.detail ||
            "Annotation overlap has been reached for this task. Your draft is preserved but cannot be submitted.";
          // Set overlap state on LSF store - this will disable buttons with tooltips
          this.lsf.setFlags({
            overlapReached: true,
            overlapReachedMessage: this.overlapReachedMessage,
          });
        }
        return;
      }

      const requestId = result?.$meta?.headers?.get("x-ls-request-id");
      const supportUrl = requestId ? `${SUPPORT_URL}?${SUPPORT_URL_REQUEST_ID_PARAM}=${requestId}` : SUPPORT_URL;

      this.datamanager.invoke("toast", {
        message: (
          <span>
            {errorAction}, please try again or{" "}
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={(e) => e.stopPropagation()}
            >
              contact our team
            </a>{" "}
            if it doesn't help.
          </span>
        ),
        type: "error",
      });
    }
  }

  /** @private */
  onSubmitAnnotation = async () => {
    // Prevent submission if overlap is reached (only when feature flag is enabled)
    if (isFF(FF_FIT_1304_STRICT_OVERLAP) && this.overlapReached) {
      this.showOverlapReachedMessage();
      return;
    }

    const exitStream = this.shouldExitStream();
    const loadNext = exitStream ? false : this.shouldLoadNext();
    const result = await this.submitCurrentAnnotation(
      "submitAnnotation",
      async (taskID, body) => {
        return await this.datamanager.apiCall(
          "submitAnnotation",
          { taskID },
          { body },
          // errors are displayed by "toast" event - we don't want to show blocking modal
          { errorHandler: errorHandlerAllowSpecialErrors },
        );
      },
      false,
      loadNext,
    );
    const status = result?.$meta?.status;

    this.showOperationToast(status, "Annotation saved successfully", "Annotation is not saved", result);

    // FIT-720: Invalidate caches after successful submit
    if (status < 400) {
      // Invalidate specific annotation if ID is in result
      if (result?.id) {
        invalidateAnnotationCache(result.id);
      }
      // Invalidate distribution for the task
      invalidateDistributionCache(this.task?.id);
    }

    if (exitStream) return this.exitStream();
  };

  /** @private */
  onUpdateAnnotation = async (ls, annotation, extraData) => {
    const { task } = this;
    const serializedAnnotation = this.prepareData(annotation);
    const exitStream = this.shouldExitStream();

    Object.assign(serializedAnnotation, extraData);

    await this.saveUserLabels();

    const result = await this.withinLoadingState(async () => {
      return this.datamanager.apiCall(
        "updateAnnotation",
        {
          taskID: task.id,
          annotationID: annotation.pk,
        },
        {
          body: serializedAnnotation,
        },
        // errors are displayed by "toast" event - we don't want to show blocking modal
        { errorHandler: errorHandlerAllowSpecialErrors },
      );
    });
    const status = result?.$meta?.status;

    this.showOperationToast(status, "Annotation updated successfully", "Annotation is not updated", result);

    this.datamanager.invoke("updateAnnotation", ls, annotation, result);

    // FIT-720: Invalidate annotation cache after successful update
    if (status < 400 && annotation.pk) {
      invalidateAnnotationCache(annotation.pk);
      invalidateDistributionCache(task.id);
    }

    if (exitStream) return this.exitStream();

    if (status >= 400) {
      return;
    }

    const isRejectedQueue = isDefined(task.default_selected_annotation);

    if (isRejectedQueue) {
      // load next task if that one was updated task from rejected queue
      await this.loadTask();
    } else {
      await this.loadTask(this.task.id, annotation.pk, true);
    }
  };

  deleteDraft = async (id) => {
    const response = await this.datamanager.apiCall("deleteDraft", {
      draftID: id,
    });

    this.task.deleteDraft(id);
    return response;
  };

  /**@private */
  onDeleteAnnotation = async (ls, annotation) => {
    const { task } = this;
    let response;

    task.deleteAnnotation(annotation);

    if (annotation.userGenerate && annotation.sentUserGenerate === false) {
      if (annotation.draftId) {
        response = await this.deleteDraft(annotation.draftId);
      } else {
        response = { ok: true };
      }
    } else {
      response = await this.withinLoadingState(async () => {
        return this.datamanager.apiCall("deleteAnnotation", {
          taskID: task.id,
          annotationID: annotation.pk,
        });
      });

      // this.task.deleteAnnotation(annotation);
      this.datamanager.invoke("deleteAnnotation", ls, annotation);
    }

    if (response.ok) {
      const lastAnnotation = this.annotations[this.annotations.length - 1] ?? {};
      const annotationID = lastAnnotation.pk ?? undefined;

      await this.setAnnotation(annotationID);
    }
  };

  draftToast = (status, result = null) => {
    this.showOperationToast(status, "Draft saved successfully", "Draft is not saved", result);
  };

  needsDraftSave = (annotation) => {
    if (annotation.history?.hasChanges && !annotation.draftSaved) return true;
    if (
      annotation.history?.hasChanges &&
      new Date(annotation.history.lastAdditionTime) > new Date(annotation.draftSaved)
    )
      return true;
    return false;
  };

  saveDraft = async (target = null) => {
    const selected = target || this.lsf?.annotationStore?.selected;

    if (this.isManagedRefinementProject) {
      const result = await this._saveManagedDraft(selected);

      if (result?.response) this.draftToast(result.status, result.response);
      return result?.response;
    }

    const hasChanges = selected ? this.needsDraftSave(selected) : false;

    if (selected?.isDraftSaving) {
      await when(() => !selected.isDraftSaving);
      this.draftToast(200);
    } else if (hasChanges && selected) {
      const res = await selected?.saveDraftImmediatelyWithResults();

      this.draftToast(res.$meta?.status, res);
    }
  };

  onSubmitDraft = async (_studio, annotation, params = {}) => {
    if (this.isManagedRefinementProject) {
      const showToast = params?.useToast === true;
      const force = Object.keys(params ?? {}).some((key) => key !== "useToast");
      const result = await this._saveManagedDraft(annotation, { force, params });

      if (showToast && result?.response) this.draftToast(result.status, result.response);
      return result?.response;
    }

    // It should be preserved as soon as possible because each `await` will allow it to be changed
    const taskId = this.task.id;
    const annotationDoesntExist = !annotation.pk;
    const data = { body: this.prepareData(annotation, { isNewDraft: true }) }; // serializedAnnotation
    const hasChanges = this.needsDraftSave(annotation);
    const showToast = params?.useToast && hasChanges;
    // console.log('onSubmitDraft', params?.useToast, hasChanges);

    if (params?.useToast) delete params.useToast;

    Object.assign(data.body, params);

    await this.saveUserLabels();

    if (annotation.draftId > 0) {
      // draft has been already created
      const res = await this.datamanager.apiCall("updateDraft", { draftID: annotation.draftId }, data);

      showToast && this.draftToast(res.$meta?.status, res);
      this.datamanager.invoke("submitDraft", this, annotation, res);
      return res;
    }
    let response;

    if (annotationDoesntExist) {
      response = await this.datamanager.apiCall("createDraftForTask", { taskID: taskId }, data);
    } else {
      response = await this.datamanager.apiCall(
        "createDraftForAnnotation",
        { taskID: taskId, annotationID: annotation.pk },
        data,
      );
    }
    response?.id && annotation.setDraftId(response?.id);
    showToast && this.draftToast(response.$meta?.status, response);
    this.datamanager.invoke("submitDraft", this, annotation, response);

    return response;
  };

  onSkipTask = async (_, { comment } = {}) => {
    // Prevent skipping if overlap is reached (only when feature flag is enabled)
    if (isFF(FF_FIT_1304_STRICT_OVERLAP) && this.overlapReached) {
      this.showOverlapReachedMessage();
      return;
    }

    // Manager roles that can force-skip unskippable tasks (OW=Owner, AD=Admin, MA=Manager)
    const MANAGER_ROLES = ["OW", "AD", "MA"];
    const task = this.task;
    const isEnterprise = window.APP_SETTINGS?.billing?.enterprise;
    const skipDisabled = isEnterprise ? task?.allow_skip === false : false;
    const userRole = window.APP_SETTINGS?.user?.role;
    const hasForceSkipPermission = MANAGER_ROLES.includes(userRole);
    const canSkip = !skipDisabled || hasForceSkipPermission;
    if (!canSkip) {
      console.warn("Task cannot be skipped: allow_skip is false and user lacks manager role");
      this.showOperationToast(400, null, "This task cannot be skipped", {
        error: "Task cannot be skipped",
      });
      return;
    }
    const result = await this.submitCurrentAnnotation(
      "skipTask",
      async (taskID, body) => {
        const { id, ...annotation } = body;
        const params = { taskID };
        const options = { body: { ...annotation, was_cancelled: true } };

        if (comment) options.body.comment = comment;

        if (id !== undefined) params.annotationID = id;

        return await this.datamanager.apiCall(
          id === undefined ? "submitAnnotation" : "updateAnnotation",
          params,
          options,
          { errorHandler: errorHandlerAllowSpecialErrors },
        );
      },
      true,
      this.shouldLoadNext(),
    );
    const status = result?.$meta?.status;

    this.showOperationToast(status, "Task skipped successfully", "Task is not skipped", result);
  };

  onUnskipTask = async () => {
    const { task, currentAnnotation } = this;

    if (!isDefined(currentAnnotation) && !isDefined(currentAnnotation.pk)) {
      console.error("Annotation must be on unskip");
      return;
    }

    await this.withinLoadingState(async () => {
      currentAnnotation.pauseAutosave();

      if (isFF(FF_DEV_3034)) {
        await this.datamanager.apiCall("convertToDraft", {
          annotationID: currentAnnotation.pk,
        });
      } else {
        if (currentAnnotation.draftId > 0) {
          await this.datamanager.apiCall(
            "updateDraft",
            {
              draftID: currentAnnotation.draftId,
            },
            {
              body: { annotation: null },
            },
          );
        } else {
          const annotationData = { body: this.prepareData(currentAnnotation) };

          await this.datamanager.apiCall(
            "createDraftForTask",
            {
              taskID: this.task.id,
            },
            annotationData,
          );
        }

        // Carry over any comments to when the annotation draft is eventually submitted
        if (isFF(FF_DEV_2887) && this.lsf?.commentStore?.toCache) {
          this.lsf.commentStore.toCache(`task.${task.id}`);
        }

        await this.datamanager.apiCall("deleteAnnotation", {
          taskID: task.id,
          annotationID: currentAnnotation.pk,
        });
      }
    });
    await this.loadTask(task.id);
    this.datamanager.invoke("unskipTask");
  };

  shouldLoadNext = () => {
    if (!this.labelStream) return false;

    // validating if URL is from notification, in case of notification it shouldn't load next task
    const urlParam = new URLSearchParams(location.search).get("interaction");

    return urlParam !== "notifications";
  };

  shouldExitStream = () => {
    const paramName = "exitStream";
    const urlParam = new URLSearchParams(location.search).get(paramName);
    const searchParams = new URLSearchParams(window.location.search);

    searchParams.delete(paramName);
    let newRelativePathQuery = window.location.pathname;

    if (searchParams.toString()) newRelativePathQuery += `?${searchParams.toString()}`;
    window.history.pushState(null, "", newRelativePathQuery);
    return !!urlParam;
  };

  // Proxy events that are unused by DM integration
  onEntityCreate = (...args) => {
    const result = this.datamanager.invoke("onEntityCreate", ...args);

    this._publishManagedStatus();
    return result;
  };
  onEntityDelete = (...args) => {
    const result = this.datamanager.invoke("onEntityDelete", ...args);

    this._publishManagedStatus();
    return result;
  };
  _selectAnnotationTimeout = null;
  _debouncedFirstOldSelection = undefined;
  onSelectAnnotation = (prevAnnotation, nextAnnotation, options) => {
    this._claimManagedDraftSaveOwner(prevAnnotation);
    this._claimManagedDraftSaveOwner(nextAnnotation);
    if (this._managedSelectionReplay) return;

    // NOTE on parameter naming: LSF fires selectAnnotation(newAnnotation, oldAnnotation).
    // Despite the names here, prevAnnotation = the NEWLY selected annotation,
    // nextAnnotation = the PREVIOUSLY selected annotation (before this selection).
    if (window.APP_SETTINGS.read_only_quick_view_enabled && !this.labelStream) {
      prevAnnotation?.setEditable(false);
    }

    // FIT-720: Debounce selectAnnotation callbacks during batch selection (init)
    // During init, selectAnnotation fires for ALL annotations in rapid succession.
    // This debounce ensures only the final selection triggers the callback.
    if (isFF(FF_FIT_720_LAZY_LOAD_ANNOTATIONS)) {
      if (this._selectAnnotationTimeout) {
        clearTimeout(this._selectAnnotationTimeout);
        // Keep nextAnnotation (the "old" selection) from the FIRST call in the batch.
        // After resetAnnotationStore + initializeStore, the first selectAnnotation fires
        // with oldSelection=null (nothing was selected before). Subsequent calls during
        // init have oldSelection=someOtherInitAnnotation. The DataManager's history
        // handler compares new vs old annotation pk to decide whether to refetch.
        // If we use the last call's old selection (which may equal the new selection
        // when re-selecting the same annotation), the handler thinks nothing changed
        // and skips the history fetch. Preserving the first old=null ensures the
        // handler sees a genuine annotation change and fetches history.
      } else {
        this._debouncedFirstOldSelection = nextAnnotation;
      }
      this._selectAnnotationTimeout = setTimeout(() => {
        this._selectAnnotationTimeout = null;
        const firstOld = this._debouncedFirstOldSelection;
        this._debouncedFirstOldSelection = undefined;
        // prevAnnotation from last call = the final newly selected annotation (correct)
        // firstOld = the selection state before the batch started (null after reset)
        this._invokeSelectAnnotation(prevAnnotation, firstOld, options);
      }, 0);
      return;
    }

    this._invokeSelectAnnotation(prevAnnotation, nextAnnotation, options);
  };

  _invokeSelectAnnotation = async (prevAnnotation, nextAnnotation, options) => {
    if (this.isManagedRefinementProject) {
      this._bindManagedAnnotationTask(prevAnnotation);
      this._bindManagedAnnotationTask(nextAnnotation);
    }

    if (this.isManagedRefinementProject && prevAnnotation && nextAnnotation && prevAnnotation !== nextAnnotation) {
      const annotationStore = this.lsf?.annotationStore;
      const sourceAnnotationIdentity = this._managedAnnotationIdentity(nextAnnotation);

      this._managedSelectionReplay = true;
      try {
        annotationStore?.selectAnnotation(nextAnnotation.id);
      } finally {
        this._managedSelectionReplay = false;
      }

      return this.coordinateManagedNavigation(
        async () => {
          this._managedSelectionReplay = true;
          try {
            annotationStore?.selectAnnotation(prevAnnotation.id);
          } finally {
            this._managedSelectionReplay = false;
          }

          prevAnnotation.pauseAutosave?.();
          this._initializeManagedDraftBaseline(prevAnnotation);
          return this._invokeSelectAnnotationUncoordinated(prevAnnotation, nextAnnotation, options);
        },
        {
          coalesceKey: sourceAnnotationIdentity ? `annotation-tab-source:${sourceAnnotationIdentity}` : undefined,
          intentKey: `annotation-tab:${this._managedAnnotationIdentity(prevAnnotation)}`,
          reason: "annotation-tab",
          sourceAnnotation: nextAnnotation,
        },
      );
    }

    if (this.isManagedRefinementProject) {
      prevAnnotation?.pauseAutosave?.();
      this._initializeManagedDraftBaseline(prevAnnotation);
    }

    return this._invokeSelectAnnotationUncoordinated(prevAnnotation, nextAnnotation, options);
  };

  _invokeSelectAnnotationUncoordinated = async (prevAnnotation, nextAnnotation, options) => {
    // Invoke the DataManager callback first so that history fetch can start immediately.
    // The history endpoint only needs the annotation pk (available on stubs).
    // Hydration (which fetches full annotation data) runs in parallel afterwards.
    if (!this.isManagedRefinementProject && nextAnnotation?.history?.undoIdx) {
      this.saveDraft(nextAnnotation).then(() => {
        this.datamanager.invoke("onSelectAnnotation", prevAnnotation, nextAnnotation, options, this);
      });
    } else {
      this.datamanager.invoke("onSelectAnnotation", prevAnnotation, nextAnnotation, options, this);
    }

    // FIT-720: Hydrate stub annotations when selected
    // IMPORTANT: Use the CURRENTLY SELECTED annotation, not the one from the callback
    // The debounce may have caused the callback annotation to be stale
    if (isFF(FF_FIT_720_LAZY_LOAD_ANNOTATIONS)) {
      const currentSelected = this.lsf?.annotationStore?.selected;
      if (currentSelected?.pk) {
        // Prefetch comments on annotation selection so region comment indicators
        // are visible immediately, without waiting for the Comments tab to be opened.
        // Deduplication in CommentStore.listComments prevents redundant API calls
        // if the Comments tab is already open and triggers its own fetch.
        this.lsf?.commentStore?.listComments({ suppressClearComments: false });

        await this._hydrateStubAnnotation(currentSelected);
      }
    }
  };

  // FIT-720: Hydrate a stub annotation by fetching full data from API.
  // Managed saves are fenced on the identity-scoped generation registered by
  // this method, so an empty lazy stub can never win a race against its full
  // authoritative result.
  _hydrateStubAnnotation = (annotation) => {
    if (!annotation) return Promise.resolve(null);

    const annotationPk = annotation.pk;
    let managedIdentity = null;
    let managedRecord = null;
    let priorManagedGeneration = 0;

    if (this.isManagedRefinementProject) {
      this._bindManagedAnnotationTask(annotation);
      managedIdentity = this._managedAnnotationIdentity(annotation);
      priorManagedGeneration = this._managedAnnotationHydrations.get(managedIdentity)?.generation ?? 0;
      this._pruneManagedAnnotationHydrations(annotation);
      const current = managedIdentity ? this._managedAnnotationHydrations.get(managedIdentity) : null;

      if (current?.annotation === annotation && ["pending", "ready", "failed"].includes(current.status)) {
        return current.promise;
      }
    }

    const hasRegions = annotation.areas?.size > 0;
    const isUserGenerated = annotation.userGenerate && !annotation.sentUserGenerate;
    const versionsResult = annotation.versions?.result;
    const hasVersionsResult = Array.isArray(versionsResult) && versionsResult.length > 0;
    const localUserEdit = managedIdentity && annotation.history?.hasChanges;

    if (hasRegions || hasVersionsResult || isUserGenerated || localUserEdit) {
      if (!managedIdentity) return Promise.resolve(null);

      const previous = this._managedAnnotationHydrations.get(managedIdentity);
      const ready = {
        annotation,
        error: null,
        generation: Math.max(previous?.generation ?? 0, priorManagedGeneration) + 1,
        promise: Promise.resolve(null),
        status: "ready",
      };

      this._managedAnnotationHydrations.set(managedIdentity, ready);
      return ready.promise;
    }

    const hydrate = async () => {
      const fullAnnotation = await this.datamanager.apiCall("fetchAnnotation", {
        annotationID: annotationPk,
      });

      if (managedIdentity && this._managedAnnotationHydrations.get(managedIdentity) !== managedRecord) {
        return { status: "superseded", value: fullAnnotation };
      }

      if (fullAnnotation?.error || !Array.isArray(fullAnnotation?.result)) {
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_INCOMPLETE",
          "The authoritative annotation remained unavailable. No Draft was saved.",
        );
      }

      // Re-fetch after the async boundary. The original MST reference may have
      // been detached or replaced while the request was in flight.
      const freshAnnotation = this.annotations.find((candidate) => String(candidate.pk) === String(annotationPk));

      if (!freshAnnotation || !isAlive(freshAnnotation) || !isAlive(freshAnnotation.trackedState)) {
        if (!managedIdentity) return { status: "ready", value: fullAnnotation };
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_TARGET_CHANGED",
          "The annotation changed while its authoritative result was loading. No Draft was saved.",
        );
      }
      if (managedIdentity && this._managedAnnotationIdentity(freshAnnotation) !== managedIdentity) {
        throw this._managedDraftError(
          "ANNOTATION_HYDRATION_TARGET_CHANGED",
          "The annotation changed while its authoritative result was loading. No Draft was saved.",
        );
      }

      const freshVersionsResult = freshAnnotation.versions?.result;
      const freshHasVersionsResult = Array.isArray(freshVersionsResult) && freshVersionsResult.length > 0;
      const freshHasRegions = freshAnnotation.areas?.size > 0;

      // A user edit or another hydration path wins without being overwritten.
      // The pending save will resume and persist that current user payload.
      if (freshAnnotation.history?.hasChanges) return { status: "ready", value: fullAnnotation };
      if (freshHasVersionsResult || freshHasRegions) return { status: "ready", value: fullAnnotation };

      const history = freshAnnotation.history;
      const freezeKey = Symbol("coordexp-managed-annotation-hydration");
      let hydrated = false;
      let hydrationError = null;
      let releaseError = null;

      history?.freeze?.(freezeKey);
      try {
        if (!isAlive(freshAnnotation) || !isAlive(freshAnnotation.trackedState)) {
          throw this._managedDraftError(
            "ANNOTATION_HYDRATION_TARGET_CHANGED",
            "The annotation changed while its authoritative result was loading. No Draft was saved.",
          );
        }
        freshAnnotation.deserializeResults(fullAnnotation.result);
        freshAnnotation.updateObjects?.();
        hydrated = true;
      } catch (error) {
        hydrationError = error;
      } finally {
        try {
          if (hydrated) {
            history?.safeUnfreeze?.(freezeKey);
          } else {
            const aborted = history?.abortFreeze?.(freezeKey, true) === true;

            if (!aborted) history?.safeUnfreeze?.(freezeKey);
          }
        } catch (error) {
          history?.abortFreeze?.(freezeKey, true);
          releaseError = error;
        }
      }

      if (hydrationError) throw hydrationError;
      if (releaseError) throw releaseError;

      // Reset history only after deserialize/render both completed and the
      // hydration freeze was released. A thrown step never advances baseline.
      freshAnnotation.reinitHistory?.();

      if (
        managedIdentity &&
        isAlive(freshAnnotation) &&
        isAlive(freshAnnotation.trackedState) &&
        this._managedAnnotationIdentity(freshAnnotation) === managedIdentity &&
        !freshAnnotation.history?.hasChanges
      ) {
        this._finalizeManagedDraftBaselineAfterLoad(freshAnnotation);
      }

      return { status: "ready", value: fullAnnotation };
    };

    if (!managedIdentity) {
      return hydrate()
        .then((result) => result.value)
        .catch(() => null);
    }

    const previous = this._managedAnnotationHydrations.get(managedIdentity);
    const record = {
      annotation,
      error: null,
      generation: Math.max(previous?.generation ?? 0, priorManagedGeneration) + 1,
      promise: null,
      status: "pending",
    };
    managedRecord = record;
    const operation = hydrate()
      .then((result) => {
        if (this._managedAnnotationHydrations.get(managedIdentity) === record) record.status = result.status;
        return result.value;
      })
      .catch((error) => {
        if (this._managedAnnotationHydrations.get(managedIdentity) === record) {
          record.error =
            error instanceof CoordExpDraftSaveError
              ? error
              : this._managedDraftError(
                  "ANNOTATION_HYDRATION_FAILED",
                  "The authoritative annotation could not be loaded. No Draft was saved.",
                );
          record.status = "failed";
        }
        return null;
      })
      .finally(() => {
        this._pruneManagedAnnotationHydrations();
      });

    record.promise = operation;
    this._managedAnnotationHydrations.set(managedIdentity, record);
    return operation;
  };

  onNextTask = async (nextTaskId, nextAnnotationId) => {
    if (!this.isManagedRefinementProject) {
      await this.saveDraft();
      await this._loadTaskUncoordinated(nextTaskId, nextAnnotationId, true);
      return;
    }

    return this.coordinateManagedNavigation(() => this._loadTaskUncoordinated(nextTaskId, nextAnnotationId, true), {
      intentKey: `next:${nextTaskId ?? "next"}:annotation:${nextAnnotationId ?? "auto"}`,
      reason: "next-task",
    });
  };
  onPrevTask = async (prevTaskId, prevAnnotationId) => {
    if (!this.isManagedRefinementProject) {
      await this.saveDraft();
      await this._loadTaskUncoordinated(prevTaskId, prevAnnotationId, true);
      return;
    }

    return this.coordinateManagedNavigation(() => this._loadTaskUncoordinated(prevTaskId, prevAnnotationId, true), {
      intentKey: `previous:${prevTaskId ?? "previous"}:annotation:${prevAnnotationId ?? "auto"}`,
      reason: "previous-task",
    });
  };
  async submitCurrentAnnotation(eventName, submit, includeId = false, loadNext = true) {
    const { taskID, currentAnnotation } = this;
    const unique_id = this.task.unique_lock_id;
    const serializedAnnotation = this.prepareData(currentAnnotation, { includeId });

    if (unique_id) {
      serializedAnnotation.unique_id = unique_id;
    }

    this.setLoading(true);

    await this.saveUserLabels();

    const result = await this.withinLoadingState(async () => {
      const result = await submit(taskID, serializedAnnotation);

      return result;
    });

    if (result && result.id !== undefined) {
      const annotationId = result.id.toString();

      currentAnnotation.updatePersonalKey(annotationId);

      const eventData = annotationToServer(currentAnnotation);

      this.datamanager.invoke(eventName, this.lsf, eventData, result);

      // Persist any queued comments which are not currently attached to an annotation
      if (
        isFF(FF_DEV_2887) &&
        ["submitAnnotation", "skipTask"].includes(eventName) &&
        this.lsf?.commentStore?.persistQueuedComments
      ) {
        await this.lsf.commentStore.persistQueuedComments();
      }
    }

    this.setLoading(false);
    if (result?.$meta?.status >= 400) {
      // don't reload the task on error to avoid losing the user's changes
      return result;
    }

    if (!loadNext || this.datamanager.isExplorer) {
      await this.loadTask(taskID, currentAnnotation.pk, true);
    } else {
      await this.loadTask();
    }

    return result;
  }

  /**
   * Finds the active draft for the given annotation.
   * @param {Object} annotation - The annotation object.
   * @returns {Object|undefined} The active draft or undefined if no draft is found.
   * @private
   */
  findActiveDraft(annotation) {
    if (isDefined(annotation.draftId)) {
      return this.task.drafts.find((possibleDraft) => possibleDraft.id === annotation.draftId);
    }
    return undefined;
  }

  /**
   * Calculates the startedAt time for an annotation.
   * @param {Object|undefined} currentDraft - The current draft object, if any.
   * @param {Date} loadedDate - The date when the annotation was loaded.
   * @returns {Date} The calculated startedAt time.
   * @private
   */
  calculateStartedAt(currentDraft, loadedDate) {
    if (currentDraft) {
      const draftStartedAt = new Date(currentDraft.created_at);
      const draftLeadTime = Number(currentDraft.lead_time ?? 0);
      const adjustedStartedAt = new Date(Date.now() - draftLeadTime * 1000);

      if (adjustedStartedAt < draftStartedAt) return draftStartedAt;

      return adjustedStartedAt;
    }
    return loadedDate;
  }

  /**
   * Prepare data for draft/submission of annotation
   * @param {Object} annotation - The annotation object.
   * @param {Object} options - The options object.
   * @param {boolean} options.includeId - Whether to include the id in the result.
   * @param {boolean} options.isNewDraft - Whether the draft is new.
   * @returns {Object} The prepared data.
   * @private
   */
  prepareData(annotation, { includeId, isNewDraft } = {}) {
    const userGenerate = !annotation.userGenerate || annotation.sentUserGenerate;
    const currentDraft = this.findActiveDraft(annotation);
    const sessionTime = (Date.now() - annotation.loadedDate.getTime()) / 1000;
    const submittedTime = isNewDraft ? 0 : Number(annotation.leadTime ?? 0);
    const draftTime = Number(currentDraft?.lead_time ?? 0);
    const leadTime = submittedTime + draftTime + sessionTime;
    const startedAt = this.calculateStartedAt(currentDraft, annotation.loadedDate);

    const result = {
      lead_time: leadTime,
      result: (isNewDraft ? annotation.versions.draft : annotation.serializeAnnotation()) ?? [],
      draft_id: annotation.draftId,
      parent_prediction: annotation.parent_prediction,
      parent_annotation: annotation.parent_annotation,
      started_at: startedAt.toISOString(),
    };

    if (includeId && userGenerate) {
      result.id = Number.parseInt(annotation.pk);
    }

    return result;
  }

  /** @private */
  setLoading(isLoading, shouldReset = false) {
    if (isFF(FF_LSDV_4620_3_ML) && shouldReset) this.lsf.clearApp();
    this.lsf.setFlags({ isLoading });
    if (isFF(FF_LSDV_4620_3_ML) && shouldReset) this.lsf.renderApp();
  }

  async withinLoadingState(callback) {
    let result;

    this.setLoading(true);
    if (callback) {
      result = await callback.call(this);
    }
    this.setLoading(false);

    return result;
  }

  destroy() {
    this._cancelManagedNavigationCoordinator();
    if (this._selectAnnotationTimeout !== null) {
      clearTimeout(this._selectAnnotationTimeout);
      this._selectAnnotationTimeout = null;
      this._debouncedFirstOldSelection = undefined;
    }
    if (this._managedBeforeUnloadHandler) {
      window.removeEventListener("beforeunload", this._managedBeforeUnloadHandler);
      this._managedBeforeUnloadHandler = null;
    }

    this._managedDraftSaves.clear();
    this._managedDraftBaselines.clear();
    this._managedAnnotationHydrations.clear();
    this._managedLocalPendingDrafts.clear();
    this._managedAuthoritativeState = null;
    this._managedTerminalLifecycleKeys.clear();
    this._managedPersistentError = null;
    this.managedStatusState = null;

    // Clean up overlap error event listeners and dismiss toast (only when feature flag is enabled)
    if (isFF(FF_FIT_1304_STRICT_OVERLAP)) {
      window.removeEventListener("overlap-error-next-task", this.handleOverlapNextTask);
      window.removeEventListener("overlap-error-close-task", this.handleOverlapCloseTask);
      window.removeEventListener("overlap-error-exit-stream", this.handleOverlapExitStream);
      // Dismiss the overlap toast if it's showing - this ensures the toast doesn't
      // persist after leaving the labeling interface
      this.dismissOverlapToast();
    }

    if (isActive(FF_FIT_720_LAZY_LOAD_ANNOTATIONS)) {
      imageCache?.forceClear?.();
    }

    this.lsfInstance?.destroy?.();
    this.lsfInstance = null;
  }

  /**
   * Close the current task panel (for DataManager context)
   */
  closeTask() {
    // Invoke the data manager's close task action
    const close = () => this.datamanager.invoke("closeTask");

    if (!this.isManagedRefinementProject) return close();
    return this.coordinateManagedNavigation(close, { intentKey: "close-task", reason: "close-task" });
  }

  get taskID() {
    return this.task.id;
  }

  get taskHistory() {
    return this.lsf.taskHistory;
  }

  get currentAnnotation() {
    try {
      return this.lsf.annotationStore.selected;
    } catch {
      return null;
    }
  }

  get annotations() {
    return this.lsf.annotationStore.annotations;
  }

  get predictions() {
    return this.lsf.annotationStore.predictions;
  }

  /** @returns {string|null} */
  get lsfConfig() {
    return this.datamanager.store.labelingConfig;
  }

  /** @returns {Dict} */
  get project() {
    return this.datamanager.store.project;
  }

  get isManagedRefinementProject() {
    return (
      typeof this.project?.description === "string" &&
      this.project.description.startsWith(COORDEXP_MANAGED_PROJECT_PREFIX)
    );
  }

  /** @returns {string|null} */
  get instruction() {
    return (this.project.instruction ?? this.project.expert_instruction ?? "").trim() || null;
  }

  get canPreloadTask() {
    return Boolean(this.preload?.interaction);
  }
}
