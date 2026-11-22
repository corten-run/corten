- A write at another path, a task or a job can drop the pages the app keeps
  for a change it made: `kept.changed(&url::Items)`, with `KeptAnswers` as a
  handler argument or from `App::kept`. The page is named by its route, as a
  link is, and only this process's copy is dropped
  ([#1795 A write at another URL cannot drop a kept page](https://github.com/corten-run/corten/issues/1795)).
