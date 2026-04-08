import { destroy, getParent, getParentOfType, getRoot, isAlive, types } from "mobx-state-tree";

import { guidGenerator } from "../core/Helpers";
import Tree, { TRAVERSE_SKIP } from "../core/Tree";
import Area from "../regions/Area";
import { isDefined } from "../utils/utilities";

const localStorageKeys = {
  order: "relations:order",
};

const PAIR_LABEL = "配对";
const PAIR_LABELS = new Set([PAIR_LABEL, "pair"]);

const getRegionPairKind = (region) => {
  if (!region || region.incomplete) return null;
  if (region.type === "rectangleregion") return "box";
  if (region.type === "polygonregion") return "box";
  if (region.type === "vectorregion") return region.closed ? "box" : "line";
  return null;
};

const normalizePairNodes = (node1, node2) => {
  const kind1 = getRegionPairKind(node1);
  const kind2 = getRegionPairKind(node2);

  if (kind1 === "box" && kind2 === "line") return [node1, node2];
  if (kind1 === "line" && kind2 === "box") return [node2, node1];

  return [node1, node2];
};

/**
 * Relation between two different nodes
 */
const Relation = types
  .model("Relation", {
    id: types.optional(types.identifier, guidGenerator),

    node1: types.reference(Area),
    node2: types.reference(Area),

    direction: types.optional(types.enumeration(["left", "right", "bi"]), "right"),

    // labels
    labels: types.maybeNull(types.array(types.string)),
  })
  .volatile(() => ({
    showMeta: false,
    visible: true,
  }))
  .views((self) => ({
    get parent() {
      return getParentOfType(self, RelationStore);
    },

    get control() {
      return self.parent.control;
    },

    get selectedValues() {
      return self.labels?.filter((relationLabel) => {
        return self.control?.values.includes(relationLabel);
      });
    },

    get hasRelations() {
      return self.control?.children?.length > 0;
    },

    get shouldRender() {
      if (!isAlive(self)) return false;
      const { node1: start, node2: end } = self;
      const [sIdx, eIdx] = [start.item_index, end.item_index];

      // as we don't currently have a unified solution for multi-object segmentation
      // and the Image tag is the only one to support it, we rely on its API
      // TODO: make multi-object solution more generic
      if (isDefined(sIdx) && start.object.multiImage && sIdx !== start.object.currentImage) return false;

      if (isDefined(eIdx) && end.object.multiImage && eIdx !== end.object.currentImage) return false;

      return true;
    },
  }))
  .actions((self) => ({
    rotateDirection() {
      const d = ["left", "right", "bi"];
      let idx = d.indexOf(self.direction);

      idx = idx + 1;
      if (idx >= d.length) idx = 0;

      self.direction = d[idx];
    },

    toggleHighlight() {
      if (self.node1 === self.node2) {
        self.node1.toggleHighlight();
      } else {
        self.node1.toggleHighlight();
        self.node2.toggleHighlight();
      }
    },

    toggleMeta() {
      self.showMeta = !self.showMeta;
    },

    setSelfHighlight(highlighted = false) {
      if (highlighted) {
        self.parent.setHighlight(self);
      } else {
        self.parent.removeHighlight();
      }
    },

    toggleVisibility() {
      self.visible = !self.visible;
    },

    setRelations(values) {
      self.labels = values;
    },
  }));

const RelationStore = types
  .model("RelationStore", {
    relations: types.array(Relation),
    order: types.optional(
      types.enumeration(["asc", "desc"]),
      window.localStorage.getItem(localStorageKeys.order) ?? "asc",
    ),
  })
  .volatile(() => ({
    showConnections: false,
    _highlighted: null,
    control: null,
  }))
  .views((self) => ({
    get highlighted() {
      return self.relations.find((r) => r.id === self._highlighted);
    },
    get size() {
      return self.relations.length;
    },
    get orderedRelations() {
      if (!self.relations) return [];
      if (self.order === "asc") {
        return self.relations.slice();
      }
      return self.relations.slice().reverse();
    },
    get isAllHidden() {
      return !self.relations.find((rl) => !rl.visible);
    },
    get values() {
      return self.control?.values ?? [];
    },
    isPairRelation(relation) {
      return Array.isArray(relation?.labels) && relation.labels.some((label) => PAIR_LABELS.has(label));
    },
    get pairRelations() {
      return self.orderedRelations.filter((relation) => self.isPairRelation(relation));
    },
    get unorderedRelations() {
      return self.orderedRelations.filter((relation) => !self.isPairRelation(relation));
    },
  }))
  .actions((self) => ({
    resolveNode(nodeOrId) {
      if (!nodeOrId) return null;
      if (typeof nodeOrId !== "string") return nodeOrId;

      try {
        return getParent(self, 2)?.areas?.get?.(nodeOrId) ?? null;
      } catch {
        return null;
      }
    },
    afterAttach() {
      const appStore = getRoot(self);

      // find <Relations> tag in the tree
      let relationsTag = null;

      Tree.traverseTree(appStore.annotationStore.root, (node) => {
        if (node.type === "relations") {
          relationsTag = node;
          return TRAVERSE_SKIP;
        }
      });
      self.setControl(relationsTag);
    },
    setControl(relationsTag) {
      self.control = relationsTag;
    },
    findRelations(node1, node2) {
      const id1 = node1.id || node1;
      const id2 = node2?.id || node2;

      if (!id2) {
        return self.relations.filter((rl) => {
          return rl.node1.id === id1 || rl.node2.id === id1;
        });
      }

      return self.relations.filter((rl) => {
        return (rl.node1.id === id1 && rl.node2.id === id2) || (rl.node1.id === id2 && rl.node2.id === id1);
      });
    },

    nodesRelated(node1, node2) {
      return self.findRelations(node1, node2).length > 0;
    },
    getPairRelationsForNode(node) {
      return self.findRelations(node).filter((relation) => self.isPairRelation(relation));
    },
    hasPairForNode(node) {
      return self.getPairRelationsForNode(node).length > 0;
    },
    canCreatePair(node1, node2) {
      const resolvedNode1 = self.resolveNode(node1);
      const resolvedNode2 = self.resolveNode(node2);

      if (!resolvedNode1 || !resolvedNode2) {
        return { ok: false, reason: "请选择两个标注" };
      }

      if (resolvedNode1 === resolvedNode2) {
        return { ok: false, reason: "同一个标注不能和自己成组" };
      }

      const kind1 = getRegionPairKind(resolvedNode1);
      const kind2 = getRegionPairKind(resolvedNode2);

      if (!kind1 || !kind2) {
        return { ok: false, reason: "只能对完整的端口和尾纤连接处成组" };
      }

      if (kind1 === kind2) {
        return { ok: false, reason: "一组必须是一个端口加一个尾纤连接处" };
      }

      if (self.hasPairForNode(resolvedNode1) || self.hasPairForNode(resolvedNode2)) {
        return { ok: false, reason: "已成组的标注不能重复成组" };
      }

      return { ok: true, reason: "" };
    },
    addPair(node1, node2) {
      const resolvedNode1 = self.resolveNode(node1);
      const resolvedNode2 = self.resolveNode(node2);
      const validation = self.canCreatePair(node1, node2);

      if (!validation.ok) return null;

      const [boxNode, lineNode] = normalizePairNodes(resolvedNode1, resolvedNode2);
      const relation = Relation.create({
        node1: boxNode,
        node2: lineNode,
        direction: "bi",
        labels: [PAIR_LABEL],
      });
      self.relations.push(relation);

      return relation;
    },
    deletePairByNode(node) {
      self.getPairRelationsForNode(node).forEach((relation) => self.deleteRelation(relation));
    },

    addRelation(node1, node2) {
      const resolvedNode1 = self.resolveNode(node1);
      const resolvedNode2 = self.resolveNode(node2);
      const pairValidation = self.canCreatePair(node1, node2);
      if (pairValidation.ok) {
        return self.addPair(resolvedNode1, resolvedNode2);
      }

      if (!resolvedNode1 || !resolvedNode2 || self.nodesRelated(resolvedNode1, resolvedNode2)) return null;

      const relation = Relation.create({
        node1: resolvedNode1,
        node2: resolvedNode2,
      });

      self.relations.push(relation);

      return relation;
    },

    deleteRelation(rl) {
      self.relations = self.relations.filter((r) => r.id !== rl.id);
      destroy(rl);
    },

    deleteNodeRelation(node) {
      // lookup $node and delete it's relation
      const rl = self.findRelations(node);

      rl.length && rl.forEach(self.deleteRelation);
    },

    deleteAllRelations() {
      self.relations.forEach((rl) => destroy(rl));
      self.relations = [];
    },

    serialize() {
      return self.relations.map((r) => {
        const s = {
          from_id: r.node1.cleanId,
          to_id: r.node2.cleanId,
          type: "relation",
          direction: r.direction,
        };

        if (r.selectedValues) s.labels = r.selectedValues;

        return s;
      });
    },

    deserializeRelation(node1, node2, direction, labels) {
      const isPair = Array.isArray(labels) && labels.some((label) => PAIR_LABELS.has(label));
      if (!isPair) return;

      const rl = self.addPair(node1, node2);

      if (!rl) return; // duplicated relation

      rl.direction = direction;
      rl.labels = labels;
    },

    toggleConnections() {
      self.showConnections = !self.showConnections;
    },

    toggleOrder() {
      self.order = self.order === "asc" ? "desc" : "asc";
      window.localStorage.setItem(localStorageKeys.order, self.order);
    },

    toggleAllVisibility() {
      const shouldBeHidden = !self.isAllHidden;

      self.relations.forEach((rl) => {
        if (rl.visible !== shouldBeHidden) {
          rl.toggleVisibility();
        }
      });
    },

    setHighlight(relation) {
      self._highlighted = relation.id;
    },

    removeHighlight() {
      self._highlighted = null;
    },
  }));

export default RelationStore;
