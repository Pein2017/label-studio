import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";

import { CoordExpRefinementClient, createBatchId } from "../../services/coordexp-refinement-api";
import { resolveOwnedDataManagerProject, useReadyDataManager } from "../../services/data-manager-ready";
import {
  DEFAULT_CANVAS,
  buildVisualPolicy,
  frozenTargetStillCurrent,
  labelStudioResultToDescriptor,
  labelStudioResultToInferenceDescriptor,
  normalizePercentRoi,
  shouldRetireInferencePresentations,
  validateAbandonResponse,
  validateCanvasResolution,
  validateDurableDraftReceipt,
  validateInferenceResponse,
  validateProfilesResponse,
  visualPolicyConflictCount,
} from "./controller";
import "./CoordExpAIRegion.prefix.css";

const errorText = (error) => error?.message || "ROI inference failed. Retry with the same region.";
const defaultClientFactory = (projectId) => new CoordExpRefinementClient(projectId);

export const resolveAIRegionDataManager = (store, candidate = globalThis.window?.dataManager) => {
  if (!resolveOwnedDataManagerProject(store, candidate)) return null;
  if (candidate.lsf.task?.id !== store.task?.id) return null;
  return ["on", "off", "ensureDurableDraft", "setManagedRoiRunning", "getManagedStatusState"].every(
    (method) => typeof candidate[method] === "function",
  )
    ? candidate
    : null;
};

export const isAIRegionMountTarget = (store, annotation, image) => {
  if (!store || !annotation || !image || store.annotationStore?.selected !== annotation) return false;

  let configuredTags;

  try {
    const values = annotation.names?.values?.();

    if (!values || typeof values[Symbol.iterator] !== "function") return false;
    configuredTags = [...values];
  } catch {
    return false;
  }

  try {
    const imageTags = configuredTags.filter((tag) => tag?.type === "image");

    if (imageTags.length !== 1 || imageTags[0] !== image) return false;
    const configuredImage = imageTags[0];

    if (configuredImage.isMultiItem !== false || configuredImage.valuelist !== null) return false;
    if (Array.isArray(configuredImage.parsedValue)) return false;
    if (!Array.isArray(configuredImage.images) || configuredImage.images.length !== 1) return false;
    return true;
  } catch {
    return false;
  }
};

const orderedManagedStatus = (current, next) => {
  if (!next || typeof next !== "object" || Array.isArray(next)) return current;
  if (!current || typeof current !== "object" || Array.isArray(current)) return next;
  const currentGeneration = current.generation;
  const nextGeneration = next.generation;

  if (Number.isInteger(currentGeneration) && Number.isInteger(nextGeneration)) {
    if (nextGeneration < currentGeneration) return current;
    if (nextGeneration === currentGeneration) {
      const currentVersion = current.version;
      const nextVersion = next.version;

      if (Number.isInteger(currentVersion) && Number.isInteger(nextVersion) && nextVersion < currentVersion) {
        return current;
      }
    }
  }
  return next;
};

const currentBrowserSemanticProjectionHash = (dataManager) => {
  const value = dataManager.getManagedStatusState()?.local?.browserSemanticProjectionHash;

  return typeof value === "string" && value.length > 0 ? value : null;
};

const annotationResults = (annotation) => {
  const serialized = annotation?.serialized;

  return Array.isArray(serialized) ? serialized : [];
};

export const selectedPresentationKeys = (image) => [
  ...new Set(
    (image?.selectedRegions ?? [])
      .map((region) => region?.presentationRegionKey ?? region?.id)
      .filter((key) => typeof key === "string" && key.length > 0),
  ),
];

const applyVisualPolicy = (image, policy) => {
  for (const presentation of policy.presentations) {
    image.setInferenceRegionPresentation(presentation.stable_region_key, presentation);
  }
};

export const CoordExpAIRegionMount = ({ store, image, annotation, candidate, clientFactory, requestIdFactory }) => {
  const dataManager = useReadyDataManager(store, candidate, resolveAIRegionDataManager);
  const projectId = dataManager?.lsf?.project?.id;
  const taskId = store?.task?.id;

  if (
    !dataManager ||
    !isAIRegionMountTarget(store, annotation, image) ||
    !Number.isInteger(projectId) ||
    !Number.isInteger(taskId)
  )
    return null;
  return (
    <CoordExpAIRegion
      store={store}
      dataManager={dataManager}
      annotation={annotation}
      image={image}
      projectId={projectId}
      taskId={taskId}
      clientFactory={clientFactory}
      requestIdFactory={requestIdFactory}
    />
  );
};

export const CoordExpAIRegion = observer(
  ({
    store,
    dataManager,
    annotation,
    image,
    projectId,
    taskId,
    clientFactory = defaultClientFactory,
    requestIdFactory = createBatchId,
  }) => {
    const client = useMemo(() => clientFactory(projectId), [clientFactory, projectId]);
    const mounted = useRef(true);
    const activeAttempt = useRef(null);
    const runtimeLock = useRef(false);
    const [profiles, setProfiles] = useState([]);
    const [profileSelector, setProfileSelector] = useState("");
    const [width, setWidth] = useState(String(DEFAULT_CANVAS.width));
    const [height, setHeight] = useState(String(DEFAULT_CANVAS.height));
    const [state, setState] = useState("idle");
    const [message, setMessage] = useState(null);
    const [pendingSave, setPendingSave] = useState(null);
    const [conflictCount, setConflictCount] = useState(0);
    const [managedStatusState, setManagedStatusState] = useState(() => ({
      owner: dataManager,
      value: dataManager.getManagedStatusState(),
    }));
    const managedStatus = managedStatusState.owner === dataManager ? managedStatusState.value : null;
    const selectedProfile = profiles.find((profile) => profile.selector === profileSelector) ?? null;
    const resolution = validateCanvasResolution(selectedProfile, width, height);
    const running = state === "running" || state === "cancelling" || state === "saving";
    const taskKey = store?.task?.dataObj?.coordexp_task_key ?? store?.task?.data?.coordexp_task_key;
    const focusKeys = selectedPresentationKeys(image);
    const retireInferencePresentations = shouldRetireInferencePresentations(managedStatus, { taskId, taskKey });

    useEffect(() => {
      const owner = {};
      let currentOwner = owner;
      const onStatus = (next) => {
        if (currentOwner !== owner) return;
        setManagedStatusState((current) => ({
          owner: dataManager,
          value: orderedManagedStatus(current.owner === dataManager ? current.value : null, next),
        }));
      };

      setManagedStatusState({ owner: dataManager, value: dataManager.getManagedStatusState() });
      dataManager.on("managedStatusChanged", onStatus);
      return () => {
        currentOwner = null;
        dataManager.off("managedStatusChanged", onStatus);
      };
    }, [dataManager]);

    const startRuntimeLock = useCallback(() => {
      if (runtimeLock.current) return;
      runtimeLock.current = true;
      try {
        image.setAIRegionRunning(true);
        dataManager.setManagedRoiRunning(true);
      } catch (error) {
        try {
          if (image.aiRegionRunning) image.finishAIRegion({ clear: false });
        } finally {
          runtimeLock.current = false;
          dataManager.setManagedRoiRunning(false);
        }
        throw error;
      }
    }, [dataManager, image]);

    const finishRuntimeLock = useCallback(
      (clear) => {
        if (!runtimeLock.current) return;
        runtimeLock.current = false;
        let imageError;

        try {
          image.finishAIRegion({ clear });
        } catch (error) {
          imageError = error;
        } finally {
          dataManager.setManagedRoiRunning(false);
        }
        if (imageError) throw imageError;
      },
      [dataManager, image],
    );

    const abandon = useCallback(
      async (attempt, reason) => {
        try {
          const response = await client.abandon({ receiptId: `roi-receipt:${attempt.requestId}`, reason });

          validateAbandonResponse(response.payload ?? response, { requestId: attempt.requestId, reason });
          attempt.abandonConfirmed = true;
          return true;
        } catch {
          // The infer request can still be creating its receipt. Its completion path retries abandonment.
          return false;
        }
      },
      [client],
    );

    useEffect(() => {
      mounted.current = true;
      const controller = new AbortController();

      client
        .profiles(controller.signal)
        .then((payload) => {
          const nextProfiles = validateProfilesResponse(payload);

          if (!mounted.current) return;
          setProfiles(nextProfiles);
          setProfileSelector(nextProfiles[0].selector);
        })
        .catch((error) => {
          if (mounted.current && error?.name !== "AbortError") {
            setState("profile_failure");
            setMessage(errorText(error));
          }
        });
      return () => controller.abort();
    }, [client]);

    useEffect(() => {
      const attempt = activeAttempt.current;
      const annotationId = annotation?.pk ?? annotation?.id;

      if (
        attempt &&
        (String(taskId) !== String(attempt.taskId) || String(annotationId) !== String(attempt.annotationId))
      ) {
        attempt.disposition = "superseded";
      }
    }, [annotation, taskId]);

    useEffect(() => {
      const allDescriptors = annotationResults(annotation).map(labelStudioResultToDescriptor).filter(Boolean);
      const inferenceDescriptors = allDescriptors.filter((descriptor) => descriptor.inferenceOrigin);

      if (inferenceDescriptors.length === 0) {
        setConflictCount(0);
        return;
      }
      if (retireInferencePresentations) {
        image.clearInferenceRegionPresentations(inferenceDescriptors.map((descriptor) => descriptor.stableRegionKey));
        setConflictCount(0);
        return;
      }
      const policy = buildVisualPolicy(inferenceDescriptors, undefined, allDescriptors);

      for (const presentation of policy.presentations) {
        image.setInferenceRegionPresentation(presentation.stable_region_key, presentation);
      }
      setConflictCount(visualPolicyConflictCount(policy));
    }, [annotation, image, retireInferencePresentations, taskId]);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        const attempt = activeAttempt.current;

        if (attempt && !attempt.inserted) {
          attempt.disposition = attempt.disposition ?? "user_discarded";
          attempt.abandonPromise ??= abandon(attempt, attempt.disposition);
        }
        try {
          finishRuntimeLock(false);
        } catch {
          // The image model can already be detached during forced unload.
        }
      };
    }, [abandon, finishRuntimeLock]);

    const persistDraft = useCallback(
      async (savedAttempt, acceptedState) => {
        setState("saving");
        try {
          startRuntimeLock();
          validateDurableDraftReceipt(await dataManager.ensureDurableDraft(), {
            taskId: savedAttempt.taskId,
            annotationId: savedAttempt.annotationId,
          });

          finishRuntimeLock(true);
          setPendingSave(null);
          setState(acceptedState);
          setMessage(
            acceptedState === "accepted_with_drops"
              ? `Inserted ${savedAttempt.counts.produced}; ${savedAttempt.counts.rejected} dropped.`
              : `Inserted ${savedAttempt.counts.produced}.`,
          );
        } catch (error) {
          finishRuntimeLock(false);
          setPendingSave({ ...savedAttempt, acceptedState });
          setState("save_failure");
          setMessage(`Boxes were inserted, but Draft save failed: ${errorText(error)}`);
        }
      },
      [dataManager, finishRuntimeLock, startRuntimeLock],
    );

    const infer = async () => {
      if (running || pendingSave || !image.aiRegion || !resolution.valid || !selectedProfile || !taskKey) return;
      const requestId = requestIdFactory();
      const annotationId = annotation.pk ?? annotation.id;
      const attempt = {
        requestId,
        projectId,
        taskId,
        taskKey,
        annotationId,
        profileSelector: selectedProfile.selector,
        disposition: null,
        inserted: false,
        inferSubmitted: false,
        abandonConfirmed: false,
        abandonPromise: null,
      };
      let frozen;
      const confirmDisposition = async (reason) => {
        let confirmed = attempt.abandonConfirmed;

        if (!confirmed && attempt.abandonPromise) confirmed = await attempt.abandonPromise;
        if (!confirmed) confirmed = await abandon(attempt, reason);
        return confirmed;
      };
      const targetMismatch = (message) => {
        const error = new Error(message);

        error.code = "target_mismatch";
        return error;
      };

      activeAttempt.current = attempt;
      setState("running");
      setMessage("Saving the frozen Draft target…");
      try {
        startRuntimeLock();
        const draftReceipt = validateDurableDraftReceipt(await dataManager.ensureDurableDraft(), {
          taskId,
          annotationId,
        });
        const browserSemanticProjectionHash = currentBrowserSemanticProjectionHash(dataManager);

        if (
          browserSemanticProjectionHash !== draftReceipt.browser_semantic_projection_hash ||
          String(annotation.draftId) !== String(draftReceipt.draft_id) ||
          annotation.draftSaved !== draftReceipt.revision
        ) {
          throw targetMismatch("The durable Draft epoch changed before ROI inference could start.");
        }
        frozen = Object.freeze({
          requestId,
          projectId,
          taskId,
          taskKey,
          annotationId: draftReceipt.annotation_id,
          draftId: draftReceipt.draft_id,
          draftRevision: draftReceipt.revision,
          browserSemanticProjectionHash,
          profileSelector: selectedProfile.selector,
        });
        Object.assign(attempt, frozen);

        if (attempt.disposition || !mounted.current) {
          const confirmed = attempt.abandonPromise ? await attempt.abandonPromise : false;

          finishRuntimeLock(false);
          if (mounted.current) {
            setState(confirmed ? "abandoned" : "cancelled");
            setMessage(
              confirmed
                ? "ROI request was abandoned before insertion."
                : "ROI inference was cancelled before request submission.",
            );
          }
          return;
        }

        // The service contract owns the sole percent-to-natural-pixel conversion.
        const roi = normalizePercentRoi(image.aiRegion);
        setMessage("Running ROI inference…");
        attempt.inferSubmitted = true;
        const response = await client.infer({
          requestId,
          taskId,
          roi,
          resolution: resolution.value,
          profileSelector: selectedProfile.selector,
        });
        const plan = validateInferenceResponse(response.payload ?? response, frozen);

        if (!mounted.current || attempt.disposition) {
          const reason = attempt.disposition ?? "user_discarded";
          const confirmed = await confirmDisposition(reason);

          if (mounted.current) {
            setState(confirmed ? "abandoned" : "response_failure");
            setMessage(
              confirmed
                ? "ROI response was abandoned before insertion."
                : "No boxes were inserted, but response abandonment could not be confirmed.",
            );
          }
          finishRuntimeLock(false);
          return;
        }
        if (
          !frozenTargetStillCurrent(frozen, {
            projectId,
            store,
            annotation,
            selectedProfile,
            browserSemanticProjectionHash: currentBrowserSemanticProjectionHash(dataManager),
          })
        ) {
          const confirmed = await abandon(attempt, "superseded");

          finishRuntimeLock(false);
          setState(confirmed ? "abandoned" : "response_failure");
          setMessage(
            confirmed
              ? "The task or annotation changed; the detached response was abandoned."
              : "No boxes were inserted, but detached-response abandonment could not be confirmed.",
          );
          return;
        }
        if (plan.kind === "produced") {
          const newDescriptors = plan.results.map(labelStudioResultToInferenceDescriptor).filter(Boolean);
          const existingAllDescriptors = annotationResults(annotation)
            .map(labelStudioResultToDescriptor)
            .filter(Boolean);
          const existingInferenceDescriptors = existingAllDescriptors.filter(
            (descriptor) => descriptor.inferenceOrigin,
          );
          const byKey = new Map(
            [...existingInferenceDescriptors, ...newDescriptors].map((item) => [item.stableRegionKey, item]),
          );
          const comparisonByKey = new Map(
            [...existingAllDescriptors, ...newDescriptors].map((item) => [item.stableRegionKey, item]),
          );
          const policy = buildVisualPolicy([...byKey.values()], undefined, [...comparisonByKey.values()]);
          if (
            !frozenTargetStillCurrent(frozen, {
              projectId,
              store,
              annotation,
              selectedProfile,
              browserSemanticProjectionHash: currentBrowserSemanticProjectionHash(dataManager),
            })
          ) {
            const confirmed = await abandon(attempt, "superseded");

            finishRuntimeLock(false);
            setState(confirmed ? "abandoned" : "response_failure");
            setMessage(
              confirmed
                ? "The Draft changed before insertion; the response was abandoned."
                : "No boxes were inserted, but changed-Draft abandonment could not be confirmed.",
            );
            return;
          }
          const appended = annotation.appendResultsAtomically(plan.results);

          attempt.inserted = true;
          applyVisualPolicy(image, policy);
          const insertedKeys = appended.map((region) => region.presentationRegionKey ?? region.cleanId ?? region.id);

          image.focusInferenceGroup(insertedKeys);
          const conflicts = visualPolicyConflictCount(policy);
          const savedAttempt = {
            requestId,
            receiptId: plan.receiptId,
            counts: plan.counts,
            conflicts,
            taskId,
            annotationId: frozen.annotationId,
          };

          setConflictCount(conflicts);
          await persistDraft(savedAttempt, plan.status);
          return;
        }
        finishRuntimeLock(plan.clearRoi);
        setState(plan.status);
        if (plan.kind === "empty") setMessage("No objects found in this ROI.");
        else if (plan.kind === "all_rejected") setMessage(`All ${plan.counts.rejected} results were rejected.`);
        else setMessage(`ROI inference failed (${plan.status}). Retry with the same region.`);
      } catch (error) {
        if (error?.code === "target_mismatch" && !attempt.inserted && attempt.inferSubmitted) {
          const confirmed = await confirmDisposition("superseded");

          if (mounted.current) {
            setState(confirmed ? "abandoned" : "response_failure");
            setMessage(
              confirmed
                ? "The mismatched response was abandoned before insertion."
                : "No boxes were inserted, but response abandonment could not be confirmed. Retry or reload safely.",
            );
          }
        } else if (attempt.disposition && !attempt.inserted && attempt.inferSubmitted) {
          const confirmed = await confirmDisposition(attempt.disposition);

          if (mounted.current) {
            setState(confirmed ? "abandoned" : "response_failure");
            setMessage(
              confirmed
                ? "ROI response was abandoned before insertion."
                : "No boxes were inserted, but response abandonment could not be confirmed.",
            );
          }
        } else if (mounted.current) {
          setState(error?.code === "target_mismatch" ? "response_failure" : "transport_failure");
          setMessage(errorText(error));
        }
      } finally {
        if (activeAttempt.current === attempt) activeAttempt.current = null;
        try {
          finishRuntimeLock(false);
        } catch {
          // The model can be detached during forced unload.
        }
      }
    };

    const cancel = () => {
      const attempt = activeAttempt.current;

      if (!attempt || attempt.inserted) return;
      attempt.disposition = "user_cancelled";
      attempt.abandonPromise ??= abandon(attempt, attempt.disposition);
      setState("cancelling");
      setMessage("Cancellation requested; awaiting an exact abandoned-before-insertion receipt…");
    };

    const toggleDrawing = () => {
      if (running || pendingSave) return;
      image.setAIRegionDrawEnabled(!image.aiRegionDrawEnabled);
      setMessage(image.aiRegionDrawEnabled ? "Drag on the image to draw or replace the ROI." : null);
    };

    const setDenseFocus = (mode) => {
      if (mode === "show_all") image.restoreRegionPresentation();
      else image.setRegionPresentation(mode, focusKeys);
    };

    return (
      <section className="coordexp-ai-region" aria-label="AI Region inference">
        <div className="coordexp-ai-region__row">
          <strong>AI Region</strong>
          <button type="button" disabled={running || !!pendingSave} onClick={toggleDrawing}>
            {image.aiRegionDrawEnabled ? "Drawing ROI" : "Draw ROI"}
          </button>
          {image.aiRegion && (
            <span className="coordexp-ai-region__roi">
              {image.aiRegion.width.toFixed(1)}% × {image.aiRegion.height.toFixed(1)}%
            </span>
          )}
        </div>
        <div className="coordexp-ai-region__row">
          <label>
            Profile
            <select
              aria-label="Inference profile"
              value={profileSelector}
              disabled={running || !!pendingSave}
              onChange={(event) => setProfileSelector(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.selector} value={profile.selector}>
                  {profile.display_label}
                </option>
              ))}
            </select>
          </label>
          <label>
            W
            <input
              aria-label="Canvas width"
              type="number"
              min="1"
              step="1"
              value={width}
              disabled={running || !!pendingSave}
              onChange={(event) => setWidth(event.target.value)}
            />
          </label>
          <label>
            H
            <input
              aria-label="Canvas height"
              type="number"
              min="1"
              step="1"
              value={height}
              disabled={running || !!pendingSave}
              onChange={(event) => setHeight(event.target.value)}
            />
          </label>
          {pendingSave ? (
            <button type="button" onClick={() => persistDraft(pendingSave, pendingSave.acceptedState)}>
              Retry Draft save
            </button>
          ) : running ? (
            <button type="button" disabled={state === "saving" || state === "cancelling"} onClick={cancel}>
              {state === "saving" ? "Saving…" : state === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <button type="button" disabled={!image.aiRegion || !resolution.valid || !selectedProfile} onClick={infer}>
              Infer
            </button>
          )}
        </div>
        <div className="coordexp-ai-region__row" aria-label="Dense Focus">
          <span>Dense Focus</span>
          <button
            type="button"
            aria-pressed={image.regionPresentationMode === "show_all"}
            onClick={() => setDenseFocus("show_all")}
          >
            Show all
          </button>
          <button
            type="button"
            disabled={focusKeys.length === 0}
            aria-pressed={image.regionPresentationMode === "dim_non_selected"}
            onClick={() => setDenseFocus("dim_non_selected")}
          >
            Dim non-selected
          </button>
          <button
            type="button"
            disabled={focusKeys.length === 0}
            aria-pressed={image.regionPresentationMode === "hide_non_selected"}
            onClick={() => setDenseFocus("hide_non_selected")}
          >
            Hide non-selected
          </button>
        </div>
        {!resolution.valid && selectedProfile && <div className="coordexp-ai-region__error">{resolution.error}</div>}
        {message && (
          <div className={`coordexp-ai-region__message coordexp-ai-region__message--${state}`} role="status">
            {message}
            {conflictCount > 0 && ` Potential duplicate pairs: ${conflictCount}.`}
          </div>
        )}
      </section>
    );
  },
);
