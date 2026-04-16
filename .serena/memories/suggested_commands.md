# Suggested Commands

- Activate project env:
  - `source /Users/pein/data/pigtail/workspace/.venv-ls/bin/activate`
- Frontend build:
  - `cd /Users/pein/data/pigtail/label-studio/web && npx -y yarn@1.22.22 ls:build`
- Backend health check:
  - `cd /Users/pein/data/pigtail/label-studio && python label_studio/manage.py check`
- Python syntax check for edited files:
  - `python -m py_compile <file1> <file2> ...`
- Diff whitespace check:
  - `git -C /Users/pein/data/pigtail/label-studio diff --check`
- Start the local customized service:
  - `/Users/pein/data/pigtail/start-labelstudio.sh`
- Confirm the service is listening:
  - `lsof -iTCP:8081 -sTCP:LISTEN -n -P`
- Smoke-check login page:
  - `curl -I http://127.0.0.1:8081/user/login/`
- Inspect live annotation data in the local SQLite state DB:
  - `sqlite3 /Users/pein/data/pigtail/workspace/ls-state/label_studio.sqlite3 'select id, substr(result,1,400) from task_completion order by id desc limit 3;'`