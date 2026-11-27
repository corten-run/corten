- A page route's answer with no header of its own but its type gets its `ETag` without a search
  of its header lines, about 565 fewer instructions a request; the `ETag` is the same
  ([#2173 A validator's eligibility and hash walk an answer's header lines on every request, also the scope's fixed lines known when the app is built, about 570 instructions on a tagged answer](https://github.com/corten-run/corten/issues/2173)).
