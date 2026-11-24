# Stage header checks (corten-run/corten#2002): what was added after its second review

The first tag, `evidence/stage-header-checks-2002`, holds the plan, the kit, the placement
results, the instruction counts and the first checks. This one holds what the second review
asked for. Nothing here was read to decide a margin.

## Instructions with an Accept-Encoding line that is not in the list

`instructions-other-line/`: `add-miss.py` adds three cases to the counting script of the first
tag's `instructions/` (the browser cases with curl's `deflate, gzip, br, zstd`), and
`count-miss.sh` counts them on the same host with the same two builds, base
`6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2` and `66fa66c49be1d60ab7ca90cb3a9a36762092c739`.
Those are also the two commits of the first tag's `instructions/`, whose own files do not name
them. `out-miss/socket-base.txt` and `socket-head.txt` are the counts, `answers.txt` says the
twelve cases' answers are the same bytes in both builds, and `zstd.txt` names the answers that
came back as zstd.

## The two new tests, on the head and on the base

`tests/precheck3.out`: `an_api_answers_the_same_whatever_mode_the_request_names` and the
`Accept` cases added to `a_request_s_mode_is_its_corten_header_s_or_its_first_accept_line_s`,
run at `1c0ecbff8` and then on the base with only those two test changes applied to it. Both
pass on both, so neither passes because of the change.

## Checks on the final head

`checks/full-checks-at-0e170186f.out`: every command in `CONTRIBUTING.md` (Checks) at
`0e170186f`, each run separately. Two smokes failed on that host:

1. `watchlist-smoke-failed.log`: one timeout in the watchlist smoke. `watchlist-smoke-again.out`
   is the same smoke run twice more against the same image.
2. `deck-builder-smoke.log`: the drag in the deck-builder smoke times out.
   `deck-builder-smoke-on-main.out` and `deck-main-*.log` are the same smoke against an image
   built from unchanged main (`6f1bbf055`) on that host, three runs.
