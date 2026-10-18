#!/usr/bin/env bash
# Mimir bridge to unmodified MIT Firstmate backend functions. Fixed verbs; no eval.
set -euo pipefail
backend=$1 operation=$2 home=$3
shift 3
ROOT=$(cd "$(dirname "$0")" && pwd)
export FM_HOME="$home" FM_ROOT="$home" FM_ROOT_OVERRIDE="$home"
case "$backend" in zellij|cmux|orca) source "$ROOT/bin/backends/$backend.sh" ;; *) exit 64 ;; esac
# Zellij 0.45 includes exited sessions in its short listing. Never mistake
# retained resurrection metadata for a running terminal server.
if [ "$backend" = zellij ]; then
  fm_backend_zellij_session_exists() {
    zellij list-sessions --no-formatting 2>/dev/null | awk -v want="$1" '$1 == want && $0 !~ /\(EXITED/ { found=1 } END { exit !found }'
  }
fi
case "$backend:$operation" in
 zellij:health) fm_backend_zellij_tool_check; fm_backend_zellij_version_check ;;
 cmux:health) fm_backend_cmux_tool_check; fm_backend_cmux_ping_state ;;
 orca:health) fm_backend_orca_runtime_check ;;
 zellij:create)
  session="mimir-$(fm_backend_hometag)"
  fm_backend_zellij_server_ensure "$session"
  result=$(fm_backend_zellij_create_task "$session" "$1" "$2")
  read -r tab pane <<< "$result"
  printf '%s:%s' "$session" "$pane" ;;
 cmux:create)
  fm_backend_cmux_container_ensure
  result=$(fm_backend_cmux_create_task "$1" "$2")
  read -r workspace surface <<< "$result"
  printf '%s:%s' "$workspace" "$surface" ;;
 orca:create) fm_backend_orca_terminal_create "${MIMIR_ORCA_WORKTREE_ID:?Select an existing Orca worktree ID}" "$1" ;;
 zellij:send|cmux:send) "fm_backend_${backend}_send_text_line" "$1" "$2" "$3" ;;
 orca:send) fm_backend_orca_send_text_line "$1" "$2" ;;
 zellij:key|cmux:key) "fm_backend_${backend}_send_key" "$1" "$2" "$3" ;;
 orca:key) fm_backend_orca_send_key "$1" "$2" ;;
 zellij:capture|cmux:capture) "fm_backend_${backend}_capture" "$1" "$2" "$3" ;;
 orca:capture) fm_backend_orca_capture "$1" "$2" ;;
 zellij:close|cmux:close) "fm_backend_${backend}_kill" "$1" "" "$2" ;;
 orca:close) fm_backend_orca_kill "$1" ;;
 *) exit 64 ;;
esac
