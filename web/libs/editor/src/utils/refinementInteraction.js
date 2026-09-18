const REFINEMENT_RECTANGLE_TOOLS = ["RectangleTool", "RectangleTool-dynamic"];

export const sortRefinementLabelsByUsage = (labels, usageCounts = []) => {
  return labels
    .map((label, index) => ({
      label,
      index,
      count: Number.isFinite(Number(usageCounts[index])) ? Number(usageCounts[index]) : 0,
    }))
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map(({ label }) => label);
};

export const getRefinementLabelHotkeys = (labels, usageCounts = []) => {
  return new Map(
    sortRefinementLabelsByUsage(labels, usageCounts)
      .slice(0, 9)
      .map((label, index) => [label, String(index + 1)]),
  );
};

// Project 3 is the local five-image refinement project.  The description
// marker is the forward-compatible identity used by managed refinement
// projects; the ID fallback keeps this existing local project opt-in without
// making ordinary drawOver projects enter the custom path.
export const isRefinementProject = (subject) => {
  const project = subject?.store?.project ?? subject?.project;

  // Isolated editor fragments do not carry the AppStore project object. The
  // caller still has to opt into `drawOver`, so keeping this permissive here
  // does not widen the production project boundary.
  if (!project) return subject?.drawover === true;

  const description = project?.description;

  if (typeof description === "string" && description.startsWith("coordexp-refinement-project-identity:")) {
    return true;
  }

  return Number(project?.id) === 3;
};

export const isRefinementRectangleTool = (tool) =>
  REFINEMENT_RECTANGLE_TOOLS.includes(tool?.fullName) && tool?.isDrawingTool === true;

/**
 * Native label-driven drawing is the only refinement annotation state. A
 * selected region deliberately takes precedence so upstream relabeling and
 * transformer editing remain available.
 */
export const isRefinementDrawingSession = (item) => {
  if (item?.drawover !== true || !isRefinementProject(item)) return false;

  const selectedTool = item.getToolsManager?.()?.findSelectedTool?.();
  const activeStates = item.activeStates?.();
  const selectedRegions = item.selectedRegions;
  const hasActiveLabel = (activeStates?.length ?? 0) > 0;
  const hasNoSelectedRegion = (selectedRegions?.length ?? 0) === 0;

  return isRefinementRectangleTool(selectedTool) && hasActiveLabel && hasNoSelectedRegion;
};
