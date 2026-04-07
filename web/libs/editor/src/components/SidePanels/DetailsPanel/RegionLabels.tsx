import type { FC } from "react";
import { observer } from "mobx-react";

import { cn } from "../../../utils/bem";
import { getPairRegionColor, getPairRegionLabel } from "../../../utils/pairGroups";

export const RegionLabels: FC<{ region: LSFRegion }> = observer(({ region }) => {
  const labelsInResults = region.labelings.map((result: any) => result.selectedLabels || []);
  const labels: any[] = [].concat(...labelsInResults);

  if (!labels.length) {
    const fallbackLabel = getPairRegionLabel(region) ?? region.noLabelView ?? "No label";
    const fallbackColor = getPairRegionColor(region);

    return (
      <div className={cn("labels-list").toClassName()} style={fallbackColor ? { color: fallbackColor } : undefined}>
        {fallbackLabel}
      </div>
    );
  }

  return (
    <div className={cn("labels-list").toClassName()}>
      {labels.map((label, index) => {
        const color = label.background || "#000000";

        return [
          index ? ", " : null,
          <span key={label.id} style={{ color }}>
            {label.value}
          </span>,
        ];
      })}
    </div>
  );
});
