- Requests that miss a kept `Public` page together, after its lifetime ended or a write dropped it,
  run its handler once: the others wait, within their deadline, and are given that page, or run
  their own when it is not kept. [Requests that miss a kept page together each run the handler](https://github.com/corten-run/corten/issues/1792)
