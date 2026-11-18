- Developer markup checks share an HTML scanner. They count a lone `<` as text,
  skip markup-like text inside quoted end tags and scripts, and distinguish inert
  templates from attached shadow roots when checking form hints and submit keys.
