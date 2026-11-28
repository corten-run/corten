# Client-heavy screens r87

The archived result passed native replay, including a separate publication
check, and droplet deletion is recorded.

Measured commit: [`8b4e863b15020d720b22d5cf1665f9ae16b2473a`](https://github.com/corten-run/corten/commit/8b4e863b15020d720b22d5cf1665f9ae16b2473a).
Measured November 26, 2026 UTC on a dedicated DigitalOcean `c-8` in `sfo3`,
Intel Xeon Platinum 8280 at 2.70 GHz, with eight logical CPUs. Node 26.13.1;
Chromium 159.0.8154.6, one browser and one page at a time.

Each contender passed one qualification journey excluded from the table and all
three measured journeys. Each journey used a fresh browser context with the
same 100 initial rows, 1,000-row large create, 100-row append and 200-card
dashboard. The qualification checks include the exact DOM and final state,
no operation HTTP requests, and subscription cleanup. The measured blocks
rotated contender order by two positions; fresh contexts do not reset the
browser process or host caches.

## Browser timings

Milliseconds, median [minimum-maximum] across three measured passes. Ready spans
browser mount through visible-screen and subscription readiness, the initial
settle and DOM observation. It excludes page navigation and container startup.
Other rows measure the action through the two-animation-frame settle and stop
before DOM extraction and validation. This workload does not report comparable
memory or server cold-start measurements. The ranges are from one host, not
confidence intervals or a ranking.

| Step | Corten | React | Vue | Solid | Svelte | Remix |
|---|---:|---:|---:|---:|---:|---:|
| Ready | 45.0 [30.6-49.4] | 46.0 [42.4-49.9] | 55.5 [54.4-62.1] | 51.4 [47.7-54.3] | 61.0 [56.7-69.0] | 67.9 [65.6-79.6] |
| Update every tenth row | 33.5 [30.3-34.5] | 29.9 [27.3-33.6] | 32.5 [6.7-32.7] | 32.3 [7.6-33.1] | 5.5 [5.5-33.0] | 9.5 [9.1-11.7] |
| Select row 2 | 13.6 [13.2-14.0] | 14.6 [14.2-14.8] | 13.7 [8.5-14.3] | 13.2 [11.6-14.2] | 12.2 [11.2-14.8] | 7.3 [5.9-12.9] |
| Swap rows | 13.1 [11.7-14.2] | 12.6 [10.0-13.2] | 13.6 [11.0-15.8] | 13.0 [12.0-14.9] | 14.3 [13.8-14.5] | 14.6 [14.6-16.0] |
| Filter to group 1 | 13.7 [11.2-16.3] | 14.5 [14.3-14.8] | 15.9 [15.3-16.5] | 15.5 [14.9-15.7] | 15.0 [13.8-15.9] | 15.4 [12.0-15.8] |
| Sort descending | 18.4 [18.3-19.8] | 20.0 [14.7-20.3] | 19.9 [19.8-20.6] | 20.2 [19.9-20.5] | 19.9 [19.6-20.5] | 20.0 [17.4-20.1] |
| Clear filter | 19.8 [16.6-20.2] | 20.0 [19.7-20.4] | 20.1 [19.4-20.9] | 19.3 [18.1-19.7] | 19.6 [19.3-19.6] | 20.1 [20.0-20.5] |
| Sort ascending | 15.2 [14.8-15.2] | 15.0 [14.7-16.2] | 13.7 [12.6-14.4] | 14.9 [14.3-16.1] | 15.4 [14.8-15.6] | 14.9 [14.3-14.9] |
| Remove row 4 | 15.2 [14.6-15.8] | 14.4 [8.5-14.9] | 16.4 [16.4-16.7] | 15.7 [15.6-15.9] | 15.5 [14.7-16.0] | 15.0 [14.6-15.6] |
| Patch the 99 remaining list rows | 16.1 [15.5-16.2] | 16.2 [14.7-16.7] | 15.6 [15.6-16.5] | 15.5 [12.4-15.7] | 15.4 [14.2-16.3] | 14.5 [12.7-15.6] |
| Append 100 rows | 14.7 [14.1-14.8] | 15.8 [15.7-16.1] | 18.4 [17.5-20.1] | 14.6 [11.4-15.1] | 15.3 [14.9-15.5] | 25.3 [23.9-26.4] |
| Clear list | 10.2 [9.5-11.8] | 9.1 [8.0-9.5] | 8.4 [6.1-9.6] | 9.7 [8.1-10.6] | 9.9 [7.9-11.1] | 14.7 [6.5-16.2] |
| Create 100 rows | 21.0 [20.6-21.0] | 21.0 [20.4-21.8] | 19.8 [17.0-21.0] | 20.9 [20.8-21.6] | 20.7 [20.3-21.5] | 20.5 [19.5-21.3] |
| Replace 100 rows | 15.9 [15.1-16.1] | 15.9 [15.5-16.1] | 17.3 [17.0-17.3] | 15.0 [14.1-16.1] | 14.7 [10.9-15.2] | 21.1 [21.1-21.4] |
| Create 1,000 rows | 68.3 [68.1-68.6] | 78.8 [78.6-88.8] | 135.4 [132.1-142.8] | 72.9 [72.6-74.6] | 76.6 [74.4-81.0] | 169.4 [163.7-173.8] |
| Patch one list row | 22.7 [22.6-24.5] | 22.0 [21.4-29.7] | 23.4 [20.5-25.6] | 29.2 [26.1-30.4] | 21.8 [20.7-25.9] | 30.4 [29.0-33.5] |
| Patch 100 list rows | 24.1 [23.9-25.0] | 27.1 [25.3-27.7] | 24.1 [22.8-24.8] | 23.0 [22.6-24.9] | 25.8 [25.2-37.6] | 35.7 [35.3-39.5] |
| Tick 20 dashboard cards | 15.4 [13.2-19.4] | 21.0 [9.5-25.0] | 26.0 [18.9-28.0] | 22.0 [15.8-30.2] | 15.7 [14.7-21.3] | 20.4 [16.6-29.8] |
| Tick 200 dashboard cards | 24.5 [20.9-24.6] | 25.2 [24.6-25.4] | 22.0 [19.3-24.4] | 22.1 [20.6-23.3] | 24.6 [24.4-25.2] | 23.5 [21.4-25.4] |
| Final clear | 23.7 [22.2-23.7] | 24.4 [22.9-25.3] | 22.9 [22.2-25.4] | 23.0 [22.1-23.1] | 22.7 [22.0-23.0] | 21.2 [20.1-22.0] |

On the largest list create, Corten recorded **68.3 ms [68.1-68.6]** and Solid
**72.9 ms [72.6-74.6]**. Ready was **45.0 ms [30.6-49.4]** for Corten and
**46.0 ms [42.4-49.9]** for React; the ranges overlap. Use the action-level
numbers rather than treating either observation as an overall speed ranking.

The [evidence record](provenance.json) binds the private original archive and
the compact report inputs. The compact inputs reproduce this table, but cannot
replay native qualification. No timing samples were pooled across groups,
commits or hosts.
