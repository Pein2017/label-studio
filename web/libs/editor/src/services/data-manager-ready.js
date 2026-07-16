import { useEffect, useState } from "react";

// Stable browser contract shared with the Label Studio DataManager page.
// CustomEvent.detail is the owned DataManager instance, or null after its owner destroys it.
export const DATA_MANAGER_READY_EVENT = "coordexp:data-manager-ready";

const windowDataManager = () => globalThis.window?.dataManager;

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
  const projectId = store?.project?.id;
  const [observed, setObserved] = useState(() => ({
    candidate: hasExplicitCandidate ? candidate : windowDataManager(),
    projectId,
    store,
  }));
  const observedInScope = observed.store === store && observed.projectId === projectId;
  const currentCandidate = hasExplicitCandidate
    ? candidate
    : observedInScope
      ? observed.candidate
      : windowDataManager();

  useEffect(() => {
    const target = globalThis.window;
    const initialCandidate = hasExplicitCandidate ? candidate : target?.dataManager;

    setObserved({ candidate: initialCandidate, projectId, store });
    if (hasExplicitCandidate || !target?.addEventListener) return;

    let active = true;
    const onDataManagerReady = (event) => {
      if (!active) return;
      const nextCandidate = event?.detail;

      if (nextCandidate === null) {
        if (target.dataManager == null) setObserved({ candidate: null, projectId, store });
        return;
      }
      if (target.dataManager !== nextCandidate || !resolver(store, nextCandidate)) return;
      setObserved({ candidate: nextCandidate, projectId, store });
    };

    target.addEventListener(DATA_MANAGER_READY_EVENT, onDataManagerReady);

    // Close the render-to-effect gap if the ready event fired before subscription.
    const latestCandidate = target.dataManager;

    if (latestCandidate == null || resolver(store, latestCandidate)) {
      setObserved({ candidate: latestCandidate ?? null, projectId, store });
    }

    return () => {
      active = false;
      target.removeEventListener(DATA_MANAGER_READY_EVENT, onDataManagerReady);
    };
  }, [candidate, hasExplicitCandidate, projectId, resolver, store]);

  return resolver(store, currentCandidate);
};
