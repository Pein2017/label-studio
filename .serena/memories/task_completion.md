# Task Completion Checklist

- For frontend changes in `web/libs/editor`, rebuild the frontend with `yarn ls:build` before asking the user to refresh.
- For backend changes in `label_studio/tasks` or storage code, run `python label_studio/manage.py check` and restart the local Label Studio service.
- Prefer validating Python edits with `python -m py_compile` on touched files.
- Run `git diff --check` before wrapping up.
- If the change touches Local Files or annotation serialization, verify with the local SQLite DB and/or a focused manual script, because the runtime environment may not have `pytest` installed in the active venv.
- Do not revert existing custom UI/UX changes for the user's pigtail workflow unless explicitly asked.