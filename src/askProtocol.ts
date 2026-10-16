// Empirically pinned against the real `claude` CLI (see docs/superpowers/plans/
// 2026-10-12-continuity-view.md, Task 1). Mirrored by hand in src-tauri/src/asks.rs —
// change both together. A shape marked unsupported is handed to the terminal menu
// rather than guessed at.
export const MULTISELECT_ANSWERS_SUPPORTED = true;
export const MULTISELECT_JOIN = ", ";
export const MULTI_QUESTION_SUPPORTED = true;
