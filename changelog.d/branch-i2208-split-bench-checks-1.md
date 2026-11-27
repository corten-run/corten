- CI runs `npm run check` and the native benchmark apparatus on separate runners, so neither
  waits for the other within its time limit. Both still have to pass.
  ([#2208 smoke (benchmark-checks) ends within three minutes of its 30-minute timeout, so a slower runner cancels it](https://github.com/corten-run/corten/issues/2208))
