// entries.mjs: corten-run/corten#1824's kit (1824c). Reads `perf script -F comm,tid,period,ip,sym,dso`
// of one call-graph turn on stdin (only kernel frames are read: a user-mode sample has none) and prints
// one JSON object:
//   samples, period            every sample and the sum of their periods
//   user, kernel               the periods of samples taken in user mode (no chain) and in the kernel
//   comms                      period by command (thread name)
//   entries                    period by "<command>: <how the kernel was entered>": "user", "page
//                              fault", "syscall <name>" (the __x64_sys_ function nearest the root;
//                              "syscall entry and exit" where the sample is in the entry code),
//                              "interrupt <vector>", "kernel thread", "idle task" or "other <root
//                              function>"; a softirq run inside one of them stays with it
//   markers                    period of the samples whose chain holds a function a marker names,
//                              anywhere in it (inclusive, as perf report --children counts it)
//   markerEntries              for the markers in BY_ENTRY, their period by entry as above
//   leaves                     period by the sampled kernel function (the chain's first frame)
// The markers and what results/margin.md reads from them are declared there before the run.
import { createInterface } from "node:readline";

const V = "(_noprof)?";
export const MARKERS = {
  "page fault (any)": new RegExp(`^(asm_exc_page_fault|exc_page_fault|handle_mm_fault)$`),
  "huge page fault": new RegExp(`^(do_huge_pmd_anonymous_page|__do_huge_pmd_anonymous_page|vma_alloc_anon_folio_pmd|do_huge_pmd_wp_page)$`),
  "4 KiB anonymous fault": /^do_anonymous_page$/,
  "zeroing (clear_page)": /^(clear_page_erms|clear_page_rep|clear_page_orig|clear_huge_page|folio_zero_user|process_huge_page|clear_subpage|clear_gigantic_page)$/,
  "page allocator": new RegExp(`^(__alloc_pages|__alloc_frozen_pages|alloc_pages_mpol|get_page_from_freelist|vma_alloc_folio|folio_alloc_mpol|__folio_alloc)${V}$`),
  "page freeing": /^(free_unref_page|free_unref_folios|__free_pages|free_pcppages_bulk|__free_pages_ok|free_compound_page|__folio_put|folios_put_refs|release_pages)$/,
  "memcg charge": /^(__mem_cgroup_charge|mem_cgroup_charge|charge_memcg|try_charge_memcg|mem_cgroup_commit_charge|obj_cgroup_charge|__memcg_kmem_charge_page|__memcg_slab_post_alloc_hook)$/,
  "lru add": /^(folio_add_lru|folio_add_lru_vma|folio_batch_move_lru|lru_add|lru_add_fn|lru_gen_add_folio)$/,
  "compaction": /compact|^isolate_migratepages|^isolate_freepages|^migrate_pages$/,
  "khugepaged": /khugepaged|collapse_huge_page|hpage_collapse/,
  "madvise": /^(__x64_sys_madvise|do_madvise|madvise_.*)$/,
  "munmap, mmap, brk": /^__x64_sys_(munmap|mmap|mremap|brk)$/,
  "zap and unmap": /^(zap_page_range_single|zap_pte_range|zap_pmd_range|unmap_page_range|unmap_vmas|unmap_single_vma)$/,
  "split huge page": /split_huge|deferred_split/,
  "TLB flush": /flush_tlb|native_flush_tlb/,
  "softirq": /^(handle_softirqs|__do_softirq|do_softirq|net_rx_action)$/,
  "tcp send": /^(tcp_sendmsg|tcp_sendmsg_locked)$/,
  "tcp receive": /^(tcp_recvmsg|tcp_recvmsg_locked)$/,
  "epoll wait": /^(do_epoll_wait|ep_poll)$/,
  "schedule": /^(__schedule|schedule)$/,
  "futex": /^(__x64_sys_futex|do_futex)$/,
  "slab": new RegExp(`^(kmem_cache_alloc|kmem_cache_alloc_node|__kmalloc|__kmalloc_node|__kmalloc_node_track_caller|kmalloc_reserve|kmem_cache_free|kfree|__slab_alloc|___slab_alloc|__slab_free)${V}$`),
};
const BY_ENTRY = ["zeroing (clear_page)", "page allocator", "memcg charge", "huge page fault", "page fault (any)"];

function entryOf(chain) {
  if (chain.length === 0) return "user";
  const names = chain.map((f) => f.sym);
  const root = names[names.length - 1];
  const has = (re) => names.some((n) => re.test(n));
  if (has(/^(entry_SYSCALL_64\w*|do_syscall_64|syscall_return_via_sysret|entry_SYSRETQ\w*|syscall_exit_to_user_mode\w*)$/) || (root === "clear_bhb_loop" && names.length === 1)) {
    for (let i = names.length - 1; i >= 0; i--) {
      const m = names[i].match(/^__(?:x64|ia32|do)_sys_(\w+)$/);
      if (m) return "syscall " + m[1];
    }
    return "syscall entry and exit";
  }
  if (has(/^asm_exc_page_fault$/)) return "page fault";
  for (let i = names.length - 1; i >= 0; i--) {
    const m = names[i].match(/^asm_sysvec_(\w+)$/);
    if (m) return "interrupt " + m[1];
    if (/^asm_common_interrupt$/.test(names[i])) return "interrupt device";
  }
  if (has(/^(ret_from_fork|ret_from_fork_asm|kthread)$/)) return "kernel thread";
  if (has(/^(secondary_startup_64|start_secondary|common_startup_64|cpu_startup_entry|do_idle)$/)) return "idle task";
  return "other " + root;
}

const out = { samples: 0, period: 0, user: 0, kernel: 0, comms: {}, entries: {}, markers: {}, markerEntries: {}, leaves: {} };
for (const m of Object.keys(MARKERS)) out.markers[m] = 0;
for (const m of BY_ENTRY) out.markerEntries[m] = {};
let cur = null;
const add = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };
function flush() {
  if (!cur) return;
  const { comm, period, chain } = cur;
  out.samples++;
  out.period += period;
  add(out.comms, comm, period);
  const entry = entryOf(chain);
  add(out.entries, `${comm}: ${entry}`, period);
  if (chain.length === 0) out.user += period;
  else {
    out.kernel += period;
    add(out.leaves, chain[0].sym, period);
    for (const [m, re] of Object.entries(MARKERS)) {
      if (chain.some((f) => re.test(f.sym))) {
        out.markers[m] += period;
        if (out.markerEntries[m]) add(out.markerEntries[m], entry, period);
      }
    }
  }
  cur = null;
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let bad = 0;
for await (const line of rl) {
  if (line.trim() === "") { flush(); continue; }
  if (/^\s/.test(line)) {
    const m = line.match(/^\s*([0-9a-f]+)\s+(.*?)\s+\((.*)\)\s*$/);
    if (!m || !cur) { bad++; continue; }
    // Kernel frames only (a kernel address): with plain -g a user-mode sample has a user chain.
    if (/^ffff/.test(m[1])) cur.chain.push({ sym: m[2].replace(/\+0x[0-9a-f]+$/, ""), dso: m[3] });
    continue;
  }
  flush();
  const h = line.match(/^(.*?)\s+(\d+)\s+(\d+)\s*$/);
  if (!h) { bad++; continue; }
  cur = { comm: h[1].trim(), period: Number(h[3]), chain: [] };
}
flush();
out.unparsed = bad;
if (out.samples === 0) { console.error("entries.mjs: no samples on stdin"); process.exit(1); }
console.log(JSON.stringify(out));