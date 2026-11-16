# Rule files from Herdr

`antigravity.toml`, `gemini.toml` and `opencode.toml` in this directory are from
Herdr, <https://github.com/herdrdev/herdr>, path `src/detect/manifests/`, at commit
`ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` (2026-10-29).

Copyright the Herdr authors. Licensed under the Apache License, Version 2.0; a copy is in
`LICENSE-APACHE-2.0` beside this file.

They are copied **unmodified**. A test in `../mod.rs` pins each file's contents, so a
change to one is a deliberate edit that must also be recorded here, as the license
requires ("You must cause any modified files to carry prominent notices stating that You
changed the files").

Changes made by Conduit: none.

The engine that reads them (`../mod.rs`) is Conduit's own code and is not derived from
Herdr's; it implements the two regions these three files use and refuses any other.
