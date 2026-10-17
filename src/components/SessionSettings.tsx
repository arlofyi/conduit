import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import {
  MAX_AUTO_STOP_MINUTES,
  MIN_AUTO_STOP_MINUTES,
  clampMinutes,
  type LaunchRestore,
} from "../sessionLifecycle";
import { Dropdown } from "./Dropdown";
import { SettingRow } from "./GeneralSettings";

const isWindows = /win/i.test(navigator.platform || navigator.userAgent);

/** Settings → Sessions: when sessions start and stop by themselves. */
export function SessionSettings() {
  const prefs = useStore((s) => s.sessionLifecycle);
  const set = useStore((s) => s.setSessionLifecycle);
  // Typed text, committed on blur/Enter so a half-typed "1" of "15" is not applied.
  const [minutesText, setMinutesText] = useState(String(prefs.autoStopMinutes));
  const [nulResult, setNulResult] = useState<string | null>(null);
  const [nulBusy, setNulBusy] = useState(false);

  const commitMinutes = () => {
    const m = clampMinutes(minutesText);
    setMinutesText(String(m));
    if (m !== prefs.autoStopMinutes) set({ autoStopMinutes: m });
  };

  const cleanNul = async () => {
    setNulBusy(true);
    try {
      const n = await invoke<number>("remove_stray_nul_files");
      setNulResult(n === 0 ? "No stray NUL files found." : `Removed ${n} stray NUL file${n === 1 ? "" : "s"}.`);
    } catch (e) {
      setNulResult(`Could not clean up: ${e}`);
    } finally {
      setNulBusy(false);
    }
  };

  return (
    <div className="general-settings">
      <SettingRow
        id="launch-restore"
        title="When Conduit starts"
        control={
          <Dropdown
            className="dd-settings"
            value={prefs.launchRestore}
            options={[
              { value: "working", label: "Resume only agents that were still working" },
              { value: "project", label: "Start every session of the project I open" },
              { value: "none", label: "Start nothing until I open a session" },
            ]}
            onChange={(v) => set({ launchRestore: v as LaunchRestore })}
          />
        }
        detail="Closing or restarting Conduit stops every session. With the default, a session whose agent was still in the middle of a task comes back by itself, in whichever project it lives; every other session waits, showing where it left off, until you open it, click into it or press a key in it. Conduit records each agent's activity as it happens, so this also holds after a crash or an update. Each running session costs roughly 0.5 to 1 GB with its MCP servers."
      />

      <SettingRow
        id="resume-waiting"
        title="Also resume sessions that were waiting for me"
        checked={prefs.resumeWaitingOnLaunch}
        disabled={prefs.launchRestore !== "working"}
        onChange={(on) => set({ resumeWaitingOnLaunch: on })}
        detail="A session whose agent had stopped to ask you something (a permission prompt, a question) normally stays closed after a restart like any finished one. Turn this on to bring those back as well."
      />

      <SettingRow
        id="auto-stop"
        title="Stop sessions after the agent finishes"
        checked={prefs.autoStopIdle}
        onChange={(on) => set({ autoStopIdle: on })}
        control={
          <label className="setting-inline">
            after{" "}
            <input
              type="number"
              className="setting-number"
              min={MIN_AUTO_STOP_MINUTES}
              max={MAX_AUTO_STOP_MINUTES}
              value={minutesText}
              disabled={!prefs.autoStopIdle}
              onChange={(e) => setMinutesText(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitMinutes();
              }}
              aria-label="Minutes before an idle session is stopped"
            />{" "}
            minutes of quiet
          </label>
        }
        detail="Once an agent has finished its task and nothing has happened for this long, its session is stopped to free memory: the agent and its MCP servers exit, the conversation and scrollback are kept, and opening the session (or clicking into it, or pressing a key in it) resumes it where it left off. An agent that is still working is never stopped, and neither is a Conductor."
      />

      <SettingRow
        id="auto-stop-waiting"
        title="Also stop sessions waiting for me"
        checked={prefs.autoStopWaiting}
        disabled={!prefs.autoStopIdle}
        onChange={(on) => set({ autoStopWaiting: on })}
        detail="Apply the same delay to a session whose agent is waiting on your answer. Off by default: such an agent has not finished, it is blocked on you."
      />

      <SettingRow
        id="auto-stop-visible"
        title="Also stop the session on screen"
        checked={prefs.autoStopVisible}
        disabled={!prefs.autoStopIdle}
        onChange={(on) => set({ autoStopVisible: on })}
        detail="By default the session(s) you are looking at are left running, so a pane does not close while you read it. Turn this on to treat them like any other."
      />

      <SettingRow
        id="keep-in-project"
        title="Keep Claude in the project folder"
        checked={prefs.keepAgentsInProject}
        onChange={(on) => set({ keepAgentsInProject: on })}
        detail="Returns Claude's shell to the session's folder after every command (Claude Code's CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR). Without it, one `cd /` or `cd ~` sticks for the rest of the session, which is how agents end up working on files outside the project. Applies to sessions started after the change."
      />

      {isWindows && (
        <SettingRow
          id="clean-nul"
          title="Remove stray NUL files"
          control={
            <div className="setting-inline">
              <button disabled={nulBusy} onClick={() => void cleanNul()}>
                {nulBusy ? "Cleaning…" : "Clean up project folders"}
              </button>
              {nulResult && <span className="setting-note"> {nulResult}</span>}
            </div>
          }
          detail="Earlier versions of Conduit left empty files named NUL in project folders on Windows (Claude ran Conduit's status hooks through Git Bash, which turns a redirect to NUL into a file). That is fixed; this removes the leftovers from every project in the sidebar. Only files named NUL that hold nothing but the hook's reply are deleted; node_modules, .git and target are skipped."
        />
      )}
    </div>
  );
}
