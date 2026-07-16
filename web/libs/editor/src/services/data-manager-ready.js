import { useEffect, useState } from "react";

// Stable browser contract shared with the Label Studio DataManager page.
// CustomEvent.detail is the owned DataManager instance, or null after its owner destroys it.
export const DATA_MANAGER_READY_EVENT = "coordexp:data-manager-ready";

const windowDataManager = () => globalThis.window?.dataManager;
const candidateProjectId = (candidate) => {
  const projectId = candidate?.lsf?.project?.id;

  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
};

export const resolveOwnedDataManagerProject = (store, candidate) => {
  if (!store || !candidate) return null;
  const lsf = candidate.lsf;
  const project = lsf?.project;

  if (lsf?.datamanager !== candidate || lsf?.store !== candidate.store) return null;
  if (lsf?.lsfInstance?.store !== store || lsf?.isManagedRefinementProject !== true) return null;
  if (project !== candidate.store?.project) return null;
  if (!Number.isSafeInteger(project?.id) || project.id <= 0) return null;
  if (!["number", "string"].includes(typeof candidate.projectId) || Number(candidate.projectId) !== project.id) {
    return null;
  }
  return project;
};

export const initializeOwnedDataManager = async ({ load, create, isOwner, publish }) => {
  const loaded = await load();

  if (!isOwner()) return null;
  const dataManager = await create(loaded);

  if (!dataManager) return null;
  if (!isOwner()) {
    dataManager.destroy();
    return null;
  }
  publish(dataManager);
  return dataManager;
};

export const useReadyDataManager = (store, candidate, resolver) => {
  const hasExplicitCandidate = candidate !== undefined;
  const suppliedCandidate = hasExplicitCandidate ? candidate : windowDataManager();
  const projectId = candidateProjectId(suppliedCandidate);
  const [observed, setObserved] = useState(() => ({
    candidate: suppliedCandidate,
    projectId,
    store,
  }));
  const observedInScope =
    observed.store === store && observed.projectId === projectId && observed.candidate === suppliedCandidate;
  const currentCandidate = hasExplicitCandidate ? candidate : observedInScope ? observed.candidate : suppliedCandidate;

  useEffect(() => {
    const target = globalThis.window;
    const initialCandidate = hasExplicitCandidate ? candidate : target?.dataManager;
    const observe = (nextCandidate) =>
      setObserved({ candidate: nextCandidate, projectId: candidateProjectId(nextCandidate), store });

    observe(initialCandidate);
    if (hasExplicitCandidate || !target?.addEventListener) return;

    let active = true;
    const onDataManagerReady = (event) => {
      if (!active) return;
      const nextCandidate = event?.detail;

      if (nextCandidate === null) {
        if (target.dataManager == null) observe(null);
        return;
      }
      if (target.dataManager !== nextCandidate || !resolver(store, nextCandidate)) return;
      observe(nextCandidate);
    };

    target.addEventListener(DATA_MANAGER_READY_EVENT, onDataManagerReady);

    // Close the render-to-effect gap if the ready event fired before subscription.
    const latestCandidate = target.dataManager;

    if (latestCandidate == null || resolver(store, latestCandidate)) {
      observe(latestCandidate ?? null);
    }

    return () => {
      active = false;
      target.removeEventListener(DATA_MANAGER_READY_EVENT, onDataManagerReady);
    };
  }, [candidate, hasExplicitCandidate, projectId, resolver, store]);

  return resolver(store, currentCandidate);
};
