export const PAIR_GROUP_KIND = {
  BOX: "box",
  LINE: "line",
};

export const PAIR_REGION_VARIANT = {
  QUAD_PORT: "quad-port",
  RECT_PORT: "rect-port",
  TAIL_FIBER: "tail-fiber",
};

const PAIR_REGION_META = {
  [PAIR_REGION_VARIANT.QUAD_PORT]: {
    label: "端口/多边形",
    color: "#2f9e44",
  },
  [PAIR_REGION_VARIANT.RECT_PORT]: {
    label: "端口/矩形",
    color: "#1c7ed6",
  },
  [PAIR_REGION_VARIANT.TAIL_FIBER]: {
    label: "尾纤连接处",
    color: "#f08c00",
  },
};

const getRegionControl = (region) => {
  return region?.control ?? region?.labeling?.from_name ?? region?.results?.[0]?.from_name ?? null;
};

export const getPairGroupKind = (region) => {
  if (!region || region.incomplete) return null;

  if (region.type === "rectangleregion" || region.type === "videorectangleregion") {
    return PAIR_GROUP_KIND.BOX;
  }

  if (region.type !== "vectorregion" && region.type !== "videovectorregion" && region.type !== "polygonregion") {
    return null;
  }

  const control = getRegionControl(region);
  const closable = Boolean(control?.closable);
  const maxPointsRaw = control?.maxpoints ?? control?.maxPoints;
  const maxPoints = maxPointsRaw == null ? null : Number.parseInt(maxPointsRaw, 10);

  if (closable && maxPoints === 4) {
    return PAIR_GROUP_KIND.BOX;
  }

  if (!closable) {
    return PAIR_GROUP_KIND.LINE;
  }

  return null;
};

export const getPairRegionVariant = (region) => {
  if (!region || region.incomplete) return null;

  if (region.type === "rectangleregion" || region.type === "videorectangleregion") {
    return PAIR_REGION_VARIANT.RECT_PORT;
  }

  if (region.type !== "vectorregion" && region.type !== "videovectorregion" && region.type !== "polygonregion") {
    return null;
  }

  const control = getRegionControl(region);
  const closable = Boolean(control?.closable);
  const maxPointsRaw = control?.maxpoints ?? control?.maxPoints;
  const maxPoints = maxPointsRaw == null ? null : Number.parseInt(maxPointsRaw, 10);

  if (closable && maxPoints === 4) {
    return PAIR_REGION_VARIANT.QUAD_PORT;
  }

  if (!closable) {
    return PAIR_REGION_VARIANT.TAIL_FIBER;
  }

  return null;
};

export const getPairRegionLabel = (region) => {
  const variant = getPairRegionVariant(region);

  return variant ? PAIR_REGION_META[variant]?.label ?? null : null;
};

export const getPairRegionColor = (region) => {
  const variant = getPairRegionVariant(region);

  return variant ? PAIR_REGION_META[variant]?.color ?? null : null;
};

export const normalizePairGroupMembers = (regions) => {
  const items = Array.isArray(regions) ? regions.filter(Boolean) : [];
  if (items.length !== 2) return null;

  const kinds = items.map(getPairGroupKind);
  if (kinds.some((kind) => !kind)) return null;
  if (kinds[0] === kinds[1]) return null;

  const boxIndex = kinds[0] === PAIR_GROUP_KIND.BOX ? 0 : 1;
  const lineIndex = boxIndex === 0 ? 1 : 0;

  return [items[boxIndex], items[lineIndex]];
};

export const getPairGroupValidation = (regions, relationStore) => {
  const items = Array.isArray(regions) ? regions.filter(Boolean) : [];

  if (items.length !== 2) {
    return {
      ok: false,
      reason: "请先选中一个端口和一个尾纤连接处",
      members: null,
    };
  }

  const normalized = normalizePairGroupMembers(items);
  if (!normalized) {
    return {
      ok: false,
      reason: "只能将一个端口与一个尾纤连接处组成一组",
      members: null,
    };
  }

  if (relationStore?.findRelations) {
    const alreadyGrouped = normalized.some((region) => {
      if (typeof relationStore.hasPairForNode === "function") {
        return relationStore.hasPairForNode(region);
      }

      return relationStore.findRelations(region).length > 0;
    });
    if (alreadyGrouped) {
      return {
        ok: false,
        reason: "所选对象已经在其他组里了",
        members: normalized,
      };
    }
  }

  return {
    ok: true,
    reason: "",
    members: normalized,
  };
};

export const formatPairGroupLabel = (members) => {
  if (!members || members.length !== 2) return "group=[]";
  const [box, line] = members;
  return `group=[${box?.region_index ?? "?"},${line?.region_index ?? "?"}]`;
};
