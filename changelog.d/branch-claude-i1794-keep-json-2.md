- A `Public` page that placed a submit key it had rendered to a string (`raw`) was kept by the app, so every visitor got the first request's key; the app no longer keeps one. Caches in front are still sent it as `public`
  ([#1863 A Public JSON or text answer whose handler rendered a submit key is sent to shared caches as one any visitor may be given](https://github.com/corten-run/corten/issues/1863)).
  ([#1794 Public text, JSON and files are not kept](https://github.com/corten-run/corten/issues/1794))
