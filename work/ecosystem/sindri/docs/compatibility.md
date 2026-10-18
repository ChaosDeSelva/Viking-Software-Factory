# Compatibility

| Sindri | Mimir SDK | Mimir protocol package | Wire protocol | Brokkr SDK |
| --- | --- | --- | --- | --- |
| local recovery build | 0.2.0 | 0.2.0 | 1 | 0.1.0 |

Dependencies are local release tarballs under `vendor/`; no source imports cross repositories.
The protocol includes `tasks.requestPr` and optional task verification contracts. Approved
plans retain the full Brokkr selection and lock. Mimir stores each task's verification contract
in its event log and Brokkr checks the pinned content independently of agent controlled files.

The factory acceptance suite uses a real Mimir process and real Brokkr checks with deterministic
agent/reviewer fixtures. The separate live check used Codex through HerdR 0.9.2 (protocol 22).
