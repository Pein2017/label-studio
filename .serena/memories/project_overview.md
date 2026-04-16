# Label Studio Project Overview

- Purpose: open-source Label Studio codebase, currently customized for the user's local pigtail-port annotation workflow.
- Primary stack: Django/Python backend plus a React/MobX-State-Tree/Konva frontend under `web/libs/editor`.
- Key local customization area: pair/group UX, Chinese labeling UI, vector/quad behavior, local-files image serving, and export normalization.
- Important local runtime: local source deployment on macOS using a project venv and Local Files storage rooted under `/Users/pein/data/pigtail/workspace/labelstudio-data`.
- Repo layout highlights:
  - `label_studio/tasks`: annotation serializers, models, normalization, API hooks.
  - `label_studio/io_storages/localfiles`: Local Files storage and serving.
  - `web/libs/editor/src`: frontend labeling editor, tools, regions, side panels, keymaps.
  - `web/dist/apps/labelstudio`: built frontend assets after `ls:build`.
- Current user-specific customizations include pair grouping, colored Regions/Groups UI, direct Cmd/Ctrl canvas multiselect, quad auto-close at 4 points, and Local Files image calibration on submit.