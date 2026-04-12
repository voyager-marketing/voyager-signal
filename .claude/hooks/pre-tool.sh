#!/bin/bash
TOOL=$1; PATH_ARG=$2
ALLOWED=("extension/" "enrichment/" "scripts/" "docs/")
if [[ "$TOOL" == "Write" || "$TOOL" == "Edit" ]]; then
  for a in "${ALLOWED[@]}"; do
    [[ "$PATH_ARG" == $a* ]] && exit 0
  done
  echo "BLOCKED: $PATH_ARG outside scope" >&2; exit 1
fi
exit 0
