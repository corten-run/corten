// profile.mjs: Pass A of corten-run/corten#1824's kit (1824c). Reads results/turns-a-*.csv and the
// reports profile.sh wrote in results/profile/, and prints profile.md (Markdown); it also writes
// results/profile.json for summary.mjs. Usage: node profile.mjs <results dir>
//
// Each a-* comparison has A (the store with room) and B (the store off), the same binary and
// allocator, a fresh start every turn, perf record -C 2 over the turn. A side's figure for a symbol
// is the sum of its periods over that side's recorded turns divided by the requests those turns
// answered, each turn's kernel and user periods first scaled to CPU 2's cycles:k and cycles:u that
// perf stat -C 2 counted over the same turn (so samples the kernel throttled do not shrink a side): cycles a request (or ns a request where the host could only sample cpu-clock;
// results/events.txt says which). Everything on CPU 2 is counted, the server and any kernel work run
// there. Tables: per side the top 50 symbols (perf report --no-children --sort sym, merged over the
// turns); the 50 largest differences A - B; the declared categories (below; results/margin.md)
// with their per-pair spread; for the call-graph comparisons the ways into the kernel and the
// inclusive markers of entries.mjs.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node profile.mjs <results dir>");

// The categories results/margin.md declares: each kernel symbol goes to the first that matches its
// name; a user-mode symbol is "user". The order matters (memcg's lruvec counters before the page
// allocator's, for example).
export const CATS = [
  ["zeroing", /^(clear_page_erms|clear_page_rep|clear_page_orig|clear_page|clear_huge_page|folio_zero_user|process_huge_page|clear_subpage|clear_gigantic_page)$/],
  ["compaction and khugepaged", /compact|^isolate_(migrate|free)pages|^migrate_pages|^move_to_new_folio|^migrate_folio|khugepaged|collapse_huge_page|hpage_collapse/],
  ["memcg", /mem_cgroup|memcg|^page_counter_|^obj_cgroup_|^refill_stock|^consume_stock|^try_charge|^charge_memcg|^_*mod_lruvec|^_*lruvec_stat|^mod_objcg|^_*css_rstat\w*|^_*cgroup_rstat\w*/],
  ["page allocator", /^_*(alloc_pages|alloc_frozen_pages|alloc_pages_mpol|get_page_from_freelist|rmqueue\w*|prep_compound_page|prep_new_page|post_alloc_hook|vma_alloc_folio|folio_alloc\w*|expand|free_pages\w*|free_unref\w*|free_pcppages_bulk|free_one_page|free_compound_page|mod_zone_page_state|mod_node_page_state|zone_watermark\w*|zone_watermark_ok\w*|next_zones_zonelist|steal_suitable_fallback|move_freepages\w*|del_page_from_free_list|count_vm_events?|split_page|kernel_init_pages|get_vma_policy|policy_nodemask|policy_node|page_reporting\w*|percpu_counter_add_batch|free_frozen_pages|free_tail_page_prepare|get_pfnblock_flags_mask\w*)(_noprof)?$/],
  ["fault handling", /^_*(asm_exc_page_fault|exc_page_fault|do_user_addr_fault|handle_mm_fault|handle_pte_fault|do_anonymous_page|do_huge_pmd_anonymous_page|vma_alloc_anon_folio_pmd|map_anon_folio_pmd\w*|lock_vma_under_rcu|pte_alloc\w*|pmd_install|pgtable_trans_huge_deposit|folio_add_new_anon_rmap|folio_mod_stat|set_pte_range|anon_vma_prepare|lru_add\w*|folio_add_lru\w*|folio_batch_move_lru|folio_batch_add_and_move|folio_lruvec_lock\w*|lru_gen_\w+|mm_counter\w*|do_fault|thp_vma_allowable_orders|alloc_anon_folio|vma_start_read|sync_regs|error_entry|vmf_anon_prepare|folio_throttle_swaprate|blk_cgroup_congested|access_error|mas_\w+|pte_\w+|_*pte_offset_map\w*|pmd_\w+|pgd_\w+|p4d_\w+|pud_\w+|fault_\w+|count_memcg_event_mm|mm_account_fault|up_read|down_read_trylock|find_vma\w*)$/],
  ["unmapping and TLB", /madvise|^_*zap_|^_*unmap_|^_*tlb_|flush_tlb|split_huge|deferred_split|^free_pgtables|^release_pages|^_*folios?_put\w*|^free_pages_and_swap_cache|^_*smp_call_function\w*|^llist_add_batch|^_*x2apic_send_IPI\w*|^_*x64_sys_munmap|^do_vmi_\w+|^vms_\w+|^_*split_vma/],
  ["scheduler and wakeups", /^_*(schedule\w*|pick_next\w*|pick_task\w*|enqueue\w*|dequeue\w*|update_curr\w*|try_to_wake_up|ttwu_\w+|finish_task_switch\w*|switch_mm\w*|switch_to\w*|psi_\w+|update_load_avg\w*|select_task_rq\w*|set_next_entity|put_prev\w*|reweight_entity|futex\w*|do_futex|x64_sys_futex|resched_curr|check_preempt\w*|wakeup_preempt\w*|update_rq_clock\w*|wake_up\w*|autoremove_wake_function|default_wake_function|prepare_to_wait\w*|finish_wait|sched_\w+|avg_vruntime|update_entity_lag|place_entity|vruntime\w*|__calc_delta\w*)$/],
  ["network", /^_*(tcp\d?|cubictcp|bictcp|skb|sk|sock|inet\d?|ip|ip4|ipv4|raw|loopback|netif|napi|dev|nf|nft|eth|neigh|qdisc|sch|dst|csum|net|xfrm|build_skb|alloc_skb|kfree_skb|consume_skb|kmalloc_reserve|release_sock|lock_sock|security_socket|selinux_parse_skb|selinux_socket|selinux_ip|bpf_skops|cgroup_bpf|enqueue_to_backlog|process_backlog|sys_sendto|sys_recvfrom|x64_sys_sendto|x64_sys_recvfrom|x64_sys_writev?|x64_sys_readv?|x64_sys_recvmsg|x64_sys_sendmsg|sys_sendmsg|sys_recvmsg)(_|$)/],
  ["copies to and from user", /^_*(copy_user\w*|copy_to_iter|copy_from_iter|copy_page_to_iter|copy_page_from_iter|simple_copy_to_iter|rep_movs_alternative|rep_stos_alternative|check_object_size\w*|check_heap_object|check_stack_object|is_vmalloc_addr|virt_addr_valid|copy_to_user|copy_from_user|clear_user|copy_iovec_from_user|import_iovec|iov_iter\w*|copy_mc\w*)$/],
  ["epoll and syscall entry", /^_*(ep_\w+|do_epoll\w*|epoll\w*|x64_sys_epoll\w*|entry_SYSCALL\w*|do_syscall_64|syscall_\w+|x64_sys_call|clear_bhb_loop|entry_SYSRETQ\w*|fdget\w*|fget\w*|fput\w*|fsnotify\w*|security_\w+|selinux\w*|avc_\w+|apparmor\w*|aa_\w+|bpf_lsm\w*|rw_verify_area|vfs_\w+|ksys_\w+|do_writev|do_readv|do_iter_\w+|seccomp\w*|secure_computing|populate_seccomp_data|eventfd\w*|exit_to_user_mode\w*|switch_fpu\w*|fpregs\w*|restore_fpregs\w*)$/],
  ["slab", /^_*(kmem_cache\w*|kmalloc\w*|kfree\w*|slab\w*|kvfree\w*|krealloc\w*|ksize|build_detached_freelist|memcg_slab\w*)$/],
  ["interrupts, timers and RCU", /^_*(sysvec\w*|asm_sysvec\w*|irq\w*|handle_irq\w*|hrtimer\w*|tick\w*|timer\w*|run_timer\w*|apic\w*|lapic\w*|native_apic\w*|ktime_get\w*|clockevents\w*|read_\w*clock\w*|kvm_clock\w*|pvclock\w*|native_sched_clock|sched_clock\w*|detach_if_pending|lock_timer_base|mod_timer|send_ipi\w*|send_ipi_one|smp_call_single_queue|kvm_send_ipi\w*|hv_\w+|native_smp_send_reschedule|update_process_times|account_\w+|scheduler_tick|sched_tick|rcu_\w+|note_gp_changes|handle_softirqs|do_softirq\w*|irqentry\w*|irq_exit\w*|run_ksoftirqd|native_irq_return\w*)$/],
  ["idle", /^_*(idle\w*|cpuidle\w*|do_idle|default_idle\w*|pv_native_safe_halt|native_safe_halt|acpi_idle\w*|poll_idle|intel_idle\w*|cpu_idle\w*|arch_cpu_idle\w*|mwait_idle\w*|cpu_startup_entry)$/],
  ["locks", /^_*(raw_spin\w*|raw_read\w*|raw_write\w*|queued_spin\w*|native_queued\w*|mutex\w*|down_\w+|up_\w+|rwsem\w*|osq_lock|pv_\w*lock\w*)$/],
  ["other kernel", /./],
];
// A compiler-made suffix (.constprop.0, .isra.0, .part.0, .cold) is not part of the name matched.
const category = (mode, sym) => (mode === "k" ? CATS.find(([, re]) => re.test(sym.replace(/(\.(constprop|isra|part|cold|llvm)(\.\d+)?)+$/, "")))[0] : "user");

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const s0 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "n/a");
const p1 = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
const esc = (s) => s.replace(/\|/g, "\\|");

const events = existsSync(join(dir, "events.txt")) ? readFileSync(join(dir, "events.txt"), "utf8") : "";
const unit = (events.match(/preflight sampling: (\S+) every/) ?? [, "cycles"])[1] === "cycles" ? "cycles" : "ns";

function readTsv(file, cols) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
    const parts = l.split("|");
    const row = { period: Number(parts[0].trim()), samples: Number(parts[1].trim()) };
    if (cols === "sym") {
      const s = parts.slice(2).join("|").trim();
      const m = s.match(/^\[(.)\]\s+(.*)$/);
      row.mode = m && m[1] === "k" ? "k" : "u";
      row.sym = m ? m[2].trim() : s;
    } else {
      row.comm = (parts[2] ?? "").trim();
      row.dso = (parts.slice(3).join("|") ?? "").trim();
    }
    return row;
  });
}
const statsOf = (file) => {
  const t = existsSync(file) ? readFileSync(file, "utf8") : "";
  const n = (re) => Number((t.match(re) ?? [, "0"])[1]);
  return { lost: n(/LOST events:\s+(\d+)/) + n(/LOST_SAMPLES events:\s+(\d+)/), throttle: n(/\bTHROTTLE events:\s+(\d+)/) };
};

function side(turns, pdir, version) {
  const s = { turns: 0, requests: 0, samples: 0, period: 0, sampledPeriod: 0, countedPeriod: 0, k: 0, u: 0, syms: {}, cats: {}, comms: {}, lost: 0, throttle: 0, entries: null, perTurn: [] };
  for (const t of turns.filter((r) => r.version === version)) {
    const base = join(pdir, `${t.pair}-${version}`);
    const syms = readTsv(base + ".sym.tsv", "sym");
    if (syms.length === 0) throw new Error(`${base}.sym.tsv: no rows`);
    const one = { pair: t.pair, requests: t.requests, k: 0, u: 0, cats: {} };
    s.turns++;
    s.requests += t.requests;
    // Scale: CPU 2's counted cycles by mode over the sampled ones (1 where sampling cpu-clock or
    // where the turn has no count), so throttled or lost samples do not shrink a side.
    const sampled = { k: 0, u: 0 };
    for (const r of syms) sampled[r.mode] += r.period;
    const counted = unit === "cycles" && Number.isFinite(t.cpu_cycles_k) && Number.isFinite(t.cpu_cycles_u);
    const scale = { k: counted && sampled.k > 0 ? t.cpu_cycles_k / sampled.k : 1, u: counted && sampled.u > 0 ? t.cpu_cycles_u / sampled.u : 1 };
    s.sampledPeriod += sampled.k + sampled.u;
    s.countedPeriod += counted ? t.cpu_cycles_k + t.cpu_cycles_u : sampled.k + sampled.u;
    for (const r0 of syms) {
      const r = { ...r0, period: r0.period * scale[r0.mode] };
      const key = `[${r.mode}] ${r.sym}`;
      const c = category(r.mode, r.sym);
      const e = (s.syms[key] ??= { mode: r.mode, sym: r.sym, cat: c, period: 0, samples: 0 });
      e.period += r.period;
      e.samples += r.samples;
      s.samples += r.samples;
      s.period += r.period;
      s[r.mode] += r.period;
      one[r.mode] += r.period;
      s.cats[c] = (s.cats[c] ?? 0) + r.period;
      one.cats[c] = (one.cats[c] ?? 0) + r.period;
    }
    for (const r of readTsv(base + ".comm.tsv", "comm")) {
      const key = `${r.comm} (${r.dso})`;
      s.comms[key] = (s.comms[key] ?? 0) + r.period;
    }
    const st = statsOf(base + ".stats.txt");
    s.lost += st.lost;
    s.throttle += st.throttle;
    if (existsSync(base + ".entries.json")) {
      const e = JSON.parse(readFileSync(base + ".entries.json", "utf8"));
      s.entries ??= { period: 0, kernel: 0, user: 0, entries: {}, markers: {}, markerEntries: {}, unparsed: 0 };
      // The same scale by mode as the symbols (entries.mjs reads the same samples).
      const ek = e.kernel > 0 && counted ? t.cpu_cycles_k / e.kernel : 1, eu = e.user > 0 && counted ? t.cpu_cycles_u / e.user : 1;
      s.entries.period += e.kernel * ek + e.user * eu;
      s.entries.kernel += e.kernel * ek;
      s.entries.user += e.user * eu;
      s.entries.unparsed += e.unparsed ?? 0;
      for (const [k2, v] of Object.entries(e.entries)) s.entries.entries[k2] = (s.entries.entries[k2] ?? 0) + v * (k2.endsWith(": user") ? eu : ek);
      for (const [k2, v] of Object.entries(e.markers)) s.entries.markers[k2] = (s.entries.markers[k2] ?? 0) + v * ek;
      for (const [m, byEntry] of Object.entries(e.markerEntries)) {
        const o = (s.entries.markerEntries[m] ??= {});
        for (const [k2, v] of Object.entries(byEntry)) o[k2] = (o[k2] ?? 0) + v * ek;
      }
    }
    s.perTurn.push(one);
  }
  return s;
}

const out = { unit, comparisons: {} };
const lines = [];
const say = (l = "") => lines.push(l);
say(`# Pass A: where CPU 2's ${unit} go, a request (results/margin.md declares the readings)`);
say("");
say(`A is the store with room, B the store off; the same binary and allocator, a fresh start every turn. Figures are ${unit} a request answered, summed over each side's recorded turns, everything sampled on CPU 2. Per-turn reports: profile/<comparison>/.`);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^turns-a-.*\.csv$/.test(f)).sort() : [];
for (const f of files) {
  const name = f.replace(/^turns-|\.csv$/g, "");
  const pdir = join(dir, "profile", name);
  try {
    const [header, ...rows] = readFileSync(join(dir, f), "utf8").trim().split(/\r?\n/);
    const names = header.split(",");
    const turns = rows.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : Number(v)]))).filter((r) => !String(r.pair).startsWith("w"));
    if (turns.length === 0) { say(`\n## ${name}: no recorded turns`); continue; }
    const A = side(turns, pdir, "base");
    const B = side(turns, pdir, "head");
    const per = (s, v) => v / s.requests;
    say("");
    say(`## ${name}: ${A.turns} turns a side, ${A.requests.toLocaleString("en-US")} and ${B.requests.toLocaleString("en-US")} requests answered`);
    say("");
    say(`| a request | A (room) | B (off) | A - B |`);
    say(`| --- | ---: | ---: | ---: |`);
    say(`| all on CPU 2 | ${f0(per(A, A.period))} | ${f0(per(B, B.period))} | ${s0(per(A, A.period) - per(B, B.period))} |`);
    say(`| kernel ([k]) | ${f0(per(A, A.k))} | ${f0(per(B, B.k))} | ${s0(per(A, A.k) - per(B, B.k))} |`);
    say(`| user ([.]) | ${f0(per(A, A.u))} | ${f0(per(B, B.u))} | ${s0(per(A, A.u) - per(B, B.u))} |`);
    say(`| samples (all turns) | ${A.samples.toLocaleString("en-US")} | ${B.samples.toLocaleString("en-US")} | |`);
    say(`| lost / throttle events | ${A.lost} / ${A.throttle} | ${B.lost} / ${B.throttle} | |`);
    say(`| sampled share of CPU 2's counted cycles (scaled up to the count) | ${p1(A.sampledPeriod / A.countedPeriod)} | ${p1(B.sampledPeriod / B.countedPeriod)} | |`);
    const kd = per(A, A.k) - per(B, B.k);
    // Categories, with the per-pair spread of A - B.
    const pairsOf = (s) => Object.fromEntries(s.perTurn.map((t) => [t.pair, t]));
    const pa = pairsOf(A), pb = pairsOf(B);
    const both = Object.keys(pa).filter((p) => pb[p]);
    say("");
    say(`### ${name}: categories (kernel symbols by name, results/margin.md), ${unit} a request`);
    say("");
    say("| category | A | B | A - B | share of the kernel's A - B | A - B by pair, min to max |");
    say("| --- | ---: | ---: | ---: | ---: | --- |");
    const cats = {};
    for (const [c] of [...CATS, ["user"]]) {
      const a = per(A, A.cats[c] ?? 0), b = per(B, B.cats[c] ?? 0);
      const byPair = both.map((p) => (pa[p].cats[c] ?? 0) / pa[p].requests - (pb[p].cats[c] ?? 0) / pb[p].requests);
      cats[c] = { a, b, diff: a - b, share: c === "user" ? NaN : (a - b) / kd, pairMin: Math.min(...byPair), pairMax: Math.max(...byPair) };
      if (a === 0 && b === 0) continue;
      say(`| ${c} | ${f0(a)} | ${f0(b)} | ${s0(a - b)} | ${c === "user" ? "" : p1((a - b) / kd)} | ${s0(cats[c].pairMin)} to ${s0(cats[c].pairMax)} |`);
    }
    // Top 50 a side, and the 50 largest differences.
    const top = (s) => Object.values(s.syms).sort((x, y) => y.period - x.period).slice(0, 50);
    for (const [label, s] of [["A (room)", A], ["B (off)", B]]) {
      say("");
      say(`### ${name}: top 50 symbols, ${label} (perf report --no-children --sort sym, merged over ${s.turns} turns)`);
      say("");
      say(`| # | symbol | ${unit} a request | share | samples | category |`);
      say("| ---: | --- | ---: | ---: | ---: | --- |");
      top(s).forEach((e, i) => say(`| ${i + 1} | [${e.mode}] ${esc(e.sym)} | ${f0(per(s, e.period))} | ${p1(e.period / s.period)} | ${e.samples} | ${e.cat} |`));
    }
    const keys = new Set([...Object.keys(A.syms), ...Object.keys(B.syms)]);
    const diffs = [...keys].map((key) => {
      const e = A.syms[key] ?? B.syms[key];
      const a = per(A, A.syms[key]?.period ?? 0), b = per(B, B.syms[key]?.period ?? 0);
      return { key, mode: e.mode, cat: e.cat, a, b, d: a - b };
    }).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    say("");
    say(`### ${name}: the 50 largest differences A - B, ${unit} a request (kernel A - B in all: ${s0(kd)})`);
    say("");
    say("| # | symbol | A | B | A - B | category |");
    say("| ---: | --- | ---: | ---: | ---: | --- |");
    diffs.slice(0, 50).forEach((e, i) => say(`| ${i + 1} | ${esc(e.key)} | ${f0(e.a)} | ${f0(e.b)} | ${s0(e.d)} | ${e.cat} |`));
    // Commands and objects.
    const comms = [...new Set([...Object.keys(A.comms), ...Object.keys(B.comms)])].map((key) => ({ key, a: per(A, A.comms[key] ?? 0), b: per(B, B.comms[key] ?? 0) })).sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b)).slice(0, 12);
    say("");
    say(`### ${name}: by command (shared object), ${unit} a request`);
    say("");
    say("| command (object) | A | B | A - B |");
    say("| --- | ---: | ---: | ---: |");
    for (const c of comms) say(`| ${esc(c.key)} | ${f0(c.a)} | ${f0(c.b)} | ${s0(c.a - c.b)} |`);
    const result = { mode: name.endsWith("-graph") ? "graph" : "flat", turns: A.turns, sampledShare: { a: A.sampledPeriod / A.countedPeriod, b: B.sampledPeriod / B.countedPeriod }, requests: { a: A.requests, b: B.requests }, all: { a: per(A, A.period), b: per(B, B.period) }, kernel: { a: per(A, A.k), b: per(B, B.k) }, user: { a: per(A, A.u), b: per(B, B.u) }, kernelDiff: kd, categories: cats, lost: A.lost + B.lost, throttle: A.throttle + B.throttle, topDiffs: diffs.slice(0, 50) };
    if (A.entries && B.entries) {
      const ent = [...new Set([...Object.keys(A.entries.entries), ...Object.keys(B.entries.entries)])].map((key) => ({ key, a: per(A, A.entries.entries[key] ?? 0), b: per(B, B.entries.entries[key] ?? 0) })).map((e) => ({ ...e, d: e.a - e.b })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
      say("");
      say(`### ${name}: how the kernel was entered (entries.mjs), the 25 largest differences, ${unit} a request`);
      say("");
      say("| command: entry | A | B | A - B |");
      say("| --- | ---: | ---: | ---: |");
      for (const e of ent.slice(0, 25)) say(`| ${esc(e.key)} | ${f0(e.a)} | ${f0(e.b)} | ${s0(e.d)} |`);
      const ekd = per(A, A.entries.kernel) - per(B, B.entries.kernel);
      const markers = {};
      say("");
      say(`### ${name}: inclusive markers (a sample counts for every marker its kernel chain holds), ${unit} a request; kernel A - B here ${s0(ekd)}`);
      say("");
      say("| marker | A | B | A - B | share of the kernel's A - B |");
      say("| --- | ---: | ---: | ---: | ---: |");
      for (const m of Object.keys(A.entries.markers)) {
        const a = per(A, A.entries.markers[m] ?? 0), b = per(B, B.entries.markers[m] ?? 0);
        markers[m] = { a, b, diff: a - b, share: (a - b) / ekd };
        if (a === 0 && b === 0) continue;
        say(`| ${m} | ${f0(a)} | ${f0(b)} | ${s0(a - b)} | ${p1((a - b) / ekd)} |`);
      }
      const where = {};
      for (const [m, o] of Object.entries(A.entries.markerEntries)) {
        const total = Object.values(o).reduce((x, y) => x + y, 0);
        if (total === 0) continue;
        where[m] = Object.fromEntries(Object.entries(o).map(([e, v]) => [e, v / total]));
        say(`- A's ${m} by entry: ${Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([e, v]) => `${e} ${p1(v / total)}`).join(", ")}`);
      }
      if (A.entries.unparsed + B.entries.unparsed) say(`- perf script lines not parsed: ${A.entries.unparsed + B.entries.unparsed}`);
      // The same by way in alone (every command together), for summary.mjs's readings.
      const byEntry = {};
      for (const e of ent) {
        const way = e.key.slice(e.key.indexOf(": ") + 2);
        const o = (byEntry[way] ??= { a: 0, b: 0, diff: 0 });
        o.a += e.a; o.b += e.b; o.diff += e.d;
      }
      for (const o of Object.values(byEntry)) o.share = o.diff / ekd;
      Object.assign(result, { entriesKernelDiff: ekd, markers, markerWhere: where, entries: ent.slice(0, 25), byEntry });
    }
    out.comparisons[name] = result;
  } catch (e) {
    say(`\n## ${name}: not summarized: ${e.message}`);
  }
}
writeFileSync(join(dir, "profile.json"), JSON.stringify(out));
console.log(lines.join("\n"));