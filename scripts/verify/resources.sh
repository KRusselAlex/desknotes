#!/bin/sh
# Memory (PSS, MiB) of DeskNotes and its WebKit child processes, plus idle CPU over 10 s.
APP=$(pgrep -x desknotes)
PIDS="$APP $(pgrep -P $APP | tr '\n' ' ') $(for p in $(pgrep -P $APP); do pgrep -P $p; done | tr '\n' ' ')"
PIDS=$(echo $PIDS | tr ' ' '\n' | sort -u | tr '\n' ' ')
for p in $PIDS; do printf "%s %s %s\n" $p $(cat /proc/$p/comm) $(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup); done | awk '{t+=$3; printf "  %-8s %-18s PSS %6.1f MiB\n",$1,$2,$3/1024} END{printf "  total PSS %.1f MiB across %d processes\n", t/1024, NR}'
ticks(){ for p in $PIDS; do awk '{print $14+$15}' /proc/$p/stat 2>/dev/null; done | awk '{s+=$1} END{print s}'; }
a=$(ticks); sleep 10; b=$(ticks); hz=$(getconf CLK_TCK)
echo "  idle CPU over 10 s: $(echo "$a $b $hz" | awk '{printf "%.2f%%", ($2-$1)/$3/10*100}')"
