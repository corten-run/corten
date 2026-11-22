- A `Public` answer whose handler rendered a form's submit key to a string (in JSON, text or a
  page's `raw` markup) is now sent `private, no-cache`, as a keyed page is, so no shared cache
  gives one visitor's key to another ([#1863 A `Public` answer with a submit key its handler rendered to a string is sent to shared caches as one any visitor may be given](https://github.com/corten-run/corten/issues/1863)).
