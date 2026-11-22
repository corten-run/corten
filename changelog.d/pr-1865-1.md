- A `Public` answer is cheaper to send, about 1,100 instructions fewer measured in process: its `Cache-Control` is made once for each lifetime and is not read again unless something after the handler changed it.
  ([#1825 A Public page costs 3,300 instructions more than the same page for one visitor, before anything is kept](https://github.com/corten-run/corten/issues/1825))
