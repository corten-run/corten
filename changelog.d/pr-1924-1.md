- Historical benchmark reports can replay saved evidence when Windows has reused
  the process ID in a retained lock. Admission and cleanup still use their original lock checks.
  [#1888 A reused Windows process ID makes a retained benchmark fleet look active during group preparation](https://github.com/corten-run/corten/issues/1888).
