- Builds now reject a literal `html!` sent as a whole patch when its top-level elements show that
  a browser would drop or wrap a sibling, such as a table row after a paragraph. Request method
  bounds are unchanged, and debug builds still check composed patches when sent.
