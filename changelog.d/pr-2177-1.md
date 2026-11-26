- An integer a view or a message writes takes fewer instructions: the writer behind each
  integer's `Render` and message argument is inlined and writes up to three digits without its
  loop ([#2171 An integer a page renders goes through a call to push_u64 that is not inlined, about 6,800 instructions a page request](https://github.com/corten-run/corten/issues/2171)).
