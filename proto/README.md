# UI prototypes

Throwaway files served by the viewer at `/proto/<file>` (html, css, js, svg, png), read fresh on every
request — edit, reload, no rebuild or restart.

- CSS-only ideas: put `name.css` here and open the page with `?css=name`; it layers over the built-in
  styles and sticks per device (`?css=` clears it).
- Bigger ideas: a standalone `name.html` using the same `/api/entries?from=N` and `/api/version` the
  real page uses.

Once something wins, port it into `src/viewer/stream.ts` and delete the prototype.
