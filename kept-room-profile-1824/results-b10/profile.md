# Pass A: where CPU 2's cycles go, a request (results/margin.md declares the readings)

A is the store with room, B the store off; the same binary and allocator, a fresh start every turn. Figures are cycles a request answered, summed over each side's recorded turns, everything sampled on CPU 2. Per-turn reports: profile/<comparison>/.

## a-gl-flat: 5 turns a side, 545,750 and 840,305 requests answered

| a request | A (room) | B (off) | A - B |
| --- | ---: | ---: | ---: |
| all on CPU 2 | 87,196 | 56,936 | +30,260 |
| kernel ([k]) | 45,512 | 28,928 | +16,584 |
| user ([.]) | 41,684 | 28,008 | +13,676 |
| samples (all turns) | 44,869 | 45,125 | |
| lost / throttle events | 0 / 0 | 0 / 0 | |
| sampled share of CPU 2's counted cycles (scaled up to the count) | 94.3% | 94.3% | |

### a-gl-flat: categories (kernel symbols by name, results/margin.md), cycles a request

| category | A | B | A - B | share of the kernel's A - B | A - B by pair, min to max |
| --- | ---: | ---: | ---: | ---: | --- |
| zeroing | 6,948 | 2,254 | +4,693 | 28.3% | +4,208 to +5,278 |
| compaction and khugepaged | 2 | 0 | +2 | 0.0% | +0 to +9 |
| memcg | 1,715 | 911 | +804 | 4.8% | +711 to +924 |
| page allocator | 1,592 | 414 | +1,178 | 7.1% | +991 to +1,458 |
| fault handling | 5,158 | 1 | +5,156 | 31.1% | +5,101 to +5,195 |
| unmapping and TLB | 405 | 275 | +131 | 0.8% | +90 to +160 |
| scheduler and wakeups | 1,353 | 941 | +412 | 2.5% | +121 to +589 |
| network | 15,401 | 13,590 | +1,811 | 10.9% | +1,305 to +2,255 |
| copies to and from user | 2,592 | 2,030 | +563 | 3.4% | +377 to +664 |
| epoll and syscall entry | 3,620 | 3,458 | +162 | 1.0% | -128 to +430 |
| slab | 943 | 947 | -4 | -0.0% | -119 to +138 |
| interrupts, timers and RCU | 2,061 | 1,487 | +574 | 3.5% | +342 to +726 |
| idle | 8 | 1 | +6 | 0.0% | +0 to +12 |
| locks | 42 | 153 | -111 | -0.7% | -184 to -3 |
| other kernel | 3,671 | 2,465 | +1,207 | 7.3% | +871 to +1,580 |
| user | 41,684 | 28,008 | +13,676 |  | +10,467 to +15,966 |

### a-gl-flat: top 50 symbols, A (room) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 6,948 | 8.0% | 3633 | zeroing |
| 2 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 3,026 | 3.5% | 1528 | user |
| 3 | [u] malloc | 2,094 | 2.4% | 1058 | user |
| 4 | [k] rep_movs_alternative | 1,870 | 2.1% | 978 | copies to and from user |
| 5 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,671 | 1.9% | 845 | user |
| 6 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,566 | 1.8% | 791 | user |
| 7 | [k] asm_exc_page_fault | 1,470 | 1.7% | 769 | fault handling |
| 8 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 931 | 1.1% | 470 | user |
| 9 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 924 | 1.1% | 467 | user |
| 10 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 858 | 1.0% | 434 | user |
| 11 | [k] _raw_spin_lock_irqsave | 792 | 0.9% | 414 | network |
| 12 | [k] tcp_sendmsg_locked | 743 | 0.9% | 389 | network |
| 13 | [u] cfree | 723 | 0.8% | 365 | user |
| 14 | [k] sync_regs | 685 | 0.8% | 358 | fault handling |
| 15 | [k] tcp_ack | 660 | 0.8% | 345 | network |
| 16 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 635 | 0.7% | 321 | user |
| 17 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 629 | 0.7% | 318 | user |
| 18 | [k] skb_release_data | 604 | 0.7% | 316 | network |
| 19 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 565 | 0.6% | 286 | user |
| 20 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 553 | 0.6% | 279 | user |
| 21 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 540 | 0.6% | 273 | user |
| 22 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 504 | 0.6% | 255 | user |
| 23 | [k] __list_del_entry_valid_or_report | 503 | 0.6% | 263 | other kernel |
| 24 | [u] 0x00000000000a1e34 | 479 | 0.5% | 242 | user |
| 25 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 477 | 0.5% | 241 | user |
| 26 | [k] __inet_lookup_established | 465 | 0.5% | 243 | network |
| 27 | [k] native_write_msr | 453 | 0.5% | 237 | other kernel |
| 28 | [k] __tcp_transmit_skb | 443 | 0.5% | 232 | network |
| 29 | [k] _raw_spin_lock | 422 | 0.5% | 221 | network |
| 30 | [k] pvclock_clocksource_read_nowd | 415 | 0.5% | 217 | interrupts, timers and RCU |
| 31 | [k] __mod_memcg_state | 386 | 0.4% | 202 | memcg |
| 32 | [k] vfs_writev | 384 | 0.4% | 201 | epoll and syscall entry |
| 33 | [k] net_rx_action | 380 | 0.4% | 199 | network |
| 34 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 377 | 0.4% | 191 | user |
| 35 | [k] _raw_spin_lock_bh | 369 | 0.4% | 193 | network |
| 36 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 358 | 0.4% | 181 | user |
| 37 | [k] __rcu_read_unlock | 354 | 0.4% | 185 | interrupts, timers and RCU |
| 38 | [k] try_to_wake_up | 350 | 0.4% | 183 | scheduler and wakeups |
| 39 | [k] do_anonymous_page | 349 | 0.4% | 183 | fault handling |
| 40 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 348 | 0.4% | 176 | user |
| 41 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 344 | 0.4% | 174 | user |
| 42 | [k] __dev_queue_xmit | 344 | 0.4% | 180 | network |
| 43 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 344 | 0.4% | 174 | user |
| 44 | [k] __handle_mm_fault | 342 | 0.4% | 179 | fault handling |
| 45 | [k] tcp_recvmsg_locked | 342 | 0.4% | 179 | network |
| 46 | [u] 0x0000000000000d9e | 341 | 0.4% | 172 | user |
| 47 | [k] clear_bhb_loop | 338 | 0.4% | 177 | epoll and syscall entry |
| 48 | [k] __rmqueue_pcplist | 335 | 0.4% | 175 | page allocator |
| 49 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 320 | 0.4% | 162 | user |
| 50 | [k] ep_poll_callback | 317 | 0.4% | 166 | epoll and syscall entry |

### a-gl-flat: top 50 symbols, B (off) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,805 | 4.9% | 2212 | user |
| 2 | [k] clear_page_erms | 2,254 | 4.0% | 1797 | zeroing |
| 3 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,420 | 2.5% | 1120 | user |
| 4 | [k] rep_movs_alternative | 1,351 | 2.4% | 1076 | copies to and from user |
| 5 | [u] malloc | 1,007 | 1.8% | 794 | user |
| 6 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 790 | 1.4% | 623 | user |
| 7 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 708 | 1.2% | 559 | user |
| 8 | [k] _raw_spin_lock_irqsave | 707 | 1.2% | 562 | network |
| 9 | [k] tcp_sendmsg_locked | 703 | 1.2% | 560 | network |
| 10 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 693 | 1.2% | 546 | user |
| 11 | [k] tcp_ack | 627 | 1.1% | 499 | network |
| 12 | [u] cfree | 601 | 1.1% | 474 | user |
| 13 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 594 | 1.0% | 468 | user |
| 14 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 589 | 1.0% | 465 | user |
| 15 | [k] skb_release_data | 553 | 1.0% | 441 | network |
| 16 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 522 | 0.9% | 411 | user |
| 17 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 476 | 0.8% | 375 | user |
| 18 | [k] __tcp_transmit_skb | 470 | 0.8% | 374 | network |
| 19 | [k] pvclock_clocksource_read_nowd | 454 | 0.8% | 361 | interrupts, timers and RCU |
| 20 | [k] __inet_lookup_established | 452 | 0.8% | 360 | network |
| 21 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 438 | 0.8% | 346 | user |
| 22 | [k] net_rx_action | 424 | 0.7% | 338 | network |
| 23 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 414 | 0.7% | 327 | user |
| 24 | [k] native_write_msr | 386 | 0.7% | 307 | other kernel |
| 25 | [k] vfs_writev | 382 | 0.7% | 305 | epoll and syscall entry |
| 26 | [k] __mod_memcg_state | 380 | 0.7% | 303 | memcg |
| 27 | [k] _raw_spin_lock_bh | 380 | 0.7% | 303 | network |
| 28 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 356 | 0.6% | 281 | user |
| 29 | [k] _raw_spin_lock | 356 | 0.6% | 283 | network |
| 30 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 354 | 0.6% | 279 | user |
| 31 | [k] __dev_queue_xmit | 345 | 0.6% | 275 | network |
| 32 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 316 | 0.6% | 249 | user |
| 33 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 306 | 0.5% | 241 | user |
| 34 | [k] clear_bhb_loop | 298 | 0.5% | 237 | epoll and syscall entry |
| 35 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 285 | 0.5% | 225 | user |
| 36 | [k] ep_poll_callback | 281 | 0.5% | 224 | epoll and syscall entry |
| 37 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 279 | 0.5% | 220 | user |
| 38 | [k] aa_sk_perm | 262 | 0.5% | 209 | epoll and syscall entry |
| 39 | [k] tcp_recvmsg_locked | 261 | 0.5% | 208 | network |
| 40 | [k] kmem_cache_alloc_node_noprof | 260 | 0.5% | 207 | slab |
| 41 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 259 | 0.5% | 204 | user |
| 42 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 259 | 0.5% | 204 | user |
| 43 | [k] fdget | 253 | 0.4% | 201 | epoll and syscall entry |
| 44 | [u] _RNvXsr_NtCsdztPvThAM6J_4http3uriNtB5_3UriNtNtCs8uuN1nrGffB_4core5clone5Clone5clone | 249 | 0.4% | 196 | user |
| 45 | [k] memset_orig | 246 | 0.4% | 196 | other kernel |
| 46 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 243 | 0.4% | 192 | user |
| 47 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 238 | 0.4% | 188 | user |
| 48 | [u] 0x000000000009ebfb | 234 | 0.4% | 183 | user |
| 49 | [k] __wake_up_common | 231 | 0.4% | 185 | scheduler and wakeups |
| 50 | [k] __ip_queue_xmit | 229 | 0.4% | 182 | network |

### a-gl-flat: the 50 largest differences A - B, cycles a request (kernel A - B in all: +16,584)

| # | symbol | A | B | A - B | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 6,948 | 2,254 | +4,693 | zeroing |
| 2 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,671 | 0 | +1,671 | user |
| 3 | [k] asm_exc_page_fault | 1,470 | 0 | +1,470 | fault handling |
| 4 | [u] malloc | 2,094 | 1,007 | +1,087 | user |
| 5 | [k] sync_regs | 685 | 1 | +684 | fault handling |
| 6 | [k] rep_movs_alternative | 1,870 | 1,351 | +519 | copies to and from user |
| 7 | [u] 0x00000000000a1e34 | 479 | 0 | +479 | user |
| 8 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 477 | 0 | +477 | user |
| 9 | [k] do_anonymous_page | 349 | 0 | +349 | fault handling |
| 10 | [k] __handle_mm_fault | 342 | 0 | +342 | fault handling |
| 11 | [k] __list_del_entry_valid_or_report | 503 | 181 | +322 | other kernel |
| 12 | [u] 0x0000000000000d9e | 341 | 51 | +290 | user |
| 13 | [k] __rmqueue_pcplist | 335 | 58 | +277 | page allocator |
| 14 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 931 | 693 | +239 | user |
| 15 | [u] 0x000000000009ebfb | 0 | 234 | -234 | user |
| 16 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 3,026 | 2,805 | +221 | user |
| 17 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept6varies | 220 | 0 | +220 | user |
| 18 | [k] __mod_memcg_lruvec_state | 218 | 0 | +218 | memcg |
| 19 | [k] get_page_from_freelist | 267 | 62 | +205 | page allocator |
| 20 | [k] handle_mm_fault | 201 | 0 | +201 | fault handling |
| 21 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked6missed | 193 | 0 | +193 | user |
| 22 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 504 | 316 | +188 | user |
| 23 | [k] __rcu_read_lock | 298 | 112 | +186 | interrupts, timers and RCU |
| 24 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes20promotable_even_drop | 185 | 1 | +184 | user |
| 25 | [u] 0x00000000000a1e38 | 176 | 0 | +176 | user |
| 26 | [k] mas_walk | 172 | 0 | +172 | fault handling |
| 27 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 171 | 0 | +171 | user |
| 28 | [k] __alloc_pages_noprof | 206 | 35 | +171 | page allocator |
| 29 | [k] __lruvec_stat_mod_folio | 164 | 0 | +164 | memcg |
| 30 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 635 | 476 | +159 | user |
| 31 | [k] lru_gen_add_folio | 159 | 0 | +159 | fault handling |
| 32 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 858 | 708 | +150 | user |
| 33 | [k] __pte_offset_map_lock | 149 | 0 | +149 | fault handling |
| 34 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,566 | 1,420 | +145 | user |
| 35 | [k] try_to_wake_up | 350 | 211 | +140 | scheduler and wakeups |
| 36 | [k] native_queued_spin_lock_slowpath | 13 | 150 | -136 | locks |
| 37 | [u] 0x0000000000172be5 | 140 | 5 | +135 | user |
| 38 | [k] __rcu_read_unlock | 354 | 219 | +134 | interrupts, timers and RCU |
| 39 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 924 | 790 | +134 | user |
| 40 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 344 | 216 | +128 | user |
| 41 | [u] 0x0000000000172bf3 | 144 | 17 | +128 | user |
| 42 | [u] 0x00000000000a01d0 | 184 | 57 | +127 | user |
| 43 | [k] folio_add_new_anon_rmap | 124 | 0 | +124 | fault handling |
| 44 | [u] 0x00000000000a16a0 | 125 | 1 | +124 | user |
| 45 | [u] cfree | 723 | 601 | +123 | user |
| 46 | [k] get_vma_policy | 123 | 0 | +123 | page allocator |
| 47 | [u] _RNvXs3_NtNtCs8uuN1nrGffB_4core4hash3sipINtB5_6HasherNtB5_11Sip13RoundsENtB7_6Hasher5writeCs2Sdwwla2uzU_6corten | 122 | 0 | +122 | user |
| 48 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page13page_or_errorNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedB1a_E0s_0E0CskjsZcOxyxTu_5probe | 284 | 164 | +121 | user |
| 49 | [k] lru_add | 120 | 0 | +120 | fault handling |
| 50 | [k] lock_vma_under_rcu | 119 | 0 | +119 | fault handling |

### a-gl-flat: by command (shared object), cycles a request

| command (object) | A | B | A - B |
| --- | ---: | ---: | ---: |
| main ([kernel.kallsyms]) | 43,575 | 27,396 | +16,179 |
| main (main) | 28,519 | 20,572 | +7,946 |
| main (libc.so.6) | 9,537 | 5,565 | +3,973 |
| main ([vdso]) | 550 | 142 | +408 |
| kworker/2:2-eve ([kernel.kallsyms]) | 15 | 11 | +4 |
| swapper ([kernel.kallsyms]) | 7 | 8 | -1 |
| migration/2 ([kernel.kallsyms]) | 4 | 0 | +4 |
| ksoftirqd/2 ([kernel.kallsyms]) | 4 | 2 | +1 |
| perf ([kernel.kallsyms]) | 2 | 2 | -1 |
| kworker/2:2-mm_ ([kernel.kallsyms]) | 2 | 1 | +1 |
| kworker/u35:2-w ([kernel.kallsyms]) | 2 | 0 | +2 |
| kworker/u35:1-e ([kernel.kallsyms]) | 0 | 1 | -1 |

## a-gl-graph: 5 turns a side, 545,936 and 854,634 requests answered

| a request | A (room) | B (off) | A - B |
| --- | ---: | ---: | ---: |
| all on CPU 2 | 86,719 | 55,741 | +30,978 |
| kernel ([k]) | 45,369 | 28,618 | +16,751 |
| user ([.]) | 41,350 | 27,123 | +14,226 |
| samples (all turns) | 44,962 | 45,074 | |
| lost / throttle events | 0 / 0 | 0 / 0 | |
| sampled share of CPU 2's counted cycles (scaled up to the count) | 95.0% | 94.6% | |

### a-gl-graph: categories (kernel symbols by name, results/margin.md), cycles a request

| category | A | B | A - B | share of the kernel's A - B | A - B by pair, min to max |
| --- | ---: | ---: | ---: | ---: | --- |
| zeroing | 7,048 | 2,223 | +4,825 | 28.8% | +4,599 to +5,040 |
| compaction and khugepaged | 8 | 0 | +8 | 0.0% | +0 to +10 |
| memcg | 1,718 | 922 | +795 | 4.7% | +617 to +991 |
| page allocator | 1,643 | 351 | +1,293 | 7.7% | +1,154 to +1,425 |
| fault handling | 5,022 | 1 | +5,021 | 30.0% | +4,628 to +5,375 |
| unmapping and TLB | 388 | 260 | +128 | 0.8% | +49 to +206 |
| scheduler and wakeups | 1,262 | 948 | +314 | 1.9% | +110 to +508 |
| network | 15,227 | 13,493 | +1,734 | 10.4% | +1,269 to +2,527 |
| copies to and from user | 2,464 | 2,038 | +426 | 2.5% | +75 to +910 |
| epoll and syscall entry | 3,650 | 3,306 | +345 | 2.1% | +164 to +499 |
| slab | 1,016 | 957 | +59 | 0.4% | -201 to +300 |
| interrupts, timers and RCU | 2,147 | 1,526 | +621 | 3.7% | +384 to +1,015 |
| idle | 4 | 0 | +4 | 0.0% | +0 to +10 |
| locks | 42 | 190 | -149 | -0.9% | -191 to -118 |
| other kernel | 3,730 | 2,403 | +1,327 | 7.9% | +749 to +1,594 |
| user | 41,350 | 27,123 | +14,226 |  | +13,563 to +15,363 |

### a-gl-graph: top 50 symbols, A (room) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 7,048 | 8.1% | 3709 | zeroing |
| 2 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,979 | 3.4% | 1519 | user |
| 3 | [u] malloc | 2,153 | 2.5% | 1098 | user |
| 4 | [k] rep_movs_alternative | 1,765 | 2.0% | 929 | copies to and from user |
| 5 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,634 | 1.9% | 833 | user |
| 6 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,616 | 1.9% | 824 | user |
| 7 | [k] asm_exc_page_fault | 1,493 | 1.7% | 786 | fault handling |
| 8 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 945 | 1.1% | 482 | user |
| 9 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 835 | 1.0% | 426 | user |
| 10 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 817 | 0.9% | 417 | user |
| 11 | [k] _raw_spin_lock_irqsave | 802 | 0.9% | 422 | network |
| 12 | [u] cfree | 757 | 0.9% | 386 | user |
| 13 | [k] tcp_sendmsg_locked | 716 | 0.8% | 377 | network |
| 14 | [k] tcp_ack | 680 | 0.8% | 358 | network |
| 15 | [k] sync_regs | 673 | 0.8% | 354 | fault handling |
| 16 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 663 | 0.8% | 338 | user |
| 17 | [k] pvclock_clocksource_read_nowd | 612 | 0.7% | 322 | interrupts, timers and RCU |
| 18 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 574 | 0.7% | 293 | user |
| 19 | [k] __inet_lookup_established | 574 | 0.7% | 302 | network |
| 20 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 563 | 0.6% | 287 | user |
| 21 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 557 | 0.6% | 284 | user |
| 22 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 541 | 0.6% | 276 | user |
| 23 | [k] __tcp_transmit_skb | 540 | 0.6% | 284 | network |
| 24 | [k] skb_release_data | 524 | 0.6% | 276 | network |
| 25 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 516 | 0.6% | 263 | user |
| 26 | [k] native_write_msr | 471 | 0.5% | 248 | other kernel |
| 27 | [k] __list_del_entry_valid_or_report | 456 | 0.5% | 240 | other kernel |
| 28 | [k] __dev_queue_xmit | 447 | 0.5% | 235 | network |
| 29 | [u] 0x00000000000a1e34 | 432 | 0.5% | 220 | user |
| 30 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 430 | 0.5% | 219 | user |
| 31 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 402 | 0.5% | 205 | user |
| 32 | [k] net_rx_action | 390 | 0.4% | 205 | network |
| 33 | [k] _raw_spin_lock_bh | 384 | 0.4% | 202 | network |
| 34 | [k] vfs_writev | 369 | 0.4% | 194 | epoll and syscall entry |
| 35 | [k] __mod_memcg_state | 355 | 0.4% | 187 | memcg |
| 36 | [k] _raw_spin_lock | 353 | 0.4% | 186 | network |
| 37 | [k] __rmqueue_pcplist | 350 | 0.4% | 184 | page allocator |
| 38 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 349 | 0.4% | 178 | user |
| 39 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 347 | 0.4% | 177 | user |
| 40 | [k] __handle_mm_fault | 344 | 0.4% | 181 | fault handling |
| 41 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 343 | 0.4% | 175 | user |
| 42 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 341 | 0.4% | 174 | user |
| 43 | [u] 0x0000000000000d9e | 339 | 0.4% | 173 | user |
| 44 | [k] __rcu_read_unlock | 334 | 0.4% | 176 | interrupts, timers and RCU |
| 45 | [k] do_anonymous_page | 321 | 0.4% | 169 | fault handling |
| 46 | [k] tcp_recvmsg_locked | 319 | 0.4% | 168 | network |
| 47 | [k] aa_sk_perm | 317 | 0.4% | 167 | epoll and syscall entry |
| 48 | [k] __ip_queue_xmit | 314 | 0.4% | 165 | network |
| 49 | [k] ep_poll_callback | 314 | 0.4% | 165 | epoll and syscall entry |
| 50 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 302 | 0.3% | 154 | user |

### a-gl-graph: top 50 symbols, B (off) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,734 | 4.9% | 2200 | user |
| 2 | [k] clear_page_erms | 2,223 | 4.0% | 1805 | zeroing |
| 3 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,433 | 2.6% | 1154 | user |
| 4 | [k] rep_movs_alternative | 1,343 | 2.4% | 1090 | copies to and from user |
| 5 | [u] malloc | 1,004 | 1.8% | 808 | user |
| 6 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 803 | 1.4% | 647 | user |
| 7 | [k] tcp_sendmsg_locked | 789 | 1.4% | 641 | network |
| 8 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 780 | 1.4% | 628 | user |
| 9 | [k] _raw_spin_lock_irqsave | 708 | 1.3% | 575 | network |
| 10 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 680 | 1.2% | 547 | user |
| 11 | [u] cfree | 634 | 1.1% | 511 | user |
| 12 | [k] skb_release_data | 598 | 1.1% | 486 | network |
| 13 | [k] tcp_ack | 592 | 1.1% | 480 | network |
| 14 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 549 | 1.0% | 441 | user |
| 15 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 522 | 0.9% | 420 | user |
| 16 | [k] pvclock_clocksource_read_nowd | 507 | 0.9% | 412 | interrupts, timers and RCU |
| 17 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 485 | 0.9% | 390 | user |
| 18 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 471 | 0.8% | 379 | user |
| 19 | [k] __tcp_transmit_skb | 467 | 0.8% | 380 | network |
| 20 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 458 | 0.8% | 369 | user |
| 21 | [k] __inet_lookup_established | 437 | 0.8% | 355 | network |
| 22 | [k] net_rx_action | 402 | 0.7% | 327 | network |
| 23 | [k] __mod_memcg_state | 394 | 0.7% | 320 | memcg |
| 24 | [k] _raw_spin_lock_bh | 389 | 0.7% | 316 | network |
| 25 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 388 | 0.7% | 312 | user |
| 26 | [k] native_write_msr | 381 | 0.7% | 310 | other kernel |
| 27 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 368 | 0.7% | 297 | user |
| 28 | [k] __dev_queue_xmit | 357 | 0.6% | 290 | network |
| 29 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 354 | 0.6% | 284 | user |
| 30 | [k] vfs_writev | 309 | 0.6% | 251 | epoll and syscall entry |
| 31 | [k] tcp_recvmsg_locked | 309 | 0.6% | 251 | network |
| 32 | [k] _raw_spin_lock | 301 | 0.5% | 244 | network |
| 33 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 294 | 0.5% | 236 | user |
| 34 | [k] clear_bhb_loop | 292 | 0.5% | 237 | epoll and syscall entry |
| 35 | [k] aa_sk_perm | 288 | 0.5% | 234 | epoll and syscall entry |
| 36 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 287 | 0.5% | 231 | user |
| 37 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 278 | 0.5% | 224 | user |
| 38 | [k] ep_poll_callback | 266 | 0.5% | 216 | epoll and syscall entry |
| 39 | [k] __wake_up_common | 265 | 0.5% | 215 | scheduler and wakeups |
| 40 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 265 | 0.5% | 213 | user |
| 41 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 257 | 0.5% | 207 | user |
| 42 | [k] kmem_cache_alloc_node_noprof | 256 | 0.5% | 208 | slab |
| 43 | [k] fdget | 253 | 0.5% | 205 | epoll and syscall entry |
| 44 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 251 | 0.4% | 202 | user |
| 45 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 250 | 0.4% | 201 | user |
| 46 | [u] _RNvXsr_NtCsdztPvThAM6J_4http3uriNtB5_3UriNtNtCs8uuN1nrGffB_4core5clone5Clone5clone | 244 | 0.4% | 197 | user |
| 47 | [k] __rcu_read_unlock | 239 | 0.4% | 194 | interrupts, timers and RCU |
| 48 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 235 | 0.4% | 189 | user |
| 49 | [k] memset_orig | 224 | 0.4% | 182 | other kernel |
| 50 | [k] tcp_rcv_established | 223 | 0.4% | 181 | network |

### a-gl-graph: the 50 largest differences A - B, cycles a request (kernel A - B in all: +16,751)

| # | symbol | A | B | A - B | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 7,048 | 2,223 | +4,825 | zeroing |
| 2 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,634 | 0 | +1,634 | user |
| 3 | [k] asm_exc_page_fault | 1,493 | 0 | +1,493 | fault handling |
| 4 | [u] malloc | 2,153 | 1,004 | +1,149 | user |
| 5 | [k] sync_regs | 673 | 1 | +671 | fault handling |
| 6 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 516 | 0 | +516 | user |
| 7 | [u] 0x00000000000a1e34 | 432 | 0 | +432 | user |
| 8 | [k] rep_movs_alternative | 1,765 | 1,343 | +422 | copies to and from user |
| 9 | [k] __handle_mm_fault | 344 | 0 | +344 | fault handling |
| 10 | [k] do_anonymous_page | 321 | 0 | +321 | fault handling |
| 11 | [k] __rmqueue_pcplist | 350 | 56 | +294 | page allocator |
| 12 | [u] 0x0000000000000d9e | 339 | 47 | +292 | user |
| 13 | [k] __list_del_entry_valid_or_report | 456 | 210 | +246 | other kernel |
| 14 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,979 | 2,734 | +246 | user |
| 15 | [k] __mod_memcg_lruvec_state | 230 | 0 | +230 | memcg |
| 16 | [k] mas_walk | 215 | 0 | +215 | fault handling |
| 17 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept6varies | 210 | 0 | +210 | user |
| 18 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 663 | 458 | +205 | user |
| 19 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 202 | 0 | +202 | user |
| 20 | [k] __alloc_pages_noprof | 209 | 17 | +192 | page allocator |
| 21 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,616 | 1,433 | +183 | user |
| 22 | [u] 0x00000000000a1e38 | 182 | 0 | +182 | user |
| 23 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked6missed | 181 | 0 | +181 | user |
| 24 | [k] get_page_from_freelist | 228 | 54 | +174 | page allocator |
| 25 | [k] native_queued_spin_lock_slowpath | 11 | 183 | -172 | locks |
| 26 | [k] handle_mm_fault | 169 | 0 | +169 | fault handling |
| 27 | [k] __lruvec_stat_mod_folio | 165 | 0 | +165 | memcg |
| 28 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 945 | 780 | +164 | user |
| 29 | [u] 0x00000000000a01d0 | 216 | 59 | +157 | user |
| 30 | [k] lru_gen_add_folio | 152 | 0 | +152 | fault handling |
| 31 | [k] __pte_offset_map_lock | 142 | 0 | +142 | fault handling |
| 32 | [u] 0x000000000009ebfb | 0 | 139 | -139 | user |
| 33 | [k] arch_exit_to_user_mode_prepare.isra.0 | 243 | 105 | +138 | other kernel |
| 34 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 817 | 680 | +138 | user |
| 35 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 402 | 265 | +137 | user |
| 36 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 298 | 161 | +137 | user |
| 37 | [k] __inet_lookup_established | 574 | 437 | +137 | network |
| 38 | [k] get_vma_policy | 135 | 0 | +135 | page allocator |
| 39 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept8count_of.llvm.8612054359066671192 | 133 | 0 | +133 | user |
| 40 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes20promotable_even_drop | 135 | 9 | +127 | user |
| 41 | [u] 0x00000000000a16a0 | 126 | 2 | +123 | user |
| 42 | [u] cfree | 757 | 634 | +123 | user |
| 43 | [k] __rcu_read_lock | 239 | 118 | +121 | interrupts, timers and RCU |
| 44 | [k] available_idle_cpu | 279 | 164 | +116 | other kernel |
| 45 | [u] 0x0000000000172be5 | 124 | 10 | +114 | user |
| 46 | [u] 0x00000000000a16b4 | 112 | 0 | +112 | user |
| 47 | [k] prep_new_page | 234 | 123 | +111 | page allocator |
| 48 | [u] 0x0000000000172bf3 | 118 | 9 | +109 | user |
| 49 | [u] _RNvXs3_NtNtCs8uuN1nrGffB_4core4hash3sipINtB5_6HasherNtB5_11Sip13RoundsENtB7_6Hasher5writeCs2Sdwwla2uzU_6corten | 108 | 0 | +108 | user |
| 50 | [k] __cgroup_rstat_updated | 160 | 53 | +107 | memcg |

### a-gl-graph: by command (shared object), cycles a request

| command (object) | A | B | A - B |
| --- | ---: | ---: | ---: |
| main ([kernel.kallsyms]) | 43,694 | 27,184 | +16,510 |
| main (main) | 28,425 | 20,309 | +8,115 |
| main (libc.so.6) | 9,596 | 5,110 | +4,487 |
| main ([vdso]) | 603 | 121 | +482 |
| kworker/2:2-eve ([kernel.kallsyms]) | 22 | 7 | +15 |
| kworker/2:2-mm_ ([kernel.kallsyms]) | 7 | 2 | +5 |
| swapper ([kernel.kallsyms]) | 5 | 2 | +3 |
| perf ([kernel.kallsyms]) | 2 | 2 | -1 |
| corten-clock ([kernel.kallsyms]) | 2 | 0 | +2 |
| ksoftirqd/2 ([kernel.kallsyms]) | 2 | 1 | +1 |
| kworker/u35:3-w ([kernel.kallsyms]) | 0 | 1 | -1 |
| perf (perf) | 0 | 1 | -1 |

### a-gl-graph: how the kernel was entered (entries.mjs), the 25 largest differences, cycles a request

| command: entry | A | B | A - B |
| --- | ---: | ---: | ---: |
| main: user | 41,350 | 27,122 | +14,228 |
| main: page fault | 13,337 | 0 | +13,337 |
| main: syscall entry and exit | 27,485 | 24,843 | +2,641 |
| main: syscall brk | 517 | 0 | +517 |
| main: interrupt apic_timer_interrupt | 95 | 43 | +52 |
| main: syscall epoll_wait | 701 | 650 | +51 |
| main: other error_entry | 48 | 0 | +48 |
| main: other __irqentry_text_end | 30 | 0 | +30 |
| main: syscall recvfrom | 2,999 | 2,972 | +27 |
| kworker/2:2-eve: kernel thread | 23 | 7 | +15 |
| main: other error_return | 8 | 0 | +8 |
| main: syscall close | 10 | 4 | +6 |
| kworker/2:2-mm_: kernel thread | 8 | 2 | +5 |
| main: syscall munmap | 4 | 0 | +4 |
| main: syscall epoll_ctl | 6 | 2 | +3 |
| swapper: interrupt apic_timer_interrupt | 4 | 1 | +3 |
| main: other early_xen_iret_patch | 2 | 0 | +2 |
| perf: syscall sched_setaffinity | 2 | 0 | +2 |
| corten-clock: syscall clock_nanosleep | 2 | 0 | +2 |
| main: syscall shutdown | 2 | 0 | +2 |
| main: syscall writev | 46 | 44 | +1 |
| perf: user | 0 | 1 | -1 |
| perf: page fault | 0 | 1 | -1 |
| main: other __switch_to | 0 | 1 | -1 |
| kworker/u35:3-w: kernel thread | 0 | 1 | -1 |

### a-gl-graph: inclusive markers (a sample counts for every marker its kernel chain holds), cycles a request; kernel A - B here +16,751

| marker | A | B | A - B | share of the kernel's A - B |
| --- | ---: | ---: | ---: | ---: |
| page fault (any) | 13,337 | 1 | +13,336 | 79.6% |
| huge page fault | 25 | 0 | +25 | 0.1% |
| 4 KiB anonymous fault | 9,212 | 0 | +9,212 | 55.0% |
| zeroing (clear_page) | 7,065 | 2,224 | +4,841 | 28.9% |
| page allocator | 8,927 | 2,571 | +6,355 | 37.9% |
| page freeing | 268 | 106 | +162 | 1.0% |
| memcg charge | 369 | 211 | +158 | 0.9% |
| lru add | 589 | 0 | +589 | 3.5% |
| khugepaged | 8 | 0 | +8 | 0.0% |
| munmap, mmap, brk | 10 | 0 | +10 | 0.1% |
| zap and unmap | 2 | 0 | +2 | 0.0% |
| softirq | 12,774 | 11,160 | +1,613 | 9.6% |
| tcp send | 24,372 | 21,911 | +2,461 | 14.7% |
| tcp receive | 2,261 | 2,292 | -30 | -0.2% |
| epoll wait | 699 | 648 | +51 | 0.3% |
| schedule | 11 | 3 | +9 | 0.1% |
| slab | 1,250 | 1,130 | +121 | 0.7% |
- A's zeroing (clear_page) by entry: page fault 72.2%, syscall entry and exit 27.8%
- A's page allocator by entry: page fault 74.9%, syscall entry and exit 25.1%
- A's memcg charge by entry: page fault 54.1%, syscall entry and exit 45.9%
- A's huge page fault by entry: page fault 100.0%
- A's page fault (any) by entry: page fault 100.0%

## a-je-flat: 5 turns a side, 605,840 and 879,895 requests answered

| a request | A (room) | B (off) | A - B |
| --- | ---: | ---: | ---: |
| all on CPU 2 | 78,984 | 54,738 | +24,246 |
| kernel ([k]) | 39,099 | 28,487 | +10,612 |
| user ([.]) | 39,885 | 26,251 | +13,634 |
| samples (all turns) | 44,919 | 45,139 | |
| lost / throttle events | 0 / 0 | 0 / 0 | |
| sampled share of CPU 2's counted cycles (scaled up to the count) | 93.9% | 93.7% | |

### a-je-flat: categories (kernel symbols by name, results/margin.md), cycles a request

| category | A | B | A - B | share of the kernel's A - B | A - B by pair, min to max |
| --- | ---: | ---: | ---: | ---: | --- |
| zeroing | 9,086 | 2,432 | +6,654 | 62.7% | +6,315 to +6,907 |
| compaction and khugepaged | 2 | 0 | +2 | 0.0% | +0 to +9 |
| memcg | 1,077 | 886 | +191 | 1.8% | +29 to +279 |
| page allocator | 641 | 349 | +292 | 2.8% | +172 to +383 |
| fault handling | 162 | 0 | +162 | 1.5% | +126 to +204 |
| unmapping and TLB | 382 | 249 | +132 | 1.2% | +67 to +283 |
| scheduler and wakeups | 1,091 | 899 | +192 | 1.8% | +66 to +312 |
| network | 15,123 | 13,523 | +1,601 | 15.1% | +704 to +2,456 |
| copies to and from user | 2,232 | 2,017 | +215 | 2.0% | -14 to +407 |
| epoll and syscall entry | 3,730 | 3,238 | +492 | 4.6% | +275 to +992 |
| slab | 1,033 | 927 | +106 | 1.0% | -154 to +285 |
| interrupts, timers and RCU | 1,731 | 1,457 | +274 | 2.6% | +104 to +546 |
| idle | 7 | 2 | +5 | 0.0% | -6 to +11 |
| locks | 30 | 98 | -68 | -0.6% | -126 to -16 |
| other kernel | 2,773 | 2,411 | +362 | 3.4% | +247 to +510 |
| user | 39,885 | 26,251 | +13,634 |  | +12,228 to +14,905 |

### a-je-flat: top 50 symbols, A (room) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 8,979 | 11.4% | 5097 | zeroing |
| 2 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,760 | 3.5% | 1571 | user |
| 3 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,822 | 2.3% | 1037 | user |
| 4 | [k] rep_movs_alternative | 1,483 | 1.9% | 843 | copies to and from user |
| 5 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,471 | 1.9% | 839 | user |
| 6 | [u] malloc | 1,078 | 1.4% | 614 | user |
| 7 | [u] free | 933 | 1.2% | 531 | user |
| 8 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 861 | 1.1% | 490 | user |
| 9 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 832 | 1.1% | 474 | user |
| 10 | [k] tcp_sendmsg_locked | 828 | 1.0% | 469 | network |
| 11 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 824 | 1.0% | 469 | user |
| 12 | [k] _raw_spin_lock_irqsave | 797 | 1.0% | 454 | network |
| 13 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 687 | 0.9% | 390 | user |
| 14 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 648 | 0.8% | 369 | user |
| 15 | [k] tcp_ack | 644 | 0.8% | 366 | network |
| 16 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 641 | 0.8% | 365 | user |
| 17 | [k] skb_release_data | 580 | 0.7% | 329 | network |
| 18 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 576 | 0.7% | 328 | user |
| 19 | [k] pvclock_clocksource_read_nowd | 524 | 0.7% | 298 | interrupts, timers and RCU |
| 20 | [k] __inet_lookup_established | 507 | 0.6% | 288 | network |
| 21 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 504 | 0.6% | 287 | user |
| 22 | [k] __tcp_transmit_skb | 501 | 0.6% | 284 | network |
| 23 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 494 | 0.6% | 281 | user |
| 24 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 489 | 0.6% | 278 | user |
| 25 | [k] native_write_msr | 461 | 0.6% | 262 | other kernel |
| 26 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 461 | 0.6% | 262 | user |
| 27 | [k] __mod_memcg_state | 433 | 0.5% | 246 | memcg |
| 28 | [u] 0x0000000000172bcd | 391 | 0.5% | 223 | user |
| 29 | [k] vfs_writev | 390 | 0.5% | 222 | epoll and syscall entry |
| 30 | [k] _raw_spin_lock_bh | 387 | 0.5% | 220 | network |
| 31 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 385 | 0.5% | 219 | user |
| 32 | [k] __dev_queue_xmit | 383 | 0.5% | 217 | network |
| 33 | [k] ep_poll_callback | 370 | 0.5% | 211 | epoll and syscall entry |
| 34 | [k] net_rx_action | 367 | 0.5% | 209 | network |
| 35 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 366 | 0.5% | 208 | user |
| 36 | [k] tcp_recvmsg_locked | 363 | 0.5% | 206 | network |
| 37 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 355 | 0.4% | 202 | user |
| 38 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 344 | 0.4% | 196 | user |
| 39 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 343 | 0.4% | 195 | user |
| 40 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 342 | 0.4% | 195 | user |
| 41 | [k] _raw_spin_lock | 342 | 0.4% | 195 | network |
| 42 | [u] 0x0000000000172bfa | 336 | 0.4% | 191 | user |
| 43 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 335 | 0.4% | 191 | user |
| 44 | [u] 0x0000000000000d9e | 322 | 0.4% | 183 | user |
| 45 | [k] aa_sk_perm | 315 | 0.4% | 179 | epoll and syscall entry |
| 46 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 307 | 0.4% | 175 | user |
| 47 | [k] clear_bhb_loop | 293 | 0.4% | 167 | epoll and syscall entry |
| 48 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 290 | 0.4% | 165 | user |
| 49 | [k] __wake_up_common | 284 | 0.4% | 161 | scheduler and wakeups |
| 50 | [k] __ip_queue_xmit | 281 | 0.4% | 160 | network |

### a-je-flat: top 50 symbols, B (off) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,938 | 5.4% | 2421 | user |
| 2 | [k] clear_page_erms | 2,432 | 4.4% | 2007 | zeroing |
| 3 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,425 | 2.6% | 1174 | user |
| 4 | [k] rep_movs_alternative | 1,333 | 2.4% | 1100 | copies to and from user |
| 5 | [u] free | 815 | 1.5% | 673 | user |
| 6 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 765 | 1.4% | 631 | user |
| 7 | [k] tcp_sendmsg_locked | 765 | 1.4% | 631 | network |
| 8 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 757 | 1.4% | 625 | user |
| 9 | [k] _raw_spin_lock_irqsave | 723 | 1.3% | 597 | network |
| 10 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 670 | 1.2% | 552 | user |
| 11 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 635 | 1.2% | 524 | user |
| 12 | [k] tcp_ack | 620 | 1.1% | 511 | network |
| 13 | [u] malloc | 589 | 1.1% | 485 | user |
| 14 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 553 | 1.0% | 456 | user |
| 15 | [k] skb_release_data | 548 | 1.0% | 452 | network |
| 16 | [k] pvclock_clocksource_read_nowd | 514 | 0.9% | 425 | interrupts, timers and RCU |
| 17 | [k] __inet_lookup_established | 478 | 0.9% | 394 | network |
| 18 | [k] __tcp_transmit_skb | 477 | 0.9% | 394 | network |
| 19 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 448 | 0.8% | 370 | user |
| 20 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 444 | 0.8% | 366 | user |
| 21 | [k] net_rx_action | 406 | 0.7% | 335 | network |
| 22 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 399 | 0.7% | 328 | user |
| 23 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 386 | 0.7% | 318 | user |
| 24 | [k] __mod_memcg_state | 385 | 0.7% | 318 | memcg |
| 25 | [k] __dev_queue_xmit | 374 | 0.7% | 309 | network |
| 26 | [k] _raw_spin_lock_bh | 374 | 0.7% | 308 | network |
| 27 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 349 | 0.6% | 288 | user |
| 28 | [k] native_write_msr | 339 | 0.6% | 280 | other kernel |
| 29 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 338 | 0.6% | 278 | user |
| 30 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 333 | 0.6% | 274 | user |
| 31 | [k] vfs_writev | 323 | 0.6% | 267 | epoll and syscall entry |
| 32 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 310 | 0.6% | 256 | user |
| 33 | [k] tcp_recvmsg_locked | 307 | 0.6% | 253 | network |
| 34 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 291 | 0.5% | 239 | user |
| 35 | [k] _raw_spin_lock | 287 | 0.5% | 237 | network |
| 36 | [k] ep_poll_callback | 287 | 0.5% | 236 | epoll and syscall entry |
| 37 | [k] aa_sk_perm | 279 | 0.5% | 230 | epoll and syscall entry |
| 38 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 277 | 0.5% | 228 | user |
| 39 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 266 | 0.5% | 219 | user |
| 40 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 264 | 0.5% | 217 | user |
| 41 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 250 | 0.5% | 206 | user |
| 42 | [k] memset_orig | 242 | 0.4% | 200 | other kernel |
| 43 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 242 | 0.4% | 199 | user |
| 44 | [k] __ip_queue_xmit | 239 | 0.4% | 197 | network |
| 45 | [k] __wake_up_common | 234 | 0.4% | 193 | scheduler and wakeups |
| 46 | [k] kmem_cache_alloc_node_noprof | 231 | 0.4% | 191 | slab |
| 47 | [k] clear_bhb_loop | 226 | 0.4% | 187 | epoll and syscall entry |
| 48 | [k] __rcu_read_unlock | 214 | 0.4% | 177 | interrupts, timers and RCU |
| 49 | [k] sk_filter_trim_cap | 211 | 0.4% | 174 | network |
| 50 | [u] _RNvXsr_NtCsdztPvThAM6J_4http3uriNtB5_3UriNtNtCs8uuN1nrGffB_4core5clone5Clone5clone | 210 | 0.4% | 174 | user |

### a-je-flat: the 50 largest differences A - B, cycles a request (kernel A - B in all: +10,612)

| # | symbol | A | B | A - B | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 8,979 | 2,432 | +6,547 | zeroing |
| 2 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,822 | 0 | +1,822 | user |
| 3 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 641 | 0 | +641 | user |
| 4 | [u] malloc | 1,078 | 589 | +489 | user |
| 5 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 461 | 0 | +461 | user |
| 6 | [u] 0x0000000000172bcd | 391 | 22 | +369 | user |
| 7 | [u] 0x0000000000172bfa | 336 | 29 | +307 | user |
| 8 | [u] 0x0000000000000d9e | 322 | 61 | +261 | user |
| 9 | [u] 0x0000000000172bdb | 272 | 22 | +250 | user |
| 10 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked6missed | 202 | 0 | +202 | user |
| 11 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept6varies | 201 | 0 | +201 | user |
| 12 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 861 | 670 | +191 | user |
| 13 | [u] 0x0000000000172be5 | 202 | 12 | +190 | user |
| 14 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes12shared_clone.llvm.8302685113893385452 | 209 | 28 | +181 | user |
| 15 | [u] pthread_mutex_trylock | 181 | 0 | +181 | user |
| 16 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,760 | 2,938 | -178 | user |
| 17 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 576 | 399 | +177 | user |
| 18 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 489 | 338 | +150 | user |
| 19 | [k] rep_movs_alternative | 1,483 | 1,333 | +150 | copies to and from user |
| 20 | [u] 0x00000000000974ac | 146 | 0 | +146 | user |
| 21 | [u] _RNvMs4_NtCs2Sdwwla2uzU_6corten4keptNtB5_3Key3new | 133 | 0 | +133 | user |
| 22 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes17shallow_clone_vec | 128 | 0 | +128 | user |
| 23 | [u] _RINvYINtNtNtNtCs8uuN1nrGffB_4core4iter8adapters3map3MapINtNtNtCsdztPvThAM6J_4http6header3map4IterNtNtBW_5value11HeaderValueENCNCNvMsb_NtCs2Sdwwla2uzU_6corten4keptNtB28_6Missed4keep0s0_0ENtNtNtBa_6traits8iterator8Iterator3sumjECskjsZcOxyxTu_5probe | 122 | 0 | +122 | user |
| 24 | [k] native_write_msr | 461 | 339 | +122 | other kernel |
| 25 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked2of | 179 | 60 | +120 | user |
| 26 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes20promotable_even_drop | 132 | 13 | +119 | user |
| 27 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept8count_of.llvm.8612054359066671192 | 118 | 0 | +118 | user |
| 28 | [u] free | 933 | 815 | +118 | user |
| 29 | [u] 0x0000000000172bf3 | 132 | 17 | +115 | user |
| 30 | [u] 0x0000000000172bec | 130 | 17 | +113 | user |
| 31 | [k] folio_zero_user | 107 | 0 | +107 | zeroing |
| 32 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 343 | 242 | +101 | user |
| 33 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten4body8to_bytes0CskjsZcOxyxTu_5probe | 96 | 0 | +96 | user |
| 34 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 648 | 553 | +94 | user |
| 35 | [u] 0x0000000000082430 | 93 | 0 | +93 | user |
| 36 | [u] clock_gettime | 135 | 43 | +93 | user |
| 37 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 279 | 187 | +93 | user |
| 38 | [k] free_unref_page | 116 | 24 | +92 | page allocator |
| 39 | [k] llist_add_batch | 269 | 184 | +85 | unmapping and TLB |
| 40 | [u] _RINvMs_NtCsdztPvThAM6J_4http10extensionsNtB5_10Extensions3getNtNtCs2Sdwwla2uzU_6corten6layout10SameForAllECskjsZcOxyxTu_5probe | 84 | 0 | +84 | user |
| 41 | [k] ep_poll_callback | 370 | 287 | +84 | epoll and syscall entry |
| 42 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 344 | 264 | +80 | user |
| 43 | [k] __copy_skb_header | 106 | 183 | -77 | other kernel |
| 44 | [u] _RINvMNtCs2Sdwwla2uzU_6corten4pageNtB3_4Mode4saidNCNCNvMs9_NtB5_4keptNtBU_4Sent4reads_00EB5_ | 76 | 0 | +76 | user |
| 45 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 366 | 291 | +75 | user |
| 46 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap12contains_keyNtNtB8_4name10HeaderNameECskjsZcOxyxTu_5probe | 125 | 50 | +75 | user |
| 47 | [k] _raw_spin_lock_irqsave | 797 | 723 | +74 | network |
| 48 | [u] _RINvMs_NtCsdztPvThAM6J_4http10extensionsNtB5_10Extensions3getNtNtCs2Sdwwla2uzU_6corten6router11MatchedPathEB11_ | 74 | 0 | +74 | user |
| 49 | [u] 0x0000000000172a00 | 190 | 117 | +73 | user |
| 50 | [u] _RNvXs3_NtNtCs8uuN1nrGffB_4core4hash3sipINtB5_6HasherNtB5_11Sip13RoundsENtB7_6Hasher5writeCs2Sdwwla2uzU_6corten | 72 | 0 | +72 | user |

### a-je-flat: by command (shared object), cycles a request

| command (object) | A | B | A - B |
| --- | ---: | ---: | ---: |
| main ([kernel.kallsyms]) | 36,625 | 26,686 | +9,939 |
| main (main) | 28,024 | 20,112 | +7,912 |
| main (libc.so.6) | 5,203 | 2,642 | +2,560 |
| main (libjemalloc.so.2) | 3,714 | 1,695 | +2,019 |
| main ([vdso]) | 545 | 136 | +408 |
| kworker/2:2-eve ([kernel.kallsyms]) | 8 | 13 | -4 |
| swapper ([kernel.kallsyms]) | 7 | 3 | +3 |
| kworker/2:2-mm_ ([kernel.kallsyms]) | 5 | 2 | +3 |
| ksoftirqd/2 ([kernel.kallsyms]) | 2 | 5 | -3 |
| kworker/u35:3-w ([kernel.kallsyms]) | 2 | 2 | -1 |
| migration/2 ([kernel.kallsyms]) | 0 | 2 | -2 |
| corten-clock ([kernel.kallsyms]) | 2 | 0 | +2 |

## a-je-graph: 5 turns a side, 606,163 and 869,391 requests answered

| a request | A (room) | B (off) | A - B |
| --- | ---: | ---: | ---: |
| all on CPU 2 | 79,266 | 55,150 | +24,116 |
| kernel ([k]) | 39,424 | 28,664 | +10,760 |
| user ([.]) | 39,842 | 26,486 | +13,356 |
| samples (all turns) | 45,552 | 45,037 | |
| lost / throttle events | 0 / 0 | 0 / 0 | |
| sampled share of CPU 2's counted cycles (scaled up to the count) | 94.8% | 93.9% | |

### a-je-graph: categories (kernel symbols by name, results/margin.md), cycles a request

| category | A | B | A - B | share of the kernel's A - B | A - B by pair, min to max |
| --- | ---: | ---: | ---: | ---: | --- |
| zeroing | 9,324 | 2,476 | +6,847 | 63.6% | +6,700 to +6,934 |
| memcg | 1,003 | 894 | +109 | 1.0% | +13 to +225 |
| page allocator | 623 | 302 | +321 | 3.0% | +268 to +423 |
| fault handling | 147 | 7 | +140 | 1.3% | +82 to +217 |
| unmapping and TLB | 365 | 226 | +139 | 1.3% | +68 to +248 |
| scheduler and wakeups | 1,073 | 875 | +197 | 1.8% | +42 to +350 |
| network | 15,366 | 13,444 | +1,922 | 17.9% | +1,428 to +2,463 |
| copies to and from user | 2,274 | 2,053 | +220 | 2.0% | -71 to +479 |
| epoll and syscall entry | 3,589 | 3,377 | +212 | 2.0% | -63 to +446 |
| slab | 1,015 | 930 | +84 | 0.8% | -162 to +311 |
| interrupts, timers and RCU | 1,756 | 1,437 | +319 | 3.0% | +30 to +648 |
| idle | 0 | 2 | -2 | -0.0% | -6 to +0 |
| locks | 56 | 202 | -146 | -1.4% | -260 to +40 |
| other kernel | 2,835 | 2,437 | +398 | 3.7% | +212 to +584 |
| user | 39,842 | 26,486 | +13,356 |  | +12,870 to +13,865 |

### a-je-graph: top 50 symbols, A (room) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 9,229 | 11.6% | 5286 | zeroing |
| 2 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,722 | 3.4% | 1570 | user |
| 3 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,742 | 2.2% | 1004 | user |
| 4 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,633 | 2.1% | 942 | user |
| 5 | [k] rep_movs_alternative | 1,557 | 2.0% | 891 | copies to and from user |
| 6 | [u] malloc | 971 | 1.2% | 560 | user |
| 7 | [u] free | 917 | 1.2% | 529 | user |
| 8 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 853 | 1.1% | 492 | user |
| 9 | [k] _raw_spin_lock_irqsave | 812 | 1.0% | 465 | network |
| 10 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 810 | 1.0% | 467 | user |
| 11 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 804 | 1.0% | 463 | user |
| 12 | [k] tcp_sendmsg_locked | 752 | 0.9% | 431 | network |
| 13 | [k] tcp_ack | 640 | 0.8% | 367 | network |
| 14 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 634 | 0.8% | 366 | user |
| 15 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 625 | 0.8% | 360 | user |
| 16 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 613 | 0.8% | 353 | user |
| 17 | [k] skb_release_data | 603 | 0.8% | 345 | network |
| 18 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 595 | 0.8% | 343 | user |
| 19 | [k] pvclock_clocksource_read_nowd | 565 | 0.7% | 324 | interrupts, timers and RCU |
| 20 | [k] __inet_lookup_established | 524 | 0.7% | 300 | network |
| 21 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 520 | 0.7% | 300 | user |
| 22 | [k] __tcp_transmit_skb | 504 | 0.6% | 289 | network |
| 23 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 500 | 0.6% | 288 | user |
| 24 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 499 | 0.6% | 288 | user |
| 25 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 479 | 0.6% | 276 | user |
| 26 | [k] native_write_msr | 452 | 0.6% | 259 | other kernel |
| 27 | [k] __dev_queue_xmit | 445 | 0.6% | 255 | network |
| 28 | [k] _raw_spin_lock_bh | 434 | 0.5% | 249 | network |
| 29 | [k] __mod_memcg_state | 426 | 0.5% | 244 | memcg |
| 30 | [k] net_rx_action | 402 | 0.5% | 230 | network |
| 31 | [k] vfs_writev | 384 | 0.5% | 220 | epoll and syscall entry |
| 32 | [u] 0x0000000000172bfa | 380 | 0.5% | 219 | user |
| 33 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 359 | 0.5% | 207 | user |
| 34 | [k] tcp_recvmsg_locked | 354 | 0.4% | 203 | network |
| 35 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 353 | 0.4% | 203 | user |
| 36 | [u] 0x0000000000172bcd | 345 | 0.4% | 199 | user |
| 37 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 340 | 0.4% | 196 | user |
| 38 | [k] _raw_spin_lock | 337 | 0.4% | 193 | network |
| 39 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 334 | 0.4% | 193 | user |
| 40 | [k] aa_sk_perm | 332 | 0.4% | 190 | epoll and syscall entry |
| 41 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 328 | 0.4% | 189 | user |
| 42 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 324 | 0.4% | 187 | user |
| 43 | [u] 0x0000000000000d9e | 321 | 0.4% | 185 | user |
| 44 | [k] ep_poll_callback | 317 | 0.4% | 182 | epoll and syscall entry |
| 45 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 310 | 0.4% | 179 | user |
| 46 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 288 | 0.4% | 166 | user |
| 47 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 288 | 0.4% | 166 | user |
| 48 | [u] _RNvXsr_NtCsdztPvThAM6J_4http3uriNtB5_3UriNtNtCs8uuN1nrGffB_4core5clone5Clone5clone | 280 | 0.4% | 161 | user |
| 49 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 279 | 0.4% | 161 | user |
| 50 | [k] clear_bhb_loop | 275 | 0.3% | 157 | epoll and syscall entry |

### a-je-graph: top 50 symbols, B (off) (perf report --no-children --sort sym, merged over 5 turns)

| # | symbol | cycles a request | share | samples | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,859 | 5.2% | 2340 | user |
| 2 | [k] clear_page_erms | 2,476 | 4.5% | 2018 | zeroing |
| 3 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,480 | 2.7% | 1212 | user |
| 4 | [k] rep_movs_alternative | 1,338 | 2.4% | 1090 | copies to and from user |
| 5 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction6encode | 795 | 1.4% | 651 | user |
| 6 | [k] tcp_sendmsg_locked | 781 | 1.4% | 636 | network |
| 7 | [u] free | 756 | 1.4% | 619 | user |
| 8 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 714 | 1.3% | 585 | user |
| 9 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 711 | 1.3% | 582 | user |
| 10 | [k] _raw_spin_lock_irqsave | 695 | 1.3% | 567 | network |
| 11 | [u] malloc | 674 | 1.2% | 552 | user |
| 12 | [k] tcp_ack | 595 | 1.1% | 485 | network |
| 13 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap11try_insert2NtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 569 | 1.0% | 466 | user |
| 14 | [k] skb_release_data | 552 | 1.0% | 450 | network |
| 15 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 526 | 1.0% | 431 | user |
| 16 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 512 | 0.9% | 419 | user |
| 17 | [k] __tcp_transmit_skb | 481 | 0.9% | 392 | network |
| 18 | [k] __inet_lookup_established | 466 | 0.8% | 380 | network |
| 19 | [k] pvclock_clocksource_read_nowd | 462 | 0.8% | 376 | interrupts, timers and RCU |
| 20 | [u] _RNvXs_NtNtCs8uuN1nrGffB_4core6future6futureINtNtB8_3pin3PinQINtNtNtNtCsb8FoRbCRZGR_5hyper6server4conn5http121UpgradeableConnectionINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtNtB2b_7service4glue19TowerToHyperServiceNtNtB2X_3app10ConnectionEEENtB4_6Future4pollCskjsZcOxyxTu_5probe | 457 | 0.8% | 374 | user |
| 21 | [u] _RNvMNtNtNtCsb8FoRbCRZGR_5hyper5proto2h18dispatchINtB2_10DispatcherINtB2_6ServerINtNtNtCs4pbSw37EEB1_10hyper_util7service4glue19TowerToHyperServiceNtNtCs2Sdwwla2uzU_6corten3app10ConnectionENtNtNtB8_4body8incoming8IncomingENtNtB2o_5watch8AnsweredINtNtNtB1m_2rt5tokio7TokioIoINtB3z_7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEENtNtB4_4role6ServerE10poll_writeCskjsZcOxyxTu_5probe | 444 | 0.8% | 364 | user |
| 22 | [k] __mod_memcg_state | 375 | 0.7% | 305 | memcg |
| 23 | [k] net_rx_action | 374 | 0.7% | 305 | network |
| 24 | [k] __dev_queue_xmit | 371 | 0.7% | 302 | network |
| 25 | [k] _raw_spin_lock_bh | 368 | 0.7% | 300 | network |
| 26 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 367 | 0.7% | 300 | user |
| 27 | [k] native_write_msr | 355 | 0.6% | 289 | other kernel |
| 28 | [k] vfs_writev | 343 | 0.6% | 280 | epoll and syscall entry |
| 29 | [u] _RNvNtCs2Sdwwla2uzU_6corten8compress4vary | 340 | 0.6% | 278 | user |
| 30 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 336 | 0.6% | 275 | user |
| 31 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap3getNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 327 | 0.6% | 268 | user |
| 32 | [k] ep_poll_callback | 321 | 0.6% | 262 | epoll and syscall entry |
| 33 | [u] _RINvNtNtNtCs3v7n8iqQsbi_5tokio7runtime4task3raw4pollNCNCINvNtCs2Sdwwla2uzU_6corten3app14serve_listenerNtCskjsZcOxyxTu_5probe5GatedINvBV_5plainNtNtNtNtB8_3net3tcp6stream9TcpStreamEINtNtNtCs8uuN1nrGffB_4core6future5ready5ReadyINtNtB2Y_6result6ResultTB2g_uEzEEB2g_zuE0s_0INtNtCs3BN1jqgSbDf_5alloc4sync3ArcNtNtNtB6_9scheduler14current_thread6HandleEEB1E_ | 312 | 0.6% | 255 | user |
| 34 | [k] clear_bhb_loop | 292 | 0.5% | 238 | epoll and syscall entry |
| 35 | [k] aa_sk_perm | 291 | 0.5% | 237 | epoll and syscall entry |
| 36 | [k] _raw_spin_lock | 289 | 0.5% | 235 | network |
| 37 | [u] _RNvMse_NtCs2Sdwwla2uzU_6corten8securityNtB5_7Applied7headers | 288 | 0.5% | 236 | user |
| 38 | [u] _RNvXNtNtNtCsb8FoRbCRZGR_5hyper5proto2h14roleNtB2_6ServerNtB4_16Http1Transaction5parse | 286 | 0.5% | 234 | user |
| 39 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten8compress6finish0CskjsZcOxyxTu_5probe | 285 | 0.5% | 233 | user |
| 40 | [k] memset_orig | 282 | 0.5% | 230 | other kernel |
| 41 | [u] _RNvMsi_NtCs2Sdwwla2uzU_6corten6routerNtB5_6Router6answer | 274 | 0.5% | 224 | user |
| 42 | [k] kmem_cache_alloc_node_noprof | 255 | 0.5% | 208 | slab |
| 43 | [k] tcp_recvmsg_locked | 253 | 0.5% | 206 | network |
| 44 | [u] _RNvXsr_NtCsdztPvThAM6J_4http3uriNtB5_3UriNtNtCs8uuN1nrGffB_4core5clone5Clone5clone | 248 | 0.4% | 203 | user |
| 45 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 233 | 0.4% | 191 | user |
| 46 | [k] __ip_queue_xmit | 226 | 0.4% | 184 | network |
| 47 | [u] _RNCINvNtCs2Sdwwla2uzU_6corten4page3runNCINvB4_15within_deadlineINtNtB6_3app5PlainuEE0NCNCINvB4_15errors_renderedBZ_E0s_0E0CskjsZcOxyxTu_5probe | 215 | 0.4% | 176 | user |
| 48 | [k] __rcu_read_unlock | 211 | 0.4% | 172 | interrupts, timers and RCU |
| 49 | [k] fdget | 206 | 0.4% | 168 | epoll and syscall entry |
| 50 | [k] tcp_rcv_established | 205 | 0.4% | 167 | network |

### a-je-graph: the 50 largest differences A - B, cycles a request (kernel A - B in all: +10,760)

| # | symbol | A | B | A - B | category |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | [k] clear_page_erms | 9,229 | 2,476 | +6,753 | zeroing |
| 2 | [u] _RNCNvXs2_NtCs2Sdwwla2uzU_6corten6routerNtB7_7KeepingNtB7_8Endpoint4calls_0CskjsZcOxyxTu_5probe | 1,742 | 0 | +1,742 | user |
| 3 | [u] _RNvXs19_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMapNtNtCs8uuN1nrGffB_4core5clone5Clone5cloneCskjsZcOxyxTu_5probe | 595 | 0 | +595 | user |
| 4 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked4find | 500 | 0 | +500 | user |
| 5 | [u] 0x0000000000172bfa | 380 | 21 | +359 | user |
| 6 | [u] 0x0000000000172bcd | 345 | 27 | +318 | user |
| 7 | [u] malloc | 971 | 674 | +297 | user |
| 8 | [u] 0x0000000000000d9e | 321 | 65 | +256 | user |
| 9 | [u] 0x0000000000172bdb | 274 | 21 | +254 | user |
| 10 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked6missed | 248 | 0 | +248 | user |
| 11 | [u] pthread_mutex_trylock | 234 | 0 | +234 | user |
| 12 | [k] rep_movs_alternative | 1,557 | 1,338 | +220 | copies to and from user |
| 13 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept6varies | 181 | 0 | +181 | user |
| 14 | [u] 0x00000000000974ac | 163 | 0 | +163 | user |
| 15 | [u] free | 917 | 756 | +162 | user |
| 16 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes20promotable_even_drop | 168 | 9 | +160 | user |
| 17 | [u] _RNvXsu_NtCs2Sdwwla2uzU_6corten4pageINtB5_6PartedINtNtB7_4view7DocHtmlNCNvCskjsZcOxyxTu_5probe8document0EENtBN_6Render6renderB19_ | 1,633 | 1,480 | +153 | user |
| 18 | [k] native_queued_spin_lock_slowpath | 42 | 192 | -150 | locks |
| 19 | [u] 0x0000000000172be5 | 179 | 34 | +145 | user |
| 20 | [u] _RNvXsc_NtNtCs4q2MSqxezRi_12futures_util6future6futureINtB5_3MapNCNvXsj_NtCs2Sdwwla2uzU_6corten7handlerNvCskjsZcOxyxTu_5probe6recordINtB17_7HandlerTNtNtB17_7private8ViaPartsNtNtB19_4page3ReqEuE4call0INvNtB19_6answer6markedINtB3d_6PublicINtNtCs8uuN1nrGffB_4core6result6ResultNtB3d_12HtmlResponseNtB19_5ErrorEEEENtNtNtB3Q_6future6future6Future4pollB1E_ | 479 | 336 | +143 | user |
| 21 | [u] _RINvNtNtCsdztPvThAM6J_4http6header3map15hash_elem_usingNtNtB4_4name10HeaderNameECs2Sdwwla2uzU_6corten | 853 | 711 | +142 | user |
| 22 | [u] _RNvNtCs2Sdwwla2uzU_6corten4view11escape_into | 2,722 | 2,859 | -137 | user |
| 23 | [u] _RNvMs4_NtCs2Sdwwla2uzU_6corten4keptNtB5_3Key3new | 132 | 0 | +132 | user |
| 24 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes17shallow_clone_vec | 130 | 0 | +130 | user |
| 25 | [u] 0x0000000000172bec | 139 | 13 | +125 | user |
| 26 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes11shared_drop.llvm.8302685113893385452 | 243 | 367 | -123 | user |
| 27 | [u] _RNvNtCs6sv2pxdbPD2_5bytes5bytes12shared_clone.llvm.8302685113893385452 | 158 | 38 | +120 | user |
| 28 | [u] _RNvNtCs6sv2pxdbPD2_5bytes9bytes_mut13shared_v_drop | 353 | 233 | +120 | user |
| 29 | [u] _RINvMNtCs2Sdwwla2uzU_6corten4pageNtB3_4Mode4saidNCNCNvMs9_NtB5_4keptNtBU_4Sent4reads_00EB5_ | 120 | 0 | +120 | user |
| 30 | [u] 0x0000000000172bf3 | 146 | 28 | +118 | user |
| 31 | [k] _raw_spin_lock_irqsave | 812 | 695 | +117 | network |
| 32 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap7get_allNtNtB8_4name10HeaderNameECs2Sdwwla2uzU_6corten.llvm.8612054359066671192 | 258 | 143 | +115 | user |
| 33 | [u] _RNvMs_NtNtNtCsb8FoRbCRZGR_5hyper5proto2h12ioINtB4_8BufferedINtNtNtCs4pbSw37EEB1_10hyper_util2rt5tokio7TokioIoINtNtCs2Sdwwla2uzU_6corten5watch7WatchedNtNtNtNtCs3v7n8iqQsbi_5tokio3net3tcp6stream9TcpStreamEEINtNtB6_6encode10EncodedBufNtNtCs6sv2pxdbPD2_5bytes5bytes5BytesEE10poll_flushCskjsZcOxyxTu_5probe | 625 | 512 | +113 | user |
| 34 | [u] _RNvNtNtCs8uuN1nrGffB_4core3str8converts9from_utf8 | 288 | 175 | +112 | user |
| 35 | [u] _RNCNvNtCs2Sdwwla2uzU_6corten4body8to_bytes0CskjsZcOxyxTu_5probe | 111 | 0 | +111 | user |
| 36 | [u] _RNvNtCs2Sdwwla2uzU_6corten5cache6settle | 634 | 526 | +108 | user |
| 37 | [u] _RNvXs3_NtNtCs8uuN1nrGffB_4core4hash3sipINtB5_6HasherNtB5_11Sip13RoundsENtB7_6Hasher5writeCs2Sdwwla2uzU_6corten | 106 | 0 | +106 | user |
| 38 | [k] pvclock_clocksource_read_nowd | 565 | 462 | +103 | interrupts, timers and RCU |
| 39 | [u] _RINvYINtNtNtNtCs8uuN1nrGffB_4core4iter8adapters3map3MapINtNtNtCsdztPvThAM6J_4http6header3map4IterNtNtBW_5value11HeaderValueENCNCNvMsb_NtCs2Sdwwla2uzU_6corten4keptNtB28_6Missed4keep0s0_0ENtNtNtBa_6traits8iterator8Iterator3sumjECskjsZcOxyxTu_5probe | 102 | 0 | +102 | user |
| 40 | [k] __netif_receive_skb_core.constprop.0 | 219 | 117 | +102 | network |
| 41 | [k] tcp_recvmsg_locked | 354 | 253 | +101 | network |
| 42 | [u] _RNvNtCs2Sdwwla2uzU_6corten4kept8count_of.llvm.8612054359066671192 | 101 | 0 | +101 | user |
| 43 | [k] native_write_msr | 452 | 355 | +98 | other kernel |
| 44 | [u] _RNCNvXsd_NtCs2Sdwwla2uzU_6corten3appINtB7_2AtINtB7_5PlainuEENtNtB9_6router6Stages3run0CskjsZcOxyxTu_5probe | 810 | 714 | +96 | user |
| 45 | [u] _RNvMsa_NtCs2Sdwwla2uzU_6corten4keptNtB5_5Asked2of | 168 | 72 | +96 | user |
| 46 | [k] folio_zero_user | 94 | 0 | +94 | zeroing |
| 47 | [k] available_idle_cpu | 251 | 160 | +91 | other kernel |
| 48 | [u] _RINvMs0_NtNtCsdztPvThAM6J_4http6header3mapNtB6_9HeaderMap12contains_keyNtNtB8_4name10HeaderNameECskjsZcOxyxTu_5probe | 142 | 51 | +91 | user |
| 49 | [u] clock_gettime | 121 | 37 | +84 | user |
| 50 | [k] llist_add_batch | 239 | 155 | +84 | unmapping and TLB |

### a-je-graph: by command (shared object), cycles a request

| command (object) | A | B | A - B |
| --- | ---: | ---: | ---: |
| main ([kernel.kallsyms]) | 37,219 | 26,829 | +10,390 |
| main (main) | 28,382 | 20,405 | +7,977 |
| main (libc.so.6) | 5,149 | 2,708 | +2,441 |
| main (libjemalloc.so.2) | 3,814 | 1,714 | +2,100 |
| main ([vdso]) | 553 | 110 | +442 |
| kworker/2:2-eve ([kernel.kallsyms]) | 12 | 17 | -6 |
| swapper ([kernel.kallsyms]) | 5 | 7 | -2 |
| kworker/u35:2-k ([kernel.kallsyms]) | 7 | 0 | +7 |
| ksoftirqd/2 ([kernel.kallsyms]) | 2 | 5 | -3 |
| kworker/u35:2-f ([kernel.kallsyms]) | 0 | 5 | -5 |
| perf ([kernel.kallsyms]) | 2 | 2 | -1 |
| migration/2 ([kernel.kallsyms]) | 2 | 0 | +2 |

### a-je-graph: how the kernel was entered (entries.mjs), the 25 largest differences, cycles a request

| command: entry | A | B | A - B |
| --- | ---: | ---: | ---: |
| main: user | 39,841 | 26,486 | +13,354 |
| main: page fault | 7,431 | 0 | +7,431 |
| main: syscall entry and exit | 27,669 | 24,974 | +2,695 |
| main: syscall recvfrom | 3,340 | 2,906 | +434 |
| main: syscall epoll_wait | 732 | 636 | +97 |
| main: other [unknown] | 63 | 26 | +37 |
| main: syscall writev | 59 | 22 | +37 |
| main: interrupt apic_timer_interrupt | 86 | 53 | +33 |
| kworker/u35:2-k: kernel thread | 7 | 0 | +7 |
| kworker/2:2-eve: kernel thread | 12 | 18 | -6 |
| swapper: interrupt apic_timer_interrupt | 2 | 7 | -6 |
| kworker/u35:2-f: kernel thread | 0 | 5 | -5 |
| swapper: idle task | 3 | 0 | +3 |
| ksoftirqd/2: kernel thread | 2 | 5 | -3 |
| main: syscall shutdown | 0 | 2 | -2 |
| main: other error_entry | 4 | 1 | +2 |
| main: other native_load_tls | 2 | 0 | +2 |
| perf: user | 2 | 0 | +2 |
| main: other __irqentry_text_end | 2 | 0 | +2 |
| migration/2: kernel thread | 2 | 0 | +2 |
| main: syscall mmap | 2 | 0 | +2 |
| jemalloc_bg_thd: syscall madvise | 2 | 0 | +2 |
| main: syscall epoll_ctl | 0 | 1 | -1 |
| perf: syscall entry and exit | 0 | 1 | -1 |
| kworker/u35:2-w: kernel thread | 0 | 1 | -1 |

### a-je-graph: inclusive markers (a sample counts for every marker its kernel chain holds), cycles a request; kernel A - B here +10,760

| marker | A | B | A - B | share of the kernel's A - B |
| --- | ---: | ---: | ---: | ---: |
| page fault (any) | 7,431 | 0 | +7,431 | 69.1% |
| huge page fault | 7,163 | 0 | +7,163 | 66.6% |
| 4 KiB anonymous fault | 35 | 0 | +35 | 0.3% |
| zeroing (clear_page) | 9,364 | 2,479 | +6,885 | 64.0% |
| page allocator | 8,318 | 2,784 | +5,534 | 51.4% |
| page freeing | 206 | 81 | +125 | 1.2% |
| memcg charge | 204 | 178 | +26 | 0.2% |
| lru add | 17 | 1 | +16 | 0.2% |
| madvise | 2 | 0 | +2 | 0.0% |
| munmap, mmap, brk | 2 | 0 | +2 | 0.0% |
| zap and unmap | 2 | 0 | +2 | 0.0% |
| split huge page | 2 | 0 | +2 | 0.0% |
| TLB flush | 9 | 0 | +9 | 0.1% |
| softirq | 12,560 | 10,754 | +1,807 | 16.8% |
| tcp send | 24,528 | 22,000 | +2,528 | 23.5% |
| tcp receive | 2,520 | 2,236 | +284 | 2.6% |
| epoll wait | 727 | 633 | +94 | 0.9% |
| schedule | 7 | 11 | -4 | -0.0% |
| slab | 1,205 | 1,158 | +47 | 0.4% |
- A's zeroing (clear_page) by entry: page fault 75.1%, syscall entry and exit 24.9%
- A's page allocator by entry: page fault 67.7%, syscall entry and exit 32.3%
- A's memcg charge by entry: syscall entry and exit 91.5%, page fault 8.5%
- A's huge page fault by entry: page fault 100.0%
- A's page fault (any) by entry: page fault 100.0%
