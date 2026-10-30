import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  useStore,
  findSession,
  globalSelectedSessionId,
  activeGroup,
  baseName,
  WINDOWED,
  type Session,
  type TodoItem,
  type TodoStatus,
  type AgyUsage,
} from "./store";
import { type AgentId } from "./agents";
import { applyCliOpenPayload, inThisWindow, type CliOpenPayload } from "./cliOpen";
import { askGateOpen, askResolvedPlan, askShouldHandOff, type PendingAsk } from "./asks";
import { parseBy, resolutionHold, type PendingPermission } from "./permissionView";
import { handedOff, handOffView } from "./askHandoff";
import { effectiveCenterMode } from "./centerViews";
import { type PendingDiff } from "./ideBridge";
import {
  isEditableTarget,
  isInTerminal,
  isMacPlatform,
  tabSwitchDigit,
} from "./keyboardGuards";

import { type ChatItem } from "./rootChat";
import { type PendingDecision } from "./rootProposals";
import { awaitsUser, holdsOffWorking, notificationStatus } from "./statusRules";
import { type ThemePref } from "./themes";
import { useClaudeAmbient } from "./hooks/useClaudeAmbient";
import { useAutoStopIdle } from "./hooks/useAutoStopIdle";
import { useSessionDirs } from "./hooks/useSessionDirs";
import { useSessionContext } from "./hooks/useSessionContext";
import { getLastFocusedEditor } from "./monaco/setup";
import { Sidebar } from "./components/Sidebar";
import { RootChatView } from "./components/RootChatView";
import { WorkspaceCenter } from "./components/WorkspaceCenter";
import { RightColumn } from "./components/RightColumn";
import { Onboarding } from "./components/Onboarding";
import { UpdateNotice } from "./components/UpdateNotice";
import { TmuxNotice } from "./components/TmuxNotice";
import { ConversationRepairNotice } from "./components/ConversationRepairNotice";
import { Toasts } from "./components/Toasts";
import { AskDock } from "./components/AskDock";
import { PermissionDock } from "./components/PermissionCard";
import { PairPrompt } from "./components/PairPrompt";
import type { PairRequest } from "./mobilePairing";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PendingDecisions } from "./components/PendingDecisions";
import { Settings } from "./components/Settings";
import { QuickOpen } from "./components/QuickOpen";
import { SearchPalette } from "./components/SearchPalette";
import { CommandPalette } from "./components/CommandPalette";
import { useTelemetry } from "./hooks/useTelemetry";
import { useUpdater } from "./hooks/useUpdater";
import { useFileWatch } from "./hooks/useFileWatch";
import { useHotExit } from "./hooks/useHotExit";
import { useStoreSync } from "./hooks/useStoreSync";
import { initPlugins, feedHook, feedFleet } from "./plugins";

/** How long an answered question card stays up showing its done state. */
const ASK_DONE_HOLD_MS = 1600;
/** Longer when the answer came from elsewhere: "Answered on your phone" is news to read. */
const REMOTE_DONE_HOLD_MS = 2600;
/** A resolved permission card's hold. Covers the Deny caveat, the longest line it shows. */
const PERMISSION_DONE_HOLD_MS = 3200;

/** Permission ids already resolved, so a stale catch-up cannot resurrect one. Bounded. */
const resolvedPermissions = new Set<string>();
function rememberResolvedPermission(id: string) {
  resolvedPermissions.add(id);
  if (resolvedPermissions.size > 128) {
    const oldest = resolvedPermissions.values().next().value;
    if (oldest !== undefined) resolvedPermissions.delete(oldest);
  }
}

interface HookPayload {
  session: string;
  event: string;
  body: any;
}

// Menu-dispatched Monaco editor actions (Find, Replace, …): refocus the last-focused
// editor — menu clicks land after focus has left it — then run the action by id.
function runEditorAction(id: string): void {
  const ed = getLastFocusedEditor();
  if (ed) {
    ed.focus();
    void ed.getAction(id)?.run();
  }
}


/** An incoming ask (live or catch-up). One for the terminal the user is already watching
 *  goes straight back to it and never becomes a card: adding it first would flash a docked
 *  card for a frame and then toast about moving it. If the hand-off fails, show the card. */
function admitAsk(a: PendingAsk) {
  const s = useStore.getState();
  if (handedOff.has(a.id) || a.id in s.asks) return;
  if (askShouldHandOff(a, handOffView(s))) {
    handedOff.add(a.id);
    void invoke<boolean>("ask_handoff", { id: a.id }).catch(() => {
      handedOff.delete(a.id);
      useStore.getState().addAsk(a);
    });
    return;
  }
  s.addAsk(a);
}

export default function App() {
  // Poll Claude + agy usage at the app root so it refreshes for every account regardless of
  // which agent is selected or whether the sidebar is collapsed (both would unmount a
  // sidebar-hosted poller).
  useClaudeAmbient();
  useAutoStopIdle();
  useSessionDirs();
  useSessionContext();
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const home = useStore((s) => s.homeDir);
  const load = useStore((s) => s.load);
  const loadAgents = useStore((s) => s.loadAgents);
  const agentSetupComplete = useStore((s) => s.agentSetupComplete);
  const telemetryOptOut = useStore((s) => s.telemetryOptOut);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const rootChatActive = useStore((s) => s.selectedRootChatId !== null);
  const showSettings = useStore((s) => s.showSettings);
  const settingsTab = useStore((s) => s.settingsTab);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const newProjectDialog = useStore((s) => s.newProjectDialog);
  const setNewProjectDialog = useStore((s) => s.setNewProjectDialog);

  // Anonymous engagement heartbeat; no-op while opted out (Settings/onboarding).
  useTelemetry(telemetryOptOut);

  // Background auto-update checks (launch + every 6h while visible).
  useUpdater();

  // Single app-level poll: silently reload clean open files an agent edits on disk.
  useFileWatch();

  // Hot exit's crash net: debounced backups of dirty buffers to the app-data dir.
  useHotExit();

  // Cross-window convergence: debounced refetch + merge off Rust's `store-saved` broadcast.
  useStoreSync();

  // macOS exits native fullscreen on an unconsumed Escape (AppKit cancelOperation).
  // Swallow the OS default at the window level — bubble phase, so terminal/dialog
  // Escape handling has already run — and keep the app in fullscreen.
  // (Composing Escape is left to the IME — it consumes it before AppKit would.)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘P / ⌘⇧F palettes (menu-dispatched; rendered at the app root like Settings).
  const [palette, setPalette] = useState<"quickopen" | "search" | "commands" | null>(null);

  useEffect(() => {
    // Discover + start enabled plugins, but only on the main window. `windowProfile`
    // resolves async inside `load()` (the `window_profile` IPC round trip) and is not
    // known yet on this first render — it starts at its main/Default default (see
    // `windowProfile`'s initial state in store.ts) — so this reads the store's verdict
    // AFTER `load()` settles rather than off the stale value closed over here. Success-only
    // `.then`, with an explicit no-op rejection arm (not `.finally`): `load()`'s
    // `load_projects` call has no `.catch`, so on a total rejection `windowProfile` is
    // never corrected and still reads its main/Default default — including in a
    // SECONDARY window, where that default is simply wrong. load failed → no state, no
    // plugin host, in any window: the app is already broken, and a window whose state
    // never loaded has no use for a plugin host either way.
    //
    // Report this window's `WINDOWED` pref to Rust as early as possible, independent of
    // `load()` -- the cli-open sink's pending-open path (`hooks.rs`'s `WindowModeFlag`)
    // must know whether ANY window is in window mode before it can safely decide that a
    // `label_for` miss means "no window for this profile" rather than merely "not the
    // active profile" (which is the normal case in switch mode with more than one
    // profile). Every window reports the same machine-level value, so this races
    // harmlessly across windows and is idempotent.
    void invoke("set_profile_window_mode", { windowed: WINDOWED }).catch(() => {});
    void load().then(
      () => {
        if (useStore.getState().windowProfile.isMain) void initPlugins();
        // Finding 1's pending-open queue: drain whatever `conduit <path> [--agent <id>]
        // [--worktree <slug>] [--name <text>] [--prompt-file <file>]` invocations (each a
        // resolved payload carrying the prompt text) the Rust cli-open sink queued for THIS window's label while it had
        // no live window to emit to yet (a project's own profile had none open, and
        // there was nothing to redirect the payload to). Runs in every window, not just
        // main -- any window's label can be the one a queued open was addressed to.
        // Applied in order, one at a time (never in parallel): each may add/select a
        // project and spawn a session, and `applyCliOpenPayload` reads/writes store
        // state that a concurrent second call could race.
        invoke<CliOpenPayload[]>("take_pending_opens")
          .then(async (opens) => {
            for (const open of opens) await applyCliOpenPayload(open);
          })
          .catch(() => {});
        // Work root chat proposed while this window was closed: catch up now that
        // `st.projects`/`st.profiles`/`st.windowProfile` are populated. Finding 5: this
        // used to fire from its own mount effect, racing `load()` -- when the
        // `list_pending_decisions` fetch resolved first, its per-window filter ran
        // against the store's EMPTY boot defaults (`projects: []`, `profiles: []`,
        // `windowProfile: { profileId: null, isMain: true }`), under which
        // `inThisWindow` finds every card's (missing) profile trivially matching this
        // window's (null) default and accepts it -- every OTHER window's cards too, in
        // every window, until the next reload happened to lose the race the other way.
        void useStore.getState().loadPendingDecisions((projectId) => {
          const st = useStore.getState();
          const cardProfile = () => st.projects.find((p) => p.id === projectId)?.profileId;
          return inThisWindow(cardProfile, st.windowProfile.profileId, st.profiles);
        });
      },
      () => {},
    );
    void loadAgents();
  }, [load, loadAgents]);

  // Suppress the webview's default context menu (Reload / Inspect Element).
  // Our own row menus call preventDefault + stopPropagation, so they're unaffected —
  // and Monaco's context menu (contextmenu contrib) is its own widget, not the native
  // menu, so preventDefault here doesn't block it either.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Window-level (capture-phase) tab-navigation shortcuts. Everything else stays a
  // native menu accelerator; these two can't:
  // - ⌃Tab/⌃⇧Tab: muda maps Key::Tab to the ⇥ display glyph as the NSMenuItem
  //   keyEquivalent, which AppKit never matches against a real Tab keypress, so the
  //   Window-menu accelerator is display-only on macOS. Capture phase because xterm
  //   cancels Tab-family keydowns before they'd bubble out of a focused terminal.
  // - ⌘1..9 on macOS / Alt+1..9 on Windows and Linux (9 = last, browser convention).
  //   The modifier splits by platform because ctrl+digit is a real terminal input
  //   (ctrl+3 = ESC would interrupt the agent) and meta is the reserved Windows key --
  //   see `tabSwitchDigit`, which owns that decision and is tested.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      const digit = tabSwitchDigit(e, isMacPlatform(navigator.platform || navigator.userAgent));
      if (digit !== null) {
        e.preventDefault();
        useStore.getState().activateTabAt(digit);
        return;
      }
      // ⇧⌘B: toggle the task board overlay for the selected project (no native menu
      // accelerator wired yet, so handled here like the other window-level shortcuts).
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") {
        const st = useStore.getState();
        if (!st.selectedProjectId || !st.boardEnabled) return;
        e.preventDefault();
        // setCenterMode also closes the global canvas (three-way exclusion).
        st.toggleCenterMode(st.selectedProjectId);
      }
      // ⇧⌘K: toggle the Continuity view for the selected project.
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        const st = useStore.getState();
        if (!st.selectedProjectId || !st.continuityViewEnabled) return;
        // Same guard as ⇧⌘C below: on Windows/Linux Ctrl+Shift+K inside a terminal is the
        // terminal's, and an editable field keeps its own keys on every platform.
        const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
        if (isInTerminal(e.target) ? !isMac : isEditableTarget(e.target)) return;
        e.preventDefault();
        st.toggleCenterMode(st.selectedProjectId, "continuity");
        return;
      }
      // ⇧⌘C: toggle the global canvas. Unlike ⇧⌘B above, this needs no selected project —
      // the canvas is global — and no native menu accelerator claims CmdOrCtrl+Shift+C
      // (verified against src-tauri/src/menu.rs).
      //
      // On Windows/Linux, Ctrl+Shift+C is ALSO Terminal.tsx's own copy shortcut, and this
      // listener runs in the capture phase -- so a blanket `.term-host` guard (as the
      // other three window-level canvas key listeners use) blocked the toggle from firing
      // at ALL while any terminal was focused, on every platform. A focused agent terminal
      // is the app's DEFAULT state (a pane pulls focus on reveal), so that made the
      // shortcut printed in the button's own tooltip mostly inert, and worse, left no
      // keyboard way out of the canvas at all from a focused card (Escape is correctly
      // still blocked in a terminal, since it interrupts the agent). The real collision is
      // narrower than a blanket guard: only Ctrl+Shift+C-as-copy, and only on
      // Windows/Linux (see the `!e.shiftKey` added to Terminal.tsx's macCopy, which closes
      // the equivalent mac overlap at the source instead). An editable field (a note's
      // textarea, a section's rename input) still blocks unconditionally on every
      // platform, same as the other three listeners.
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c") {
        const isMac = isMacPlatform(navigator.platform || navigator.userAgent);
        if (isInTerminal(e.target) ? !isMac : isEditableTarget(e.target)) return;
        // Canvas pref off: inert (leave the key to the terminal / default behaviour).
        if (!useStore.getState().canvasEnabled) return;
        e.preventDefault();
        const s = useStore.getState();
        s.setCanvasOpen(!s.canvasOpen);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Claude Code hook events relayed by the Rust HTTP listener.
  useEffect(() => {
    // Sessions whose current turn is parked on a question to the user: a tool that asks
    // (AskUserQuestion, a plan to approve) or a permission prompt. Claude's `idle_prompt`
    // fires there once the user has not answered for a minute, and must read as "waiting
    // on you" rather than as a stuck turn -- `idle` is what the idle auto-stop retires.
    // Not store state: nothing renders it, it only qualifies the next notification.
    const awaiting = new Set<string>();
    const unlisten = listen<HookPayload>("hook", ({ payload }) => {
      feedHook(payload);
      const { session, event, body } = payload;
      const st = useStore.getState();
      // The UI-state feed below applies only for sessions whose project is in THIS
      // window (plugin feed above is already main-only via initPlugins). A session not
      // found locally normalizes to Default, same as everywhere else in profiles.ts.
      if (
        !inThisWindow(
          () => findSession(st.projects, session)?.project.profileId,
          st.windowProfile.profileId,
          st.profiles,
        )
      ) {
        return;
      }
      // Newer Claude CLIs put `permission_mode` in every hook body — capture it
      // wherever it appears so the chat's mode chip can show real state. Absent on
      // older CLIs, in which case the chip stays label-only.
      if (typeof body?.permission_mode === "string") {
        st.setPermissionMode(session, body.permission_mode);
      }
      if (event === "prompt" || event === "tooluse" || event === "stop" || event === "sessionend") {
        awaiting.delete(session);
      }
      switch (event) {
        case "prompt":
          st.setStatus(session, "running");
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          void maybeAutoName(session, body?.prompt);
          break;
        case "todos":
          applyTodos(body?.tool_input, session);
          break;
        case "tooluse":
          if (body?.tool_name === "TodoWrite") applyTodos(body?.tool_input, session);
          break;
        case "pretool": {
          // Fires before each tool runs: a more responsive "running" plus a
          // live label of what it's doing. TodoWrite is shown in the To-dos panel.
          //
          // Held off briefly after a turn ends: Claude runs hooks in parallel, so this can
          // arrive behind that turn's `stop` and would otherwise leave a finished session
          // showing as busy forever. See statusRules.ts.
          const cur = st.live[session];
          if (holdsOffWorking(cur?.status, cur?.updatedAt, Date.now())) break;
          if (awaitsUser(body?.tool_name)) awaiting.add(session);
          else awaiting.delete(session);
          st.setStatus(session, "running");
          st.setCompacting(session, false);
          st.setActivity(session, toolActivity(agentOf(session), body?.tool_name, body?.tool_input));
          break;
        }
        case "precompact":
          st.setCompacting(session, true);
          break;
        case "sessionstart":
          // New or resumed session: clear any stale transient state.
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          break;
        case "sessionend":
          st.setStatus(session, "idle");
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          break;
        case "stop":
          st.setStatus(session, "done");
          st.setActivity(session, undefined);
          st.setCompacting(session, false);
          notifyIfAway(session, "finished");
          break;
        case "notification": {
          // One event name, four situations. `statusRules` says which — and undefined
          // means this one is informational, so the badge (and any alert) stays put.
          const cur = st.live[session];
          const next = notificationStatus(
            body?.notification_type,
            cur?.status,
            awaiting.has(session),
          );
          if (next === undefined) break;
          // A permission prompt is a question too. Remembered even when the badge below is
          // skipped for the session in front of the user, which stays `running` meanwhile.
          if (next === "needsInput") awaiting.add(session);
          if (next === "idle") {
            // The `idle_prompt` rescue: the CLI is back at its prompt with no turn-end hook
            // ever having fired (Esc during a tool call). Nothing was accomplished, so this
            // is a silent correction, not something to notify about.
            st.setStatus(session, "idle");
            st.setActivity(session, undefined);
            break;
          }
          const active =
            globalSelectedSessionId(st) === session && document.hasFocus();
          if (!active) {
            st.setStatus(session, next);
            doNotify(session, body?.message ?? "needs your input");
          }
          break;
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // The Rust stale-working watchdog's verdict. A session leaves `running` only when
  // something says so, and Esc during a tool call / a killed CLI / a slept machine all say
  // nothing at all. Rust is the single decider (see status_rules.rs); this listener is how
  // its answer reaches the sidebar instead of the frontend inventing a second timeout.
  useEffect(() => {
    const unlisten = listen<string[]>("session-stale", ({ payload }) => {
      const st = useStore.getState();
      // Same guard as the `hook` listener above: mirror the stale verdict into UI state
      // only for sessions whose project is in THIS window.
      const ids = (payload ?? []).filter((id) =>
        inThisWindow(
          () => findSession(st.projects, id)?.project.profileId,
          st.windowProfile.profileId,
          st.profiles,
        ),
      );
      st.markStale(ids);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // A Claude session's resume failed and the bare `|| claude` fallback started a NEW
  // conversation. Rust has already switched the session onto it (so the next launch reopens
  // what is on screen), but the user just watched their history vanish -- say where it went.
  useEffect(() => {
    const unlisten = listen<{ session: string; previous: string; current: string }>(
      "conversation-restarted",
      ({ payload }) => {
        const found = findSession(useStore.getState().projects, payload.session);
        const name = found ? `"${found.session.name}"` : "A session";
        useStore
          .getState()
          .pushToast(
            `${name} couldn't reopen its previous conversation, so Claude started a new one. ` +
              `The previous one is still on disk — run /resume in that session to go back to it.`,
            "error",
          );
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Root chat stream: items/done/error pushed by the per-message `claude -p` child. Every
  // open window receives the broadcast regardless of target (root_mcp.rs emits via plain
  // `app.emit`), so each guards by the CHAT's own profile -- a chat not yet known locally
  // normalizes to Default, same as everywhere else in profiles.ts.
  useEffect(() => {
    const unItem = listen<{ chatId: string; item: ChatItem }>("root-chat-item", ({ payload }) => {
      const st = useStore.getState();
      const chatProfile = () => st.rootChats.find((c) => c.id === payload.chatId)?.profileId;
      if (!inThisWindow(chatProfile, st.windowProfile.profileId, st.profiles)) return;
      st.rootChatItemArrived(payload.chatId, payload.item);
    });
    const unDone = listen<{ chatId: string }>("root-chat-done", ({ payload }) => {
      const st = useStore.getState();
      const chatProfile = () => st.rootChats.find((c) => c.id === payload.chatId)?.profileId;
      if (!inThisWindow(chatProfile, st.windowProfile.profileId, st.profiles)) return;
      st.rootChatDone(payload.chatId);
    });
    const unErr = listen<{ chatId: string; message: string }>(
      "root-chat-error",
      ({ payload }) => {
        const st = useStore.getState();
        const chatProfile = () => st.rootChats.find((c) => c.id === payload.chatId)?.profileId;
        if (!inThisWindow(chatProfile, st.windowProfile.profileId, st.profiles)) return;
        st.rootChatFailed(payload.chatId, payload.message);
      },
    );
    return () => {
      void unItem.then((f) => f());
      void unDone.then((f) => f());
      void unErr.then((f) => f());
    };
  }, []);

  // Work root chat proposed. The mount-time catch-up fetch (a proposal made while this
  // window was closed must not be lost) is fired from the `load()` success arm above,
  // not here -- see that effect's own comment (Finding 5) for why it must wait for
  // `st.projects`/`st.profiles`/`st.windowProfile` to actually be populated before its
  // per-window filter can mean anything.
  useEffect(() => {
    // Each card's routing table is fetched for the CARD's OWN project by
    // `loadPendingDecisions`/`decisionArrived` (see `decisionRoutes`). It must NOT come
    // from the shared `routes` slot: that is globals-only when loaded with `null`, and it
    // is also written by the new-session dialog and the routing panel, so a card for
    // project Y would be routed by whichever project was opened last.
    const unPending = listen<PendingDecision>("pending-decision", ({ payload }) => {
      // A card carries its own project (not a profile field directly) -- route by that
      // project's profile, same broadcast-vs-target-window reasoning as root chat above.
      const st = useStore.getState();
      const cardProfile = () => st.projects.find((p) => p.id === payload.projectId)?.profileId;
      if (!inThisWindow(cardProfile, st.windowProfile.profileId, st.profiles)) return;
      st.decisionArrived(payload);
    });
    const unCreated = listen<{ id: string; title: string; seed: string }>(
      "root-chat-created",
      ({ payload }) => {
        // The `chat_fork` MCP tool tells the model its seed was "seeded" as the new
        // chat's first message — so it must actually be sent, or the model is told
        // work happened that never did. `loadRootChats` first so the chat this send
        // targets is in the store (Rust already created it before emitting this event).
        // `loadRootChats` runs in every window (harmless -- it's the same reconciling
        // fetch every window already does); only the window whose profile matches the
        // new chat actually sends the seed, or a broadcast fork would fire once per open
        // window instead of once.
        void useStore
          .getState()
          .loadRootChats()
          .then(() => {
            if (!payload.seed) return;
            const st = useStore.getState();
            const chatProfile = () => st.rootChats.find((c) => c.id === payload.id)?.profileId;
            if (!inThisWindow(chatProfile, st.windowProfile.profileId, st.profiles)) return;
            void st.sendRootChat(payload.id, payload.seed);
          });
      },
    );
    return () => {
      void unPending.then((f) => f());
      void unCreated.then((f) => f());
    };
  }, []);

  // agy usage snapshots pushed by the status-line helper via the Rust hook server.
  useEffect(() => {
    const st = useStore.getState();
    void st.refreshAgyUsage();
    void st.refreshAgyUsageTracking();
    const unlisten = listen<AgyUsage>("agyusage", ({ payload }) => {
      useStore.getState().setAgyUsage(payload);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Session persistence: probe for tmux and push the persisted preference down to Rust
  // before anything spawns, so the first session of the launch is wrapped (or not)
  // according to the setting rather than the backend's own default. The quit guard also
  // reads the result — it decides between "will be stopped" and "keeps running", and
  // getting that backwards changes whether someone cancels.
  useEffect(() => {
    void useStore.getState().probeTmux();
  }, []);

  // Native menu clicks relayed by Rust as a "menu" event whose payload is the item id.
  // Window-scoped (not the plain top-level `listen`): Rust's on_window_event now
  // targets a specific window's label with `emit_to` for close-window/quit
  // (window_registry design, Task 4), and a plain `listen(...)` here registers as
  // EventTarget::Any, which Tauri's listener-side match always matches regardless of
  // the emitter's target -- so every open window's Any-scoped listener would ALSO fire
  // for an event meant for only one of them. A window-scoped listener still receives
  // every broadcast `app.emit(...)` (menu.rs's other custom ids, e.g. Cmd+T/palette),
  // since a broadcast passes no filter and matches every listener unconditionally.
  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<string>("menu", ({ payload }) => {
      const st = useStore.getState();
      switch (payload) {
        case "settings":
          st.setShowSettings(true);
          break;
        case "about":
          st.setSettingsTab("about");
          st.setShowSettings(true);
          break;
        case "toggle-sidebar":
          st.toggleSidebar();
          break;
        case "toggle-right":
          st.toggleRight();
          break;
        case "save": {
          const layout = st.selectedProjectId ? st.layouts[st.selectedProjectId] : undefined;
          const g = activeGroup(layout);
          const tab = g?.tabs.find((t) => t.ref === g.activeRef);
          if (tab?.kind === "file") void st.saveFile(tab.ref);
          break;
        }
        case "save-all":
          void st.saveAll();
          break;
        case "reopen-tab":
          st.reopenClosedTab();
          break;
        case "reveal-active": {
          const layout = st.selectedProjectId ? st.layouts[st.selectedProjectId] : undefined;
          const g = activeGroup(layout);
          const tab = g?.tabs.find((t) => t.ref === g.activeRef);
          if (tab?.kind === "file") st.revealInTree(tab.ref);
          break;
        }
        case "next-tab":
          st.cycleTab(1);
          break;
        case "prev-tab":
          st.cycleTab(-1);
          break;
        case "toggle-word-wrap":
          st.toggleWordWrap();
          break;
        case "toggle-trim-on-save":
          st.toggleTrimOnSave();
          break;
        case "zoom-in":
          st.setFontZoom(st.fontZoom + 1);
          break;
        case "zoom-out":
          st.setFontZoom(st.fontZoom - 1);
          break;
        case "zoom-reset":
          st.setFontZoom(0);
          break;
        case "toggle-maximize":
          if (st.selectedProjectId) st.toggleMaximizeGroup(st.selectedProjectId);
          break;
        case "toggle-board":
          if (st.selectedProjectId && st.boardEnabled) st.toggleCenterMode(st.selectedProjectId);
          break;
        case "command-palette":
          setPalette("commands");
          break;
        case "quick-open":
          setPalette("quickopen");
          break;
        case "find-in-files":
          setPalette("search");
          break;
        case "format-document":
          void st.formatActiveDocument();
          break;
        case "toggle-diff": {
          const layout = st.selectedProjectId ? st.layouts[st.selectedProjectId] : undefined;
          const g = activeGroup(layout);
          const tab = g?.tabs.find((t) => t.ref === g.activeRef);
          if (tab?.kind === "file") st.requestDiff(tab.ref, "toggle");
          break;
        }
        case "quit": {
          // Rust forwards quit here when it saw a nonzero dirty count OR a running agent
          // (menu.rs quit arm / CloseRequested handler). Two gates: (1) a running-agent confirm
          // (killing them interrupts in-progress work — history is safe, but ask first), then
          // (2) hot exit for dirty editor buffers (silent backup; the data-loss dialog only
          // appears if the backup WRITE fails).
          void (async () => {
            const cur = useStore.getState();
            const running = cur.projects
              .flatMap((p) => p.sessions)
              .filter((s) => cur.live[s.id]?.status === "running");
            // The frontend `live` map can lag the Rust hook mirror; consult the authoritative
            // Rust signal too so a real running agent never gets silently killed on quit.
            const rustRunning = await invoke<boolean>("any_agent_running").catch(() => false);
            if (running.length > 0 || rustRunning) {
              const names = running.map((s) => s.name).join(", ");
              const who = names || "an agent";
              const plural = running.length > 1;
              // With session persistence on, quitting no longer stops the agent — it keeps
              // running under tmux and the next launch attaches to it. Still worth asking
              // (a user quitting mid-turn should know), but the old copy would now be a
              // lie, and "will be stopped" vs "keeps working" is the difference between
              // cancelling and not.
              const persists = cur.persistSessions && cur.tmuxAvailable !== false;
              const subject = plural ? `${running.length} sessions are` : `${who} is`;
              const suffix = names && plural ? ` (${names})` : "";
              const okRun = await ask(
                persists
                  ? `${subject} still working${suffix}. Quit? ${plural ? "They" : "It"} will keep running in the background, and Conduit will reattach next launch.`
                  : `${subject} still working${suffix}. Quit and stop ${plural ? "them" : "it"}? Conversation history is kept.`,
                {
                  title: "Conduit",
                  kind: persists ? "info" : "warning",
                  okLabel: persists ? "Quit" : "Quit Anyway",
                  cancelLabel: "Cancel",
                },
              );
              if (!okRun) return; // cancel — window stays open (prevent_close already held it)
            }
            const flushed = await st.flushHotExit();
            const n = Object.keys(st.dirty).length;
            const ok =
              flushed ||
              n === 0 ||
              (await ask(
                `Quit with unsaved changes? Backing them up failed — ${n} file${n === 1 ? " has" : "s have"} unsaved edits that will be lost.`,
                { title: "Conduit", kind: "warning", okLabel: "Quit Anyway", cancelLabel: "Cancel" },
              ));
            if (ok) await invoke("quit_app").catch(() => {});
          })();
          break;
        }
        case "close-window": {
          // Rust forwards this here when this window is a SECONDARY one being closed
          // (not the last window) with a nonzero per-window dirty count (`DirtyGuard`,
          // lib.rs `CloseRequested`); a running agent never gates a window close, only
          // quit -- sessions persist under tmux regardless of which windows are open.
          // `st.dirty` is this window's OWN dirty set (Monaco buffers only ever open for
          // projects THIS window mounts), so no extra profile filtering is needed here --
          // unlike `quit`'s single-window total, this mirrors just the dirty-buffer half
          // of that flow.
          void (async () => {
            const flushed = await st.flushHotExit();
            const n = Object.keys(st.dirty).length;
            const ok =
              flushed ||
              n === 0 ||
              (await ask(
                `Close this window with unsaved changes? Backing them up failed — ${n} file${n === 1 ? " has" : "s have"} unsaved edits that will be lost.`,
                { title: "Conduit", kind: "warning", okLabel: "Close Anyway", cancelLabel: "Cancel" },
              ));
            if (ok) void invoke("close_window", { label: st.windowProfile.label });
          })();
          break;
        }
        case "close-tab": {
          const layout = st.selectedProjectId ? st.layouts[st.selectedProjectId] : undefined;
          const g = activeGroup(layout);
          if (st.selectedProjectId && g && g.activeRef)
            void st.requestCloseTab(st.selectedProjectId, g.id, g.activeRef);
          break;
        }
        case "new-session":
          if (st.selectedProjectId) void st.addSession(st.selectedProjectId);
          break;
        case "open-project":
          void (async () => {
            const dir = await open({ directory: true, multiple: false, title: "Add Project" });
            if (typeof dir === "string") await st.addProject(dir);
          })();
          break;
        case "new-project":
          st.setNewProjectDialog("create");
          break;
        case "clone-repo":
          st.setNewProjectDialog("clone");
          break;
        case "find":
          runEditorAction("actions.find");
          break;
        case "replace":
          // No-ops on read-only editors (the action's implementation bails on
          // EditorOption.readOnly), same as VS Code.
          runEditorAction("editor.action.startFindReplaceAction");
          break;
        case "theme:auto":
        case "theme:warm-light":
        case "theme:warm-dim":
        case "theme:warm-near-black": {
          const pref = payload.slice("theme:".length);
          st.setThemePref(pref as ThemePref);
          break;
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Mobile bridge asks to wake an idle session (a phone `/conduit use` on a session
  // whose PTY isn't live yet): open + activate its tab so the TerminalView mounts
  // and spawns the PTY, which the bridge is polling for.
  useEffect(() => {
    const un = listen<{ sessionId: string }>("bridge-open-session", ({ payload }) => {
      const st = useStore.getState();
      const found = findSession(st.projects, payload.sessionId);
      if (!found) return;
      if (!inThisWindow(() => found.project.profileId, st.windowProfile.profileId, st.profiles)) {
        return;
      }
      st.selectSession(found.project.id, payload.sessionId);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Conduit-as-IDE (2026-09-23 spec): a connected claude's openDiff parks in Rust and
  // surfaces here as a review card; openFile opens the file in the session's
  // project's editor; diff-closed drops reviews the user answered in the terminal
  // instead (claude resolved its side and closed the tab).
  useEffect(() => {
    const unDiff = listen<PendingDiff>("ide-open-diff", ({ payload }) => {
      useStore.getState().ideDiffArrived(payload);
    });
    const unOpen = listen<{ sessionId: string; filePath: string }>(
      "ide-open-file",
      ({ payload }) => {
        const st = useStore.getState();
        const found = findSession(st.projects, payload.sessionId);
        if (found) st.openFile(found.project.id, payload.filePath);
      },
    );
    const unClosed = listen<{ sessionId: string; tabName: string | null }>(
      "ide-diff-closed",
      ({ payload }) => {
        useStore.getState().ideDiffsClosed(payload.sessionId, payload.tabName);
      },
    );
    return () => {
      void unDiff.then((f) => f());
      void unOpen.then((f) => f());
      void unClosed.then((f) => f());
    };
  }, []);

  // The `conduit` CLI launcher. The Rust side has already focused the window; this
  // owns what the app then shows. Window-scoped for the same reason the "menu" listener
  // above is: Rust's hook server now resolves ONE target window (the matched project's
  // own profile window, else the focused window, else "main") and `emit_to`s it, so a
  // plain top-level `listen(...)` here -- EventTarget::Any -- would fire in every open
  // window regardless of that target, reopening the double-`add_project` bug this
  // targeting exists to kill.
  useEffect(() => {
    const un = getCurrentWebviewWindow().listen<CliOpenPayload>("cli-open", ({ payload }) => {
      void applyCliOpenPayload(payload);

    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Conductor fleet events emitted by the in-app MCP server.
  useEffect(() => {
    const unSpawn = listen<{ projectId: string; session: Session; task?: string }>(
      "fleet-spawn",
      ({ payload }) => {
        const st = useStore.getState();
        const spawnProfile = () => st.projects.find((p) => p.id === payload.projectId)?.profileId;
        // Skip the mount/select side effect when the spawned session's project isn't
        // this window's -- the STORE still converges via the `store-saved` broadcast
        // (Task 9), so appending it here too would be redundant, and opening a tab in
        // this window's layout for a project it doesn't show would be outright wrong.
        if (inThisWindow(spawnProfile, st.windowProfile.profileId, st.profiles)) {
          st.mergeSpawnedSession(payload.projectId, payload.session, payload.task);
        }
        feedFleet("fleet.spawn", { session: payload.session.id });
      },
    );
    const unConfirm = listen<{
      requestId: string;
      sessionId: string;
      name: string;
      branch: string;
      dirty: boolean;
    }>("conductor-confirm", ({ payload }) => {
      const st = useStore.getState();
      const workerProfile = () => findSession(st.projects, payload.sessionId)?.project.profileId;
      // Guarded by the worker session's own project: this is a broadcast (fleet.rs
      // `app.emit`), so every open window would otherwise pop the SAME confirm dialog for
      // a worker only one window's sidebar can even show. A window that skips it answers
      // nothing; Rust's own 60s timeout already default-denies if no window responds.
      if (!inThisWindow(workerProfile, st.windowProfile.profileId, st.profiles)) {
        return;
      }
      // Stop kills the worker's running process; its worktree files stay on disk.
      const where = payload.branch ? ` (${payload.branch})` : "";
      const msg = payload.dirty
        ? `The Conductor wants to stop "${payload.name}"${where}.\n\nIt has uncommitted changes — those stay on disk, but its running process will be terminated. Allow?`
        : `The Conductor wants to stop "${payload.name}"${where}. Its running process will be terminated. Allow?`;
      const approved = window.confirm(msg);
      void invoke("conductor_confirm_response", {
        requestId: payload.requestId,
        approved,
      }).catch(() => {});
    });
    return () => {
      void unSpawn.then((f) => f());
      void unConfirm.then((f) => f());
    };
  }, []);

  // AskUserQuestion cards (asks.rs): live requests, resolutions, and a catch-up for asks
  // raised before this window loaded. Both listeners are registered BEFORE the catch-up
  // fetch: an ask raised between a fetch and a later registration would get no card for
  // the whole 600 s ceiling.
  useEffect(() => {
    let disposed = false;
    const uns: (() => void)[] = [];
    void (async () => {
      const ready = await Promise.all([
        listen<PendingAsk>("ask-request", ({ payload }) => admitAsk(payload)),
        listen<{ id: string; how: string; by?: string }>("ask-resolved", ({ payload }) => {
          const s = useStore.getState();
          const by = parseBy(payload.by);
          const plan = askResolvedPlan({
            how: payload.how,
            by,
            shown: payload.id in s.asks,
            handedOffHere: handedOff.has(payload.id),
          });
          // An answer from a card: Rust resolves before the card's own ask_answer reply lands,
          // so hold the card long enough for its "Sent to …" confirmation to be seen — and
          // stop it reading as "needs you" meanwhile. An answer from elsewhere (the phone,
          // the terminal, another window) holds a little longer so the card can say where.
          if (plan.answered) s.markAskAnswered(payload.id);
          if (plan.note) s.noteAskResolved(payload.id, plan.note);
          if (plan.hold) {
            const ms = plan.note && plan.note !== "desktop" ? REMOTE_DONE_HOLD_MS : ASK_DONE_HOLD_MS;
            setTimeout(() => useStore.getState().removeAsk(payload.id), ms);
          } else s.removeAsk(payload.id);
          handedOff.delete(payload.id);
          if (plan.toast) s.pushToast("Question moved to the session's terminal");
        }),
      ]).catch(() => [] as (() => void)[]);
      if (disposed) {
        ready.forEach((f) => f());
        return;
      }
      uns.push(...ready);
      const list = await invoke<PendingAsk[]>("ask_pending").catch(() => [] as PendingAsk[]);
      if (!disposed) list.forEach(admitAsk);
    })();
    const onFocus = () => useStore.getState().setWindowFocused(true);
    const onBlur = () => useStore.getState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      disposed = true;
      uns.forEach((f) => f());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Tool-permission cards (broker.rs). Same contract as the ask cards: both listeners are
  // registered BEFORE the `permission_pending` catch-up, so one raised in between still
  // gets a card. A catch-up that read a permission just before it resolved must not bring
  // the card back, hence `resolvedPermissions`.
  useEffect(() => {
    let disposed = false;
    const uns: (() => void)[] = [];
    const admit = (p: PendingPermission) => {
      if (!resolvedPermissions.has(p.id)) useStore.getState().addPermission(p);
    };
    void (async () => {
      const ready = await Promise.all([
        listen<PendingPermission>("permission-request", ({ payload }) => admit(payload)),
        listen<{ id: string; by?: string }>("permission-resolved", ({ payload }) => {
          const s = useStore.getState();
          const by = parseBy(payload.by);
          rememberResolvedPermission(payload.id);
          // A card hidden behind its own terminal (the dock's hand-off rule) was never seen:
          // drop it now, or looking away during the hold would surface a stale card.
          const held = s.permissions[payload.id];
          if (resolutionHold(by, !!held && !askShouldHandOff(held, handOffView(s)))) {
            s.notePermissionResolved(payload.id, by!);
            setTimeout(() => useStore.getState().removePermission(payload.id), PERMISSION_DONE_HOLD_MS);
          } else s.removePermission(payload.id);
        }),
      ]).catch(() => [] as (() => void)[]);
      if (disposed) {
        ready.forEach((f) => f());
        return;
      }
      uns.push(...ready);
      const list = await invoke<PendingPermission[]>("permission_pending").catch(() => [] as PendingPermission[]);
      if (!disposed) list.forEach(admit);
    })();
    return () => {
      disposed = true;
      uns.forEach((f) => f());
    };
  }, []);

  // Phone pairing prompts (pairing.rs). Same shape as the ask cards: listeners first, then
  // the catch-up. `pair-resolved` can arrive twice for one id; removal is idempotent.
  useEffect(() => {
    let disposed = false;
    const uns: (() => void)[] = [];
    void (async () => {
      const ready = await Promise.all([
        listen<PairRequest>("pair-request", ({ payload }) =>
          useStore.getState().addPairRequest(payload),
        ),
        listen<{ id: string; how: string }>("pair-resolved", ({ payload }) =>
          useStore.getState().removePairRequest(payload.id),
        ),
      ]).catch(() => [] as (() => void)[]);
      if (disposed) {
        ready.forEach((f) => f());
        return;
      }
      uns.push(...ready);
      const list = await invoke<PairRequest[]>("pair_pending").catch(() => [] as PairRequest[]);
      if (!disposed) list.forEach((r) => useStore.getState().addPairRequest(r));
    })();
    return () => {
      disposed = true;
      uns.forEach((f) => f());
    };
  }, []);

  // Keep Rust's gate in step: capture questions only when a card could be seen. With
  // profile windows every window writes the gate; the last writer wins, which is the
  // focused window -- the one whose card could actually be seen.
  const askGate = useStore((s) =>
    askGateOpen({
      enabled: s.continuityViewEnabled,
      viewOpen:
        !!s.selectedProjectId &&
        effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
      windowFocused: s.windowFocused,
    }),
  );
  useEffect(() => {
    void invoke("set_ask_gate", { open: askGate }).catch(() => {});
  }, [askGate]);

  // Hand a question back once its session's own terminal is in front of the user. Each id
  // is invoked once; it is forgotten when its `ask-resolved` arrives.
  useEffect(() => {
    return useStore.subscribe((s) => {
      const view = handOffView(s);
      for (const a of Object.values(s.asks)) {
        if (handedOff.has(a.id)) continue;
        if (askShouldHandOff(a, view)) {
          handedOff.add(a.id);
          void invoke("ask_handoff", { id: a.id }).catch(() => handedOff.delete(a.id));
        }
      }
    });
  }, []);

  // Returning to the app clears "needs you" on whatever session you're viewing.
  useEffect(() => {
    const onFocus = () => {
      const st = useStore.getState();
      const id = globalSelectedSessionId(st);
      if (id && st.live[id]?.status === "needsInput") st.setStatus(id, "idle");
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Resizable right column (persisted).
  const MIN_W = 260;
  const MAX_W = 720;
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("conduit.rightWidth"));
    return saved >= MIN_W && saved <= MAX_W ? saved : 340;
  });
  const widthRef = useRef(rightWidth);
  const [dragging, setDragging] = useState(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setRightWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      localStorage.setItem("conduit.rightWidth", String(widthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Resizable sidebar (persisted). Mirrors the right-column resizer above.
  const SB_MIN = 200;
  const SB_MAX = 420;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("conduit.sidebarWidth"));
    return saved >= SB_MIN && saved <= SB_MAX ? saved : 232;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarDragging(true);
    const onMove = (ev: MouseEvent) => {
      // clientX is the distance from the viewport's left edge = sidebar width.
      const w = Math.min(SB_MAX, Math.max(SB_MIN, ev.clientX));
      sidebarWidthRef.current = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarDragging(false);
      localStorage.setItem("conduit.sidebarWidth", String(sidebarWidthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className="app-root"
      style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
    >
      {!sidebarCollapsed && <Sidebar />}
      {!agentSetupComplete && <Onboarding />}
      {!sidebarCollapsed && (
        <div
          className={`sidebar-resizer ${sidebarDragging ? "dragging" : ""}`}
          onMouseDown={startSidebarResize}
        />
      )}
      <div
        className="detail"
        style={{ ["--right-w" as string]: `${rightWidth}px` }}
      >
        {/* Root chat swap is CSS-only: the terminal workspace (and the keep-alive
            shell in RightColumn below) stays mounted under display:none while the
            chat layer shows — unmounting either would kill live PTYs. */}
        <div style={rootChatActive ? { display: "none" } : { display: "contents" }}>
          <WorkspaceCenter
            projects={projects}
            projectId={selectedProjectId}
            home={home}
          />
        </div>
        {rootChatActive && <RootChatView />}
        {!rightCollapsed && !rootChatActive && (
          <div
            className={`resizer ${dragging ? "dragging" : ""}`}
            onMouseDown={startResize}
          />
        )}
        {/* RightColumn hosts a keep-alive shell TerminalView — never conditionally
            unmount it (kills the PTY). display:contents makes this wrapper
            layout-transparent when expanded, and display:none hides it (still
            mounted) when collapsed or while a root chat is showing. */}
        <div
          style={
            rightCollapsed || rootChatActive
              ? { display: "none" }
              : { display: "contents" }
          }
        >
          <RightColumn projects={projects} projectId={selectedProjectId} />
        </div>
      </div>
      <UpdateNotice />
      <TmuxNotice />
      <ConversationRepairNotice />
      <Toasts />
      {/* One bottom-right column: permissions above the docked question. A sibling overlay,
          never inside the terminal tree. */}
      <div className="hold-dock">
        <PermissionDock />
        <AskDock />
      </div>
      <PairPrompt />
      <PendingDecisions />
      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} initialTab={settingsTab} />
      )}
      {/* The command palette is the one palette that works with no project open — half its
          rows (open a project, settings, view toggles) are exactly what you want then. */}
      {palette === "commands" && <CommandPalette onClose={() => setPalette(null)} />}
      {newProjectDialog && (
        <NewProjectDialog mode={newProjectDialog} onClose={() => setNewProjectDialog(null)} />
      )}
      {(() => {
        if (palette !== "quickopen" && palette !== "search") return null;
        const p = projects.find((x) => x.id === selectedProjectId);
        if (!p) return null;
        return palette === "quickopen" ? (
          <QuickOpen projectId={p.id} dir={p.path} onClose={() => setPalette(null)} />
        ) : (
          <SearchPalette projectId={p.id} dir={p.path} onClose={() => setPalette(null)} />
        );
      })()}
    </div>
  );
}

// ---- auto-rename ----
const autoNamed = new Set<string>();

async function maybeAutoName(sessionId: string, prompt: unknown) {
  if (typeof prompt !== "string" || !prompt.trim()) return;
  if (autoNamed.has(sessionId)) return;

  const found = findSession(useStore.getState().projects, sessionId);
  if (!found || !/^Session \d+$/.test(found.session.name)) return;

  autoNamed.add(sessionId);
  try {
    const name = await invoke<string>("suggest_session_name", { prompt });
    const clean = (name ?? "").trim();
    const now = findSession(useStore.getState().projects, sessionId);
    if (clean && now && /^Session \d+$/.test(now.session.name)) {
      await useStore.getState().renameSession(found.project.id, sessionId, clean);
    }
  } catch {
    autoNamed.delete(sessionId);
  }
}

// ---- hook helpers ----

/** Look up which agent is running a given session (defaults to "claude" for back-compat). */
function agentOf(sessionId: string): AgentId {
  return findSession(useStore.getState().projects, sessionId)?.session.agent ?? "claude";
}

/** Map a tool name + input to a short, human "what it's doing now" label for the
 *  sidebar. Agent-aware: each adapter has its own tool vocabulary. Returns undefined
 *  when there's nothing worth showing (e.g. the tool is surfaced elsewhere). */
function toolActivity(agent: AgentId, toolName?: string, toolInput?: any): string | undefined {
  if (typeof toolName !== "string" || !toolName) return undefined;

  if (agent === "codex") {
    switch (toolName) {
      case "Bash":
        return "Running a command";
      case "apply_patch": {
        const p = toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      default:
        return toolName;
    }
  }

  if (agent === "gemini") {
    switch (toolName) {
      case "run_shell_command":
        return "Running a command";
      case "write_file":
      case "replace": {
        const p = toolInput?.absolute_path ?? toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      case "read_file":
      case "read_many_files":
        return "Reading files";
      case "google_web_search":
      case "web_fetch":
        return "Browsing the web";
      case "write_todos":
        return undefined; // surfaced in the To-dos panel instead
      default:
        return toolName;
    }
  }

  if (agent === "opencode") {
    switch (toolName) {
      case "bash":
        return "Running a command";
      case "edit":
      case "write":
      case "patch": {
        const p = toolInput?.filePath ?? toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      case "read":
        return "Reading files";
      case "grep":
      case "glob":
      case "list":
        return "Searching the code";
      case "webfetch":
        return "Browsing the web";
      case "todowrite":
      case "todoread":
        return undefined; // surfaced in the To-dos panel instead (when present)
      case "task":
        return "Running a subagent";
      default:
        return toolName;
    }
  }

  // claude (and any unknown agent): keep the existing PascalCase switch body unchanged.
  const file = (): string | undefined => {
    const p = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path;
    return typeof p === "string" && p ? baseName(p) : undefined;
  };
  switch (toolName) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const f = file();
      return f ? `Editing ${f}` : "Editing files";
    }
    case "Read": {
      const f = file();
      return f ? `Reading ${f}` : "Reading files";
    }
    case "Bash":
      return "Running a command";
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "Task":
      return "Running a subagent";
    case "WebFetch":
    case "WebSearch":
      return "Browsing the web";
    case "TodoWrite":
      return undefined; // surfaced in the To-dos panel instead
    default:
      return toolName;
  }
}

function applyTodos(toolInput: any, sessionId: string) {
  // Claude sends { todos: [...] }; Gemini may send { todo_list: [...] } or a bare array.
  const raw =
    toolInput?.todos ?? toolInput?.todo_list ?? (Array.isArray(toolInput) ? toolInput : undefined);
  if (!Array.isArray(raw)) return;
  const todos: TodoItem[] = raw
    .filter((it) => typeof it?.content === "string")
    .map((it) => ({
      content: it.content as string,
      status: (it.status as TodoStatus) ?? "pending",
      activeForm: typeof it.activeForm === "string" ? (it.activeForm as string) : undefined,
    }));
  const st = useStore.getState();
  st.setTodos(sessionId, todos);
  if (todos.some((t) => t.status === "in_progress"))
    st.setStatus(sessionId, "running");
}

function sessionName(sessionId: string): string {
  const found = findSession(useStore.getState().projects, sessionId);
  return found?.session.name ?? "Session";
}

function notifyIfAway(sessionId: string, body: string) {
  const st = useStore.getState();
  if (!document.hasFocus() || globalSelectedSessionId(st) !== sessionId)
    doNotify(sessionId, body);
}

function doNotify(sessionId: string, body: string) {
  void invoke("notify_user", {
    title: "Conduit",
    subtitle: sessionName(sessionId),
    body,
  }).catch(() => {});
}
