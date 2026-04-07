import { IconEyeClosed, IconEyeOpened, IconPlus, IconTrash, IconWarning } from "@humansignal/icons";
import { Button, type ButtonProps } from "@humansignal/ui";
import chroma from "chroma-js";
import { observer } from "mobx-react";
import { type FC, forwardRef, useMemo, useState } from "react";
import { cn } from "../../../utils/bem";
import { getPairRegionColor } from "../../../utils/pairGroups";
import { NodeIcon } from "../../Node/Node";
import { LockButton } from "../Components/LockButton";
import { RegionLabels } from "./RegionLabels";

interface RegionItemProps {
  region: any;
  withActions?: boolean;
  compact?: boolean;
  withIds?: boolean;
  mainDetails?: FC<{ region: any }>;
  metaDetails?: FC<{
    region: any;
    editMode?: boolean;
    cancelEditMode?: () => void;
    enterEditMode: () => void;
  }>;
}

export const RegionItem: FC<RegionItemProps> = observer(
  ({
    region,
    compact = false,
    withActions = true,
    withIds = true,
    mainDetails: MainDetails,
    metaDetails: MetaDetails,
  }) => {
    const { annotation } = region;
    const [editMode, setEditMode] = useState(false);

    const color = useMemo(() => {
      const bgColor = getPairRegionColor(region) ?? region.background ?? region.getOneColor() ?? "#666";

      return chroma(bgColor).alpha(1);
    }, [region.background, region.style, region.type]);

    return (
      <div className={cn("detailed-region").mod({ compact }).toClassName()} data-testid="detailed-region">
        <div className={cn("detailed-region").elem("head").toClassName()} style={{ color: color.css() }}>
          <div className={cn("detailed-region").elem("title").toClassName()}>
            <div className={cn("detailed-region").elem("icon").toClassName()}>
              <NodeIcon node={region} />
            </div>
            <div className={cn("detailed-region").elem("index").toClassName()}>
              <span className={cn("detailed-region").elem("index_value").toClassName()}>{region.region_index}</span>
            </div>
            <RegionLabels region={region} />
          </div>
          {withIds && <span>{region.cleanId}</span>}
        </div>
        {MainDetails && (
          <div className={cn("detailed-region").elem("content").toClassName()}>
            <MainDetails region={region} />
          </div>
        )}
        {region.incomplete && (
          <div className={cn("detailed-region").elem("warning").toClassName()}>
            <IconWarning />
            <div className={cn("detailed-region").elem("warning-text").toClassName()}>
              Incomplete {region.type?.replace("region", "") ?? "region"}
            </div>
          </div>
        )}
        {withActions && (
          <RegionAction region={region} editMode={editMode} annotation={annotation} onEditModeChange={setEditMode} />
        )}
        {MetaDetails && (
          <div className={cn("detailed-region").elem("content").toClassName()}>
            <MetaDetails
              region={region}
              editMode={editMode}
              enterEditMode={() => setEditMode(true)}
              cancelEditMode={() => setEditMode(false)}
            />
          </div>
        )}
      </div>
    );
  },
);

const RegionAction: FC<any> = observer(({ region, annotation, editMode, onEditModeChange }) => {
  const entityButtons: JSX.Element[] = [];

  entityButtons.push(
    <RegionActionButton
      key="meta"
      look={editMode ? "filled" : "string"}
      variant={editMode ? "primary" : "neutral"}
      onClick={() => onEditModeChange(!editMode)}
      aria-label="Edit region's meta"
      tooltip="Edit region's meta"
    >
      <IconPlus />
    </RegionActionButton>,
  );

  return (
    <div className={cn("region-actions").toClassName()}>
      <div className={cn("region-actions").elem("group").mod({ align: "left" }).toClassName()}>
        {!region.isReadOnly() && entityButtons}
      </div>
      <div className={cn("region-actions").elem("group").mod({ align: "right" }).toClassName()}>
        {!region.incomplete && (
          <LockButton
            item={region}
            annotation={region?.annotation}
            hovered={true}
            locked={region?.locked}
            onClick={() => region.setLocked(!region.locked)}
            displayedHotkey="region:lock"
            variant="neutral"
            look="string"
            aria-label="Unlock Region"
            tooltip="Unlock Region"
          />
        )}
        {!region.incomplete && region.hideable && (
          <RegionActionButton
            aria-label={`${region.hidden ? "Show" : "Hide"} selected region`}
            variant="neutral"
            look="string"
            onClick={region.toggleHidden}
            tooltip={`${region.hidden ? "Show" : "Hide"} selected region`}
          >
            {region.hidden ? <IconEyeClosed /> : <IconEyeOpened />}
          </RegionActionButton>
        )}
        <RegionActionButton
          variant="negative"
          look="string"
          aria-label="Delete selected region"
          disabled={region.isReadOnly()}
          tooltip="Delete selected region"
          onClick={() => annotation.deleteRegion(region)}
        >
          <IconTrash />
        </RegionActionButton>
      </div>
    </div>
  );
});

const RegionActionButton: FC<ButtonProps> = forwardRef(({ children, ...props }, ref) => {
  return (
    <Button ref={ref} variant="neutral" look="string" size="small" {...props}>
      {children}
    </Button>
  );
});
