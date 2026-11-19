- A ref-taking focus handler no longer interrupts a dialog close when one patch redraws both
  the modal and its ancestor. The surviving same-id dialog gets one `close` with the old result.
