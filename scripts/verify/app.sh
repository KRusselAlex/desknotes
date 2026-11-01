#!/bin/sh
# Start or stop a DeskNotes binary with isolated test data, then list its windows.
# Usage: scripts/verify/app.sh start|stop [binary]
# Data goes to $DESKNOTES_TEST_DATA (default: ./.verify-data), never your real notes.
DIR=$(cd "$(dirname "$0")" && pwd)
DATA=${DESKNOTES_TEST_DATA:-$PWD/.verify-data}
BIN=${2:-$PWD/target/debug/desknotes}
case "$1" in
  start)
    mkdir -p "$DATA"
    XDG_DATA_HOME="$DATA" nohup "$BIN" > "$DATA/app.log" 2>&1 &
    i=0; while [ $i -lt 60 ]; do python3 -I "$DIR/x.py" list | grep -q . && break; sleep 0.5; i=$((i+1)); done
    sleep 1.5 ;;
  stop)
    kill -TERM $(pgrep -x desknotes) 2>/dev/null; sleep 1 ;;
  *) echo "usage: $0 start|stop [binary]"; exit 2 ;;
esac
python3 -I "$DIR/x.py" list
