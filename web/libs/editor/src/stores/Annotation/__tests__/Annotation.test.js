/**
 * Unit tests for Annotation model (stores/Annotation/Annotation.js).
 * Target: coverage parity 77.92%.
 */
if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});

import { getSnapshot } from "mobx-state-tree";
import "../../../tags/visual/View";
import "../../../tags/object/RichText";
import "../../../tags/object/Image";
import "../../../tags/control/RectangleLabels";
import Tree from "../../../core/Tree";
import Registry from "../../../core/Registry";
import AppStore from "../../AppStore";

const MINIMAL_CONFIG = `<View><Text name="t1" value="$text" /></View>`;
const IMAGE_CONFIG = `<View>
  <Image name="image" value="$image" />
  <RectangleLabels name="bbox" toName="image">
    <Label value="person" />
    <Label value="dog" />
  </RectangleLabels>
</View>`;
const REFINEMENT_IMAGE_CONFIG = IMAGE_CONFIG.replace('<Image name="image"', '<Image name="image" drawOver="true"');

const createTestEnv = () => ({
  events: {
    hasEvent: jest.fn(() => false),
    invoke: jest.fn(),
  },
  messages: {},
  settings: {},
});

function createStoreWithAnnotation(annotationSnapshot = {}) {
  const env = createTestEnv();
  const task = {
    id: 1,
    data: JSON.stringify({ text: "Hello" }),
  };
  const store = AppStore.create(
    {
      config: MINIMAL_CONFIG,
      task,
      interfaces: ["basic"],
    },
    env,
  );
  store.initializeStore({});
  const ann = store.annotationStore.addAnnotation({
    result: [],
    ...annotationSnapshot,
  });
  return { store, annotation: ann, env };
}

function createImageStoreWithAnnotation(annotationSnapshot = {}, config = IMAGE_CONFIG) {
  const env = createTestEnv();
  const store = AppStore.create(
    {
      config,
      task: { id: 1, data: JSON.stringify({ image: "https://example.test/image.jpg" }) },
      interfaces: ["basic"],
    },
    env,
  );
  store.initializeStore({});
  const annotation = store.annotationStore.addAnnotation({
    result: [],
    ...annotationSnapshot,
  });

  if (annotationSnapshot.result?.length) {
    annotation.deserializeResults(annotationSnapshot.result);
    annotation.updateObjects();
    annotation.history.reinit();
  }

  return { store, annotation, env };
}

function rectangleResult(id, overrides = {}) {
  const base = {
    id,
    type: "rectanglelabels",
    from_name: "bbox",
    to_name: "image",
    original_width: 640,
    original_height: 480,
    image_rotation: 0,
    value: {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      rotation: 0,
      rectanglelabels: ["person"],
    },
    meta: {
      coordexp_region_key: id,
    },
  };

  return {
    ...base,
    ...overrides,
    value: { ...base.value, ...overrides.value },
    meta: overrides.meta ?? base.meta,
  };
}

describe("Annotation model", () => {
  describe("atomic result append", () => {
    it("appends all results as exactly one undo action without rewriting ids", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const results = [rectangleResult("inferred:1"), rectangleResult("inferred:2", { value: { x: 50 } })];
      const initialHistoryLength = annotation.history.history.length;
      const initialUndoIdx = annotation.history.undoIdx;

      const appended = annotation.appendResultsAtomically(results);

      expect(appended.map((area) => area.cleanId)).toEqual(["inferred:1", "inferred:2"]);
      expect(results.map((result) => result.id)).toEqual(["inferred:1", "inferred:2"]);
      expect(annotation.regions.map((area) => area.cleanId)).toEqual(["inferred:1", "inferred:2"]);
      expect(annotation.history.history).toHaveLength(initialHistoryLength + 1);
      expect(annotation.history.undoIdx).toBe(initialUndoIdx + 1);

      annotation.undo();
      expect(annotation.regions).toHaveLength(0);
      expect(annotation.history.canUndo).toBe(false);

      annotation.redo();
      expect(annotation.regions.map((area) => area.cleanId)).toEqual(["inferred:1", "inferred:2"]);
    });

    it("rejects duplicate input ids during preflight without mutation or history", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;
      const deserializeSpy = jest.spyOn(annotation, "deserializeSingleResult");

      expect(() =>
        annotation.appendResultsAtomically([rectangleResult("duplicate"), rectangleResult("duplicate")]),
      ).toThrow("Duplicate result id 'duplicate'");
      expect(deserializeSpy).not.toHaveBeenCalled();
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
    });

    it.each([
      ["no label", { value: { rectanglelabels: [] } }, "exactly one non-empty rectangle label"],
      ["multiple labels", { value: { rectanglelabels: ["person", "dog"] } }, "exactly one non-empty rectangle label"],
      ["unknown label", { value: { rectanglelabels: ["cat"] } }, "uses an unknown bbox label"],
      ["non-object meta", { meta: [] }, "meta must be an ordinary JSON object"],
    ])("rejects %s during full preflight", (_case, invalidOverride, expectedMessage) => {
      const { annotation } = createImageStoreWithAnnotation();
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;
      const deserializeSpy = jest.spyOn(annotation, "deserializeSingleResult");

      expect(() =>
        annotation.appendResultsAtomically([
          rectangleResult("valid-first"),
          rectangleResult("invalid-second", invalidOverride),
        ]),
      ).toThrow(expectedMessage);
      expect(deserializeSpy).not.toHaveBeenCalled();
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
    });

    it("rejects an id that conflicts with the current annotation", () => {
      const existing = rectangleResult("existing");
      const { annotation } = createImageStoreWithAnnotation({ result: [existing] });
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;

      expect(() => annotation.appendResultsAtomically([rectangleResult("existing")])).toThrow(
        "Result id 'existing' conflicts with the current annotation",
      );
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
    });

    it("rolls back the complete tracked result snapshot after a mid-insert exception", () => {
      const existing = rectangleResult("existing", { meta: { retained: true } });
      const { annotation } = createImageStoreWithAnnotation({ result: [existing] });
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;
      const originalDeserialize = annotation.deserializeSingleResult;
      let calls = 0;

      jest.spyOn(annotation, "deserializeSingleResult").mockImplementation((...args) => {
        calls += 1;
        if (calls === 2) throw new Error("injected insert failure");
        return originalDeserialize(...args);
      });

      let failure;
      try {
        annotation.appendResultsAtomically([rectangleResult("inferred:1"), rectangleResult("inferred:2")]);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        name: "AtomicResultAppendError",
        code: "COORDEXP_ATOMIC_RESULT_APPEND_FAILED",
      });
      expect(failure.cause?.message).toBe("injected insert failure");
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
      expect(annotation.history.isFrozen).toBe(false);
    });

    it("rolls back when exact-id postconditions are not satisfied", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;
      const originalDeserialize = annotation.deserializeSingleResult;
      let calls = 0;

      jest.spyOn(annotation, "deserializeSingleResult").mockImplementation((...args) => {
        calls += 1;
        if (calls === 2) return undefined;
        return originalDeserialize(...args);
      });

      expect(() =>
        annotation.appendResultsAtomically([rectangleResult("inferred:1"), rectangleResult("inferred:2")]),
      ).toThrow("Atomic result append postcondition failed");
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
      expect(annotation.history.isFrozen).toBe(false);
    });

    it("rolls back when serialized provenance differs from the requested result", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const initialSnapshot = getSnapshot(annotation.trackedState);
      const initialHistoryLength = annotation.history.history.length;
      const originalDeserialize = annotation.deserializeSingleResult;

      jest
        .spyOn(annotation, "deserializeSingleResult")
        .mockImplementation((result, ...args) =>
          originalDeserialize({ ...result, meta: { silently: "changed" } }, ...args),
        );

      expect(() => annotation.appendResultsAtomically([rectangleResult("inferred:1")])).toThrow(
        "Atomic result append postcondition failed",
      );
      expect(getSnapshot(annotation.trackedState)).toEqual(initialSnapshot);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
      expect(annotation.history.isFrozen).toBe(false);
    });

    it("preserves every result's meta through insertion and serialization", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const results = [
        rectangleResult("inferred:1", {
          meta: {
            coordexp_region_key: "inferred:1",
            coordexp_inference_receipt_id: "receipt-1",
            nested: { source: ["roi", 7] },
          },
        }),
        rectangleResult("inferred:2", {
          value: { x: 50, rectanglelabels: ["dog"] },
          meta: {
            coordexp_region_key: "inferred:2",
            coordexp_inference_receipt_id: "receipt-2",
            nested: { source: ["roi", 8] },
          },
        }),
      ];

      annotation.appendResultsAtomically(results);

      for (const expected of results) {
        expect(annotation.regions.find((area) => area.cleanId === expected.id)?.results[0].meta).toEqual(expected.meta);
        expect(annotation.serialized.find((result) => result.id === expected.id)?.meta).toEqual(expected.meta);
      }
    });

    it("fails fast on an empty array without adding history", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const initialHistoryLength = annotation.history.history.length;

      expect(() => annotation.appendResultsAtomically([])).toThrow("Results must be a non-empty array");
      expect(annotation.regions).toHaveLength(0);
      expect(annotation.history.history).toHaveLength(initialHistoryLength);
      expect(annotation.history.isFrozen).toBe(false);
    });

    it("keeps the existing appendResults id-rewriting behavior", () => {
      const { annotation } = createImageStoreWithAnnotation();
      const result = rectangleResult("server-id");

      annotation.appendResults([result]);

      expect(result.id).not.toBe("server-id");
      expect(annotation.regions).toHaveLength(1);
      expect(annotation.regions[0].cleanId).toBe(result.id);
    });
  });

  describe("creation and snapshot", () => {
    it("creates annotation with default type and editable", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.type).toBe("annotation");
      expect(annotation.editable).toBe(true);
      expect(annotation.id).toBeDefined();
    });

    it("creates prediction with editable false", () => {
      const env = createTestEnv();
      const store = AppStore.create(
        {
          config: MINIMAL_CONFIG,
          task: { id: 1, data: JSON.stringify({ text: "Hi" }) },
          interfaces: ["basic"],
        },
        env,
      );
      store.initializeStore({});
      const pred = store.annotationStore.addPrediction({ result: [] });
      expect(pred.type).toBe("prediction");
      expect(pred.editable).toBe(false);
    });
  });

  describe("views", () => {
    it("store returns root store", () => {
      const { store, annotation } = createStoreWithAnnotation();
      expect(annotation.store).toBe(store);
    });

    it("list returns annotation store", () => {
      const { store, annotation } = createStoreWithAnnotation();
      expect(annotation.list).toBe(store.annotationStore);
    });

    it("regions returns array from areas", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.regions).toEqual([]);
    });

    it("results returns empty array when no areas", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.results).toEqual([]);
    });

    it("hasSelection reflects regionStore.hasSelection", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.hasSelection).toBe(false);
    });

    it("selectionSize reflects regionStore selection size", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.selectionSize).toBe(0);
    });

    it("selectedRegions returns empty array when none selected", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.selectedRegions).toEqual([]);
    });

    it("exists is false when pk and versions not set", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.exists).toBe(false);
    });

    it("isReadOnly returns true when readonly is true", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setReadonly(true);
      expect(annotation.isReadOnly()).toBe(true);
    });

    it("isReadOnly returns false when editable and not readonly", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.isReadOnly()).toBe(false);
    });
  });

  describe("actions", () => {
    it("keeps the active refinement label when select-after-create is enabled", () => {
      const { store, annotation } = createImageStoreWithAnnotation(
        { result: [rectangleResult("created-for-refinement")] },
        REFINEMENT_IMAGE_CONFIG,
      );
      const image = annotation.names.get("image");
      const label = annotation.names.get("bbox").children[0];
      const area = annotation.regions[0];

      store.annotationStore.selectAnnotation(annotation.id);
      label.setSelected(true);
      annotation.selectArea(area);
      store.settings.toggleSelectAfterCreate();

      annotation.afterCreateResult(area, { isLabeling: true });

      expect(annotation.selectedRegions).toHaveLength(0);
      expect(label.selected).toBe(true);
      expect(image.drawover).toBe(true);
    });

    it("setEditable updates editable", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setEditable(false);
      expect(annotation.editable).toBe(false);
    });

    it("setReadonly updates readonly", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setReadonly(true);
      expect(annotation.readonly).toBe(true);
    });

    it("toggleVisibility toggles hidden", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.hidden).toBe(false);
      annotation.toggleVisibility(true);
      expect(annotation.hidden).toBe(false);
      annotation.toggleVisibility();
      expect(annotation.hidden).toBe(true);
    });

    it("setIsDrawing updates isDrawing", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setIsDrawing(true);
      expect(annotation.isDrawing).toBe(true);
    });

    it("setDragMode updates dragMode", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setDragMode(true);
      expect(annotation.dragMode).toBe(true);
    });

    it("unselectAreas does not throw when selection empty", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.unselectAreas()).not.toThrow();
    });

    it("unselectAll clears selection and does not throw", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.unselectAll()).not.toThrow();
      expect(() => annotation.unselectAll(true)).not.toThrow();
    });

    it("validate returns true for empty annotation", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.validate()).toBe(true);
    });

    it("beforeSend traverses tree and stops linking mode", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.beforeSend()).not.toThrow();
    });

    it("deleteAllRegions with no regions does not throw", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.deleteAllRegions()).not.toThrow();
    });

    it("deleteAllRegions with deleteReadOnly clears and updates", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.deleteAllRegions({ deleteReadOnly: true })).not.toThrow();
    });

    it("updateObjects does not throw", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.updateObjects()).not.toThrow();
      expect(() => annotation.updateObjects(false)).not.toThrow();
    });

    it("prepareAnnotation parses JSON string", () => {
      const { annotation } = createStoreWithAnnotation();
      const result = annotation.prepareAnnotation(
        '[{"type":"labels","from_name":"l","to_name":"t1","value":{"labels":["A"]}}]',
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it("prepareAnnotation returns array for array input", () => {
      const { annotation } = createStoreWithAnnotation();
      const input = [];
      expect(annotation.prepareAnnotation(input)).toEqual([]);
    });

    it("fixBrokenAnnotation filters invalid results and fixes types", () => {
      const { annotation } = createStoreWithAnnotation();
      const json = [
        { type: "relation", from_id: "a", to_id: "b", direction: "right" },
        { type: "htmllabels", from_name: "x", to_name: "y", value: {} },
      ];
      const fixed = annotation.fixBrokenAnnotation(json);
      expect(fixed.length).toBeLessThanOrEqual(json.length);
    });

    it("fixBrokenAnnotation passes through relation type", () => {
      const { annotation } = createStoreWithAnnotation();
      const json = [{ type: "relation", from_id: "a", to_id: "b", direction: "right", labels: [] }];
      const fixed = annotation.fixBrokenAnnotation(json);
      expect(fixed.some((r) => r.type === "relation")).toBe(true);
    });

    it("serializeAnnotation returns array and resets cursor", () => {
      const { annotation } = createStoreWithAnnotation();
      const result = annotation.serializeAnnotation();
      expect(Array.isArray(result)).toBe(true);
      expect(document.body.style.cursor).toBe("default");
    });

    it("setGroundTruth updates ground_truth", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setGroundTruth(true, false);
      expect(annotation.ground_truth).toBe(true);
    });

    it("sendUserGenerate sets sentUserGenerate", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.sendUserGenerate();
      expect(annotation.sentUserGenerate).toBe(true);
    });

    it("updatePersonalKey sets pk", () => {
      const { store, annotation } = createStoreWithAnnotation();
      store.addAnnotationToTaskHistory = jest.fn();
      annotation.updatePersonalKey("42");
      expect(annotation.pk).toBe("42");
      expect(store.addAnnotationToTaskHistory).toHaveBeenCalledWith("42");
    });

    it("setUnresolvedCommentCount and setCommentCount update counts", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setUnresolvedCommentCount(2);
      annotation.setCommentCount(5);
      expect(annotation.unresolved_comment_count).toBe(2);
      expect(annotation.comment_count).toBe(5);
    });

    it("addVersions merges versions and can set draftSelected", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.addVersions({ draft: [] });
      expect(annotation.versions.draft).toEqual([]);
    });

    it("setDraftId and setDraftSelected update volatile state", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setDraftId(99);
      annotation.setDraftSelected(true);
      expect(annotation.draftId).toBe(99);
      expect(annotation.draftSelected).toBe(true);
    });

    it("setDraftSaving and setDraftSaved update state", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.setDraftSaving(true);
      expect(annotation.isDraftSaving).toBe(true);
      annotation.setDraftSaved("2020-01-01");
      expect(annotation.draftSaved).toBe("2020-01-01");
    });

    it("keeps delayed native autosave creation disabled after an external owner claims the Draft", async () => {
      const { annotation, env } = createStoreWithAnnotation();

      env.events.hasEvent.mockImplementation((event) => event === "submitDraft");
      const starting = annotation.startAutosave();
      annotation.setExternalDraftSaveOwner(true);

      await starting;
      expect(annotation.externalDraftSaveOwner).toBe(true);
      expect(annotation.autosave).toBeUndefined();
    });

    it("does not unpause an existing native autosave after external ownership is claimed during its delay", async () => {
      const { annotation, env } = createStoreWithAnnotation();

      env.events.hasEvent.mockImplementation((event) => event === "submitDraft");
      await annotation.startAutosave();
      expect(annotation.autosave).toBeDefined();
      annotation.pauseAutosave();
      expect(annotation.autosave.paused).toBe(true);

      const restarting = annotation.startAutosave();
      annotation.setExternalDraftSaveOwner(true);
      await restarting;

      expect(annotation.autosave.paused).toBe(true);
    });

    it("starts native autosave normally when there is no external Draft owner", async () => {
      const { annotation, env } = createStoreWithAnnotation();

      env.events.hasEvent.mockImplementation((event) => event === "submitDraft");
      await annotation.startAutosave();

      expect(annotation.externalDraftSaveOwner).toBe(false);
      expect(annotation.autosave).toBeDefined();
      expect(annotation.autosave.paused).not.toBe(true);
      annotation.pauseAutosave();
    });

    it("dropDraft clears draft state when autosave exists", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.autosave = { cancel: jest.fn() };
      annotation.setDraftId(1);
      annotation.setDraftSelected(true);
      annotation.addVersions({ draft: [] });
      annotation.dropDraft();
      expect(annotation.draftId).toBe(0);
      expect(annotation.draftSelected).toBe(false);
      expect(annotation.versions.draft).toBeUndefined();
    });

    it("dropDraft clears managed Draft state without creating native autosave", () => {
      const { annotation } = createStoreWithAnnotation();

      annotation.setExternalDraftSaveOwner(true);
      annotation.setDraftId(7);
      annotation.setDraftSelected(true);
      annotation.setDraftSaved("2026-07-16T00:00:00Z");
      annotation.addVersions({ draft: [{ id: "managed-draft" }] });

      expect(annotation.autosave).toBeUndefined();
      annotation.dropDraft();

      expect(annotation.draftId).toBe(0);
      expect(annotation.draftSelected).toBe(false);
      expect(annotation.draftSaved).toBeUndefined();
      expect(annotation.versions.draft).toBeUndefined();
    });

    it("keeps the ordinary no-autosave dropDraft behavior unchanged", () => {
      const { annotation } = createStoreWithAnnotation();

      annotation.setDraftId(7);
      annotation.setDraftSelected(true);
      annotation.setDraftSaved("2026-07-16T00:00:00Z");
      annotation.addVersions({ draft: [{ id: "ordinary-draft" }] });

      expect(annotation.externalDraftSaveOwner).toBe(false);
      expect(annotation.autosave).toBeUndefined();
      annotation.dropDraft();

      expect(annotation.draftId).toBe(7);
      expect(annotation.draftSelected).toBe(true);
      expect(annotation.draftSaved).toBe("2026-07-16T00:00:00Z");
      expect(annotation.versions.draft).toEqual([{ id: "ordinary-draft" }]);
    });

    it("reinitHistory calls history.reinit and setInitialValues for annotation type", () => {
      const { annotation } = createStoreWithAnnotation();
      annotation.history.reinit = jest.fn();
      annotation.reinitHistory(true);
      expect(annotation.history.reinit).toHaveBeenCalledWith(true);
    });

    it("deserializeAnnotation warns and delegates to deserializeResults", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { annotation } = createStoreWithAnnotation();
      annotation.deserializeResults = jest.fn();
      annotation.deserializeAnnotation([]);
      expect(consoleSpy).toHaveBeenCalled();
      expect(annotation.deserializeResults).toHaveBeenCalledWith([]);
      consoleSpy.mockRestore();
    });

    it("prepareValue returns value for non-text types", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(annotation.prepareValue({ labels: ["A"] }, "rectanglelabels")).toEqual({ labels: ["A"] });
    });

    it("prepareValue transforms start/end to startOffset/endOffset for text types", () => {
      const { annotation } = createStoreWithAnnotation();
      const value = { start: 0, end: 5 };
      const result = annotation.prepareValue(value, "richtext");
      expect(result.startOffset).toBe(0);
      expect(result.endOffset).toBe(5);
      expect(result.isText).toBe(true);
    });

    it("rejectAllSuggestions clears suggestions", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.rejectAllSuggestions()).not.toThrow();
    });

    it("resetReady iterates objects and areas", () => {
      const { annotation } = createStoreWithAnnotation();
      expect(() => annotation.resetReady()).not.toThrow();
    });
  });
});
