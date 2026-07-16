import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CoordExpRefinementClient, createBatchId } from "../../services/coordexp-refinement-api";
import "./CoordExpManagedPanel.prefix.css";

const ACTIVE_BATCH_STATES = new Set(["queued", "running", "reconciling"]);
const TERMINAL_BATCH_STATES = new Set(["succeeded", "failed"]);
const KNOWN_BATCH_STATES = new Set([...ACTIVE_BATCH_STATES, ...TERMINAL_BATCH_STATES, "not_found"]);
const BATCH_LABELS = Object.freeze({
  queued: "Queued",
  running: "Running",
  reconciling: "Reconciling",
  succeeded: "Succeeded",
  failed: "Failed",
  not_found: "Unknown",
});

const normalizedBatchState = (value) => (typeof value === "string" ? value.toLowerCase() : null);
const batchLabel = (value) => BATCH_LABELS[normalizedBatchState(value)] ?? "None";
const defaultClientFactory = (projectId) => new CoordExpRefinementClient(projectId);
const BATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const errorMessage = (error) => {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return "The refinement operation failed.";
};

const normalizeBatch = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = normalizedBatchState(value.state ?? value.status ?? value.batch_state ?? value.batchState);

  if (!KNOWN_BATCH_STATES.has(state)) return null;
  const batchId = value.batch_id ?? value.batchId ?? null;
  const memberCount = value.member_count ?? value.memberCount ?? null;
  const generation = value.generation ?? value.base_generation ?? value.baseGeneration ?? null;

  return {
    batchId: BATCH_ID_PATTERN.test(batchId ?? "") ? batchId : null,
    state,
    memberCount: Number.isInteger(memberCount) && memberCount >= 0 ? memberCount : null,
    generation: Number.isInteger(generation) && generation >= 0 ? generation : null,
    error: value.error ?? null,
  };
};

const authorityActiveBatch = (status) => {
  const authority = status?.authority;
  const block = normalizeBatch(authority?.active_batch ?? authority?.activeBatch);

  if (block && ACTIVE_BATCH_STATES.has(block.state)) return block;
  const state = normalizedBatchState(status?.batchState ?? authority?.batch_state ?? authority?.batchState);
  const batchId = status?.activeBatchId ?? authority?.active_batch_id ?? authority?.activeBatchId;

  return ACTIVE_BATCH_STATES.has(state)
    ? normalizeBatch({
        batch_id: batchId,
        status: state,
        member_count: authority?.active_batch_member_count ?? authority?.activeBatchMemberCount,
        generation: authority?.active_batch_generation ?? authority?.activeBatchGeneration,
      })
    : null;
};

const authorityLastTerminalBatch = (status) => {
  const authority = status?.authority;
  const block = normalizeBatch(authority?.last_terminal_batch ?? authority?.lastTerminalBatch);

  if (block && TERMINAL_BATCH_STATES.has(block.state)) return block;
  const state = normalizedBatchState(authority?.batch_state ?? authority?.batchState);

  return TERMINAL_BATCH_STATES.has(state)
    ? normalizeBatch({
        batch_id: authority?.last_terminal_batch_id ?? authority?.lastTerminalBatchId,
        status: state,
        member_count: authority?.last_terminal_member_count ?? authority?.lastTerminalMemberCount,
        generation: authority?.last_terminal_generation ?? authority?.lastTerminalGeneration ?? authority?.generation,
      })
    : null;
};

const resolveBatchLayers = (status, receipt) => {
  const receiptBatch = normalizeBatch(receipt);
  const authorityActive = authorityActiveBatch(status);
  const storedReceiptConflicts =
    receipt?._origin === "storage" &&
    authorityActive?.batchId &&
    receiptBatch?.batchId &&
    authorityActive.batchId !== receiptBatch.batchId;
  let active = ACTIVE_BATCH_STATES.has(receiptBatch?.state) && !storedReceiptConflicts ? receiptBatch : authorityActive;

  if (
    receiptBatch &&
    TERMINAL_BATCH_STATES.has(receiptBatch.state) &&
    authorityActive?.batchId === receiptBatch.batchId
  ) {
    active = null;
  }

  const authorityTerminal = authorityLastTerminalBatch(status);
  let terminal = authorityTerminal;
  if (TERMINAL_BATCH_STATES.has(receiptBatch?.state)) {
    terminal =
      Number.isInteger(authorityTerminal?.generation) &&
      Number.isInteger(receiptBatch.generation) &&
      authorityTerminal.generation > receiptBatch.generation
        ? authorityTerminal
        : receiptBatch;
  }
  if (active?.batchId && terminal?.batchId === active.batchId) {
    if (authorityTerminal?.batchId === active.batchId) active = null;
    else terminal = null;
  }
  return { active, terminal };
};

const currentBatchId = (status, receipt) => resolveBatchLayers(status, receipt).active?.batchId ?? null;

const currentTaskMember = (status, taskId) => {
  const members = status?.authority?.members;

  if (!Array.isArray(members) || taskId == null) return null;
  return members.find((member) => String(member?.task_id ?? member?.taskId) === String(taskId)) ?? null;
};

const storageKey = (projectId) => `coordexp-refinement:last-batch:${projectId}`;
const readBatchId = (storage, projectId) => {
  try {
    const value = storage?.getItem(storageKey(projectId));
    return BATCH_ID_PATTERN.test(value ?? "") ? value : null;
  } catch {
    return null;
  }
};
const writeBatchId = (storage, projectId, batchId) => {
  try {
    if (BATCH_ID_PATTERN.test(batchId ?? "")) storage?.setItem(storageKey(projectId), batchId);
  } catch {
    // Session storage is a convenience for reload reconciliation; server status remains authoritative.
  }
};
const clearBatchId = (storage, projectId) => {
  try {
    storage?.removeItem(storageKey(projectId));
  } catch {
    // See writeBatchId.
  }
};

export const resolveManagedDataManager = (store, candidate = globalThis.window?.dataManager) => {
  if (!store || !candidate) return null;
  if (candidate.lsf?.lsfInstance?.store !== store) return null;
  if (candidate.lsf?.isManagedRefinementProject !== true) return null;
  if (!Number.isInteger(store.project?.id) || Number(candidate.projectId) !== store.project.id) return null;

  const requiredMethods = [
    "on",
    "off",
    "ensureDurableDraft",
    "beginManagedProjectStatePoll",
    "updateManagedProjectState",
    "getManagedStatusState",
  ];

  return requiredMethods.every((method) => typeof candidate[method] === "function") ? candidate : null;
};

export const CoordExpManagedPanelMount = ({ store, candidate, clientFactory, pollIntervalMs, batchStorage }) => {
  const dataManager = resolveManagedDataManager(store, candidate);

  if (!dataManager) return null;

  return (
    <CoordExpManagedPanel
      projectId={store.project.id}
      dataManager={dataManager}
      clientFactory={clientFactory}
      pollIntervalMs={pollIntervalMs}
      batchStorage={batchStorage}
    />
  );
};

export const CoordExpManagedPanel = ({
  projectId,
  dataManager,
  clientFactory = defaultClientFactory,
  pollIntervalMs = 1500,
  batchIdFactory = createBatchId,
  batchStorage = globalThis.sessionStorage,
}) => {
  const client = useMemo(() => clientFactory(projectId), [clientFactory, projectId]);
  const mounted = useRef(true);
  const pollOwner = useRef(null);
  const commitAbort = useRef(null);
  const [status, setStatus] = useState(() => dataManager.getManagedStatusState?.() ?? null);
  const [receipt, setReceipt] = useState(() => {
    const batchId = readBatchId(batchStorage, projectId);
    return batchId ? { batch_id: batchId, status: "reconciling", _origin: "storage" } : null;
  });
  const [reminder, setReminder] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const [enqueueing, setEnqueueing] = useState(false);

  const updateStatus = useCallback((next) => {
    if (!mounted.current || !next) return;
    setStatus(next);
    setReminder((current) => {
      if (!current) return current;
      const pendingDraftCount = Number(next.pendingDraftCount);
      if (Number.isInteger(pendingDraftCount) && pendingDraftCount <= 0) return null;
      return Number.isInteger(pendingDraftCount) ? { ...current, pendingDraftCount } : current;
    });
  }, []);

  const refreshProjectState = useCallback(
    async (signal) => {
      const token = dataManager.beginManagedProjectStatePoll();
      const projectState = await client.projectState(signal);
      const next = dataManager.updateManagedProjectState(projectState, token);
      const active = projectState.active_batch ?? projectState.activeBatch;
      const terminal = projectState.last_terminal_batch ?? projectState.lastTerminalBatch;
      const trackedBatchId = active?.batch_id ?? active?.batchId ?? terminal?.batch_id ?? terminal?.batchId;

      if (trackedBatchId) writeBatchId(batchStorage, projectId, trackedBatchId);

      updateStatus(next ?? dataManager.getManagedStatusState?.());
      return projectState;
    },
    [batchStorage, client, dataManager, projectId, updateStatus],
  );

  useEffect(() => {
    mounted.current = true;
    const onStatus = (next) => updateStatus(next);
    const onReminder = (next) => {
      if (!mounted.current) return;
      const pendingDraftCount = Number(next?.pendingDraftCount);
      setReminder(Number.isInteger(pendingDraftCount) && pendingDraftCount > 0 ? { ...next, pendingDraftCount } : null);
    };

    dataManager.on("managedStatusChanged", onStatus);
    dataManager.on("managedNavigationReminder", onReminder);

    return () => {
      mounted.current = false;
      dataManager.off("managedStatusChanged", onStatus);
      dataManager.off("managedNavigationReminder", onReminder);
    };
  }, [dataManager, updateStatus]);

  useEffect(() => {
    let timer = null;
    let cancelled = false;
    const effectOwner = {};

    const poll = async () => {
      if (cancelled) return;
      const previousOwner = pollOwner.current;

      if (previousOwner) {
        await previousOwner.promise;
        if (!cancelled) return poll();
        return;
      }

      const controller = new AbortController();
      const owner = { controller, effectOwner, promise: null };

      pollOwner.current = owner;
      owner.promise = (async () => {
        try {
          const batchId = currentBatchId(status, receipt);
          let nextPollError = null;

          try {
            if (batchId) {
              try {
                const nextReceipt = await client.status(batchId, controller.signal);

                if (!cancelled && mounted.current) {
                  setReceipt({ ...nextReceipt, _origin: "status" });
                  if (normalizedBatchState(nextReceipt.status) === "not_found") {
                    clearBatchId(batchStorage, projectId);
                  } else {
                    writeBatchId(batchStorage, projectId, nextReceipt.batch_id);
                    setOperationError(null);
                  }
                }
              } catch (error) {
                if (error?.name === "AbortError") throw error;
                nextPollError = error;
              }
            }
            try {
              await refreshProjectState(controller.signal);
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              nextPollError = error;
            }
            if (!cancelled && mounted.current) setPollError(nextPollError);
          } catch (error) {
            if (!cancelled && error?.name !== "AbortError" && mounted.current) setPollError(error);
          }
        } finally {
          if (pollOwner.current === owner) pollOwner.current = null;
          if (!cancelled) timer = setTimeout(poll, pollIntervalMs);
        }
      })();
      await owner.promise;
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      const owner = pollOwner.current;

      if (owner?.effectOwner === effectOwner) owner.controller.abort();
    };
  }, [
    batchStorage,
    client,
    pollIntervalMs,
    projectId,
    receipt?.batch_id,
    receipt?.status,
    refreshProjectState,
    status?.activeBatchId,
  ]);

  useEffect(
    () => () => {
      commitAbort.current?.abort();
      commitAbort.current = null;
    },
    [],
  );

  const local = status?.local ?? {};
  const { active: activeBatch, terminal: terminalBatch } = resolveBatchLayers(status, receipt);
  const pendingDraftCount = Number.isInteger(status?.pendingDraftCount) ? status.pendingDraftCount : 0;
  const hasPendingWork = pendingDraftCount > 0 || local.dirty === true;
  const batchActive = ACTIVE_BATCH_STATES.has(activeBatch?.state);
  const commitDisabled =
    enqueueing || batchActive || local.saveInFlight === true || local.roiRunning === true || !hasPendingWork;
  const member = currentTaskMember(status, dataManager.lsf?.task?.id);
  const draftAheadOfActive = member?.draft_ahead_of_active_batch === true || member?.draftAheadOfActiveBatch === true;
  const draftAheadOfCommitted = member?.draft_ahead_of_committed === true || member?.draftAheadOfCommitted === true;
  const activeBatchMember = member?.active_batch_member === true || member?.activeBatchMember === true;
  const visibleError =
    errorMessage(operationError) ??
    errorMessage(pollError) ??
    errorMessage(status?.error) ??
    errorMessage(activeBatch?.error) ??
    errorMessage(terminalBatch?.error);

  const commit = async () => {
    if (commitDisabled) return;
    const controller = new AbortController();

    commitAbort.current?.abort();
    commitAbort.current = controller;
    setEnqueueing(true);
    setOperationError(null);
    try {
      await dataManager.ensureDurableDraft();
      const batchId = batchIdFactory();
      writeBatchId(batchStorage, projectId, batchId);
      const accepted = await client.commit(batchId, controller.signal);

      if (mounted.current) {
        setReceipt({ ...accepted.payload, _origin: "commit" });
        writeBatchId(batchStorage, projectId, accepted.payload?.batch_id);
        setReminder(null);
      }
    } catch (error) {
      if (mounted.current && error?.name !== "AbortError") {
        if (error?.outcomeUnknown === true) {
          const batchId = readBatchId(batchStorage, projectId);
          if (batchId) setReceipt({ batch_id: batchId, status: "reconciling", _origin: "commit-unknown" });
          setOperationError(new Error(`Commit response is unknown; reconciling by batch ID. ${errorMessage(error)}`));
        } else {
          clearBatchId(batchStorage, projectId);
          setOperationError(error);
        }
      }
    } finally {
      if (mounted.current) setEnqueueing(false);
      if (commitAbort.current === controller) commitAbort.current = null;
    }
  };

  return (
    <aside className="coordexp-managed-panel" aria-label="CoordExp refinement status">
      <div className="coordexp-managed-panel__header">
        <strong>COCO refinement</strong>
        <span
          className={`coordexp-managed-panel__state coordexp-managed-panel__state--${String(
            status?.taskSemanticState ?? "unknown",
          ).toLowerCase()}`}
        >
          {status?.taskSemanticState ?? "Unknown"}
        </span>
      </div>

      <div className="coordexp-managed-panel__metrics">
        <span>Pending Drafts: {pendingDraftCount}</span>
        <span>Project generation: {status?.generation ?? "—"}</span>
      </div>

      {activeBatch && (
        <div className="coordexp-managed-panel__batch" aria-label="Active batch">
          <strong>Active batch</strong>
          <span>ID: {activeBatch.batchId ?? "—"}</span>
          <span>State: {batchLabel(activeBatch.state)}</span>
          <span>Members: {activeBatch.memberCount ?? "—"}</span>
          <span>Generation: {activeBatch.generation ?? "—"}</span>
          {activeBatchMember && <span>Current task captured</span>}
        </div>
      )}
      {terminalBatch && (
        <div className="coordexp-managed-panel__batch" aria-label="Last terminal batch">
          <strong>Last terminal</strong>
          <span>ID: {terminalBatch.batchId ?? "—"}</span>
          <span>State: {batchLabel(terminalBatch.state)}</span>
          <span>Members: {terminalBatch.memberCount ?? "—"}</span>
          <span>Generation: {terminalBatch.generation ?? "—"}</span>
        </div>
      )}

      {draftAheadOfActive ? (
        <div className="coordexp-managed-panel__notice">Draft ahead of active batch</div>
      ) : draftAheadOfCommitted ? (
        <div className="coordexp-managed-panel__notice">Draft ahead of committed batch</div>
      ) : null}
      {(local.dirty || local.saveInFlight || local.roiRunning) && (
        <div className="coordexp-managed-panel__local" aria-label="Local editor state">
          {local.dirty && <span>Unsaved local edit</span>}
          {local.saveInFlight && <span>Saving Draft…</span>}
          {local.roiRunning && <span>ROI inference running…</span>}
        </div>
      )}
      {reminder && (
        <div className="coordexp-managed-panel__reminder" role="status">
          Draft saved durably. {reminder.pendingDraftCount} Draft(s) may be included in a later batch Commit.
        </div>
      )}
      {activeBatch?.state === "queued" && receipt?.batch_id === activeBatch.batchId && (
        <div className="coordexp-managed-panel__notice" role="status">
          Batch queued durably. Background publication will not block annotation.
        </div>
      )}
      {visibleError && (
        <div className="coordexp-managed-panel__error" role="alert">
          {visibleError}
        </div>
      )}

      <button className="coordexp-managed-panel__commit" type="button" disabled={commitDisabled} onClick={commit}>
        {enqueueing ? "Saving and queueing…" : batchActive ? `${batchLabel(activeBatch.state)}…` : "Commit Drafts"}
      </button>
      <div className="coordexp-managed-panel__hint">Annotate several images, then Commit once.</div>
    </aside>
  );
};
