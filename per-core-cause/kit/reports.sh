cd /root/pcc/probe
for m in default alt percore; do
  d=$m.async
  perf report -i $d/cpu.data --symfs /root/symfs --kallsyms /proc/kallsyms --no-children --sort dso,symbol --stdio -g none 2>/dev/null | grep -v "^$" > $d/cpu.self.txt
  perf report -i $d/cpu.data --symfs /root/symfs --kallsyms /proc/kallsyms --children --sort symbol --stdio -g none 2>/dev/null | grep -v "^$" > $d/cpu.children.txt
  perf report -i $d/switch.data --symfs /root/symfs --kallsyms /proc/kallsyms --no-children --stdio -g caller,0.5,callee --max-stack 30 --sort comm 2>/dev/null | grep -v "^$" > $d/switch.txt
  grep -E "Samples|Event count" $d/cpu.self.txt | head -3
done
for m in default percore; do
  for p in async baseline; do
    perf report -i /root/pcc/perf/rec-$m.$p.data --symfs /root/symfs --kallsyms /proc/kallsyms --no-children --sort dso,symbol --stdio -g none 2>/dev/null | grep -v "^$" > /root/pcc/perf/rec-$m.$p.self.txt
  done
done
echo REPORTS-DONE
