import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { E2E_CONTINUITY_DB, e2eDataDir } from "../wdio.conf";
import { insertMessage, insertSession } from "./continuityFixture";

/**
 * The Continuity view against the REAL window: defaults and gating, the graph, one avatar
 * per session, live pulses, AskUserQuestion cards (answered / handed off / gate closed)
 * and the drawer. The continuity database is the harness fixture (`E2E_CONTINUITY_DB`);
 * the app only reads it.
 *
 * Sessions are created hibernated: nothing here needs a real agent, and `/ask` only asks
 * that the session id exists in the store.
 */

type Session = { id: string; name: string };
type Project = { id: string; name: string; sessions: Session[] };

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  browser.execute(
    (c: string, a: Record<string, unknown> | undefined) =>
      (window as any).__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;

const PREFS = [
  "conduit.canvasEnabled",
  "conduit.boardEnabled",
  "conduit.continuityViewEnabled",
] as const;

const QUESTION_BODY = {
  tool_name: "AskUserQuestion",
  tool_use_id: "t1",
  tool_input: {
    questions: [
      {
        question: "Run the taxonomy migration now?",
        header: "Migration",
        multiSelect: false,
        options: [
          { label: "Run it now", description: "Recommended: the baseline is green" },
          { label: "Hold for review", description: "Pause until you have looked" },
        ],
      },
    ],
  },
};

function hookPort(): string {
  const endpoint = readFileSync(join(e2eDataDir(), "hook-endpoint.sh"), "utf8");
  const port = /CONDUIT_HOOK_PORT=(\d+)/.exec(endpoint)?.[1];
  if (!port) throw new Error(`no hook port in ${endpoint}`);
  return port;
}

/** POST an ask; the promise settles with the hook output once the card (or gate) answers. */
function postAsk(sessionId: string): Promise<any> {
  return fetch(`http://127.0.0.1:${hookPort()}/ask?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(QUESTION_BODY),
  }).then((r) => r.json());
}

const count = (sel: string) =>
  browser.execute((s: string) => document.querySelectorAll(s).length, sel) as Promise<number>;

const waitFor = (fn: () => Promise<boolean>, msg: string, timeout = 10_000) =>
  browser.waitUntil(fn, { timeout, timeoutMsg: msg, interval: 200 });

/** Click via the DOM: the headers/cards are plain buttons and this skips hit-test flakiness. */
const domClick = (sel: string, text?: string) =>
  browser.execute(
    (s: string, t: string | undefined) => {
      const el = Array.from(document.querySelectorAll(s)).find(
        (e) => t == null || (e.textContent ?? "").includes(t),
      ) as HTMLElement | undefined;
      el?.click();
      return !!el;
    },
    sel,
    text,
  ) as Promise<boolean>;

/** The embedded WebDriver click only synthesizes mouse events, and the graph listens to
 *  pointer events, so press and release with real PointerEvents at the node's centre
 *  (no movement: a drag would pin the node instead of opening it). */
const pressFirstNode = () =>
  browser.execute(() => {
    const n = document.querySelector(".cgraph-node") as HTMLElement;
    const r = n.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
    };
    n.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
    (n.closest(".cgraph") as HTMLElement).dispatchEvent(new PointerEvent("pointerup", init));
  });

async function headerButtons(): Promise<string[]> {
  return (await browser.execute(() =>
    Array.from(document.querySelectorAll(".board-tab")).map((e) => (e.textContent ?? "").trim()),
  )) as string[];
}

describe("the Continuity view", () => {
  const name = "continuity-view-project";
  let project: Project;
  let a: Session;
  let b: Session;
  const contA = randomUUID();
  const contB = randomUUID();

  /** Select the project and open Alpha, so the center column has a tab strip (the header
   *  buttons live in it). Opening the hibernated session resumes it; nothing below needs
   *  the agent itself. */
  async function selectProject() {
    await waitFor(
      () =>
        browser.execute((want: string) => {
          // Expand the project (a no-op click if the row is already open), then open Alpha:
          // selecting a session selects ITS project, which a head click alone did not do
          // when an earlier spec had left another project selected.
          const alpha = Array.from(document.querySelectorAll(".session-row")).find((e) =>
            (e.textContent ?? "").includes("Alpha"),
          ) as HTMLElement | undefined;
          if (alpha) {
            alpha.click();
            return true;
          }
          const head = Array.from(document.querySelectorAll(".project-head .name")).find(
            (e) => (e.textContent ?? "").trim() === want,
          ) as HTMLElement | undefined;
          head?.click();
          return false;
        }, name) as Promise<boolean>,
      "Alpha's session row never appeared",
    );
    await waitFor(async () => (await count(".tab-strip")) > 0, "no tab strip");
  }

  async function reloadWithPrefs(prefs: Partial<Record<(typeof PREFS)[number], boolean | null>>) {
    await browser.execute(
      (p: Record<string, boolean | null>) => {
        for (const [k, v] of Object.entries(p)) {
          if (v === null) localStorage.removeItem(k);
          else localStorage.setItem(k, v ? "1" : "0");
        }
        location.reload();
      },
      prefs as Record<string, boolean | null>,
    );
    await browser.pause(1500);
    await selectProject();
  }

  // `onPrepare` creates the fixture with the sqlite3 CLI and only warns when it cannot
  // (a runner image without sqlite3). Every assertion below writes that DB, so without it
  // there is nothing honest to run: skip the whole suite and say why.
  before(function () {
    if (!existsSync(E2E_CONTINUITY_DB)) {
      console.warn(
        `[e2e] skipping the Continuity view spec: no fixture DB at ${E2E_CONTINUITY_DB} (sqlite3 CLI missing?)`,
      );
      this.skip();
    }
  });

  before(async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "conduit-e2e-cview-")), name);
    mkdirSync(dir, { recursive: true });
    project = await invoke<Project>("add_project", { path: dir });
    const mk = async (n: string) => {
      const s = await invoke<Session>("add_session", {
        projectId: project.id,
        name: n,
        useWorktree: false,
        agent: "claude",
        role: null,
        mcpServers: null,
        model: null,
      });
      await invoke("stop_session", { sessionId: s.id });
      return s;
    };
    a = await mk("Alpha");
    b = await mk("Beta");
    await reloadWithPrefs({
      "conduit.canvasEnabled": null,
      "conduit.boardEnabled": null,
      "conduit.continuityViewEnabled": null,
    });
  });

  after(async () => {
    await invoke("set_ask_gate", { open: false });
  });

  it("defaults: Continuity is offered, Canvas and Board are not", async () => {
    await waitFor(
      async () => (await headerButtons()).some((t) => t.startsWith("Continuity")),
      "no Continuity header button",
    );
    const labels = await headerButtons();
    expect(labels.some((t) => t.includes("Canvas"))).toBe(false);
    expect(labels.some((t) => t.includes("Board"))).toBe(false);
  });

  it("toggle: enabling the Canvas pref shows its button, disabling hides it", async () => {
    await reloadWithPrefs({ "conduit.canvasEnabled": true });
    await waitFor(
      async () => (await headerButtons()).some((t) => t.includes("Canvas")),
      "Canvas button never appeared",
    );
    await reloadWithPrefs({ "conduit.canvasEnabled": false });
    await waitFor(
      async () => (await headerButtons()).some((t) => t.startsWith("Continuity")),
      "header never came back",
    );
    expect((await headerButtons()).some((t) => t.includes("Canvas"))).toBe(false);
  });

  it("opens the graph with one node per project session", async () => {
    await invoke("set_ask_gate", { open: true });
    await waitFor(() => domClick(".board-tab", "Continuity"), "no Continuity button to click");
    await waitFor(async () => (await count(".cgraph")) === 1, ".cgraph never rendered");
    await waitFor(async () => (await count(".cgraph-node")) === 2, "expected 2 nodes");
  });

  it("one avatar per session even when continuity has rows for them (11F)", async () => {
    // Sessions here have no worktree, so the cwd_hash adoption path is not exercised;
    // identity travels by agent_label = Conduit session id.
    insertSession(E2E_CONTINUITY_DB, { id: contA, label: a.id, status: "active", focus: "alpha work" });
    insertSession(E2E_CONTINUITY_DB, { id: contB, label: b.id, status: "active" });
    // The snapshot (what the UI renders from) adopts the rows: both nodes carry a
    // continuity id and none were added. Then give the debounced UI refetch time to land.
    await waitFor(
      async () => {
        const snap = await invoke<{ nodes: { continuityId?: string }[] }>("continuity_graph", {
          projectId: project.id,
        });
        return snap.nodes.length === 2 && snap.nodes.every((n) => !!n.continuityId);
      },
      "graph snapshot never adopted the continuity rows",
      15_000,
    );
    await browser.pause(2000);
    expect(await count(".cgraph-node")).toBe(2);
  });

  it("a message pulses along its edge", async () => {
    insertMessage(E2E_CONTINUITY_DB, { id: randomUUID(), from: contA, to: contB });
    // The pulse lives ~1.5 s: poll fast so one sample lands inside the window.
    await browser.waitUntil(async () => (await count(".cgraph-pulse")) > 0, {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: "no .cgraph-pulse appeared",
    });
    await waitFor(async () => (await count(".cgraph-edge")) > 0, "no edge after the message");
  });

  it("an AskUserQuestion card answers the blocked hook", async () => {
    await invoke("set_ask_gate", { open: true });
    const reply = postAsk(a.id);
    await waitFor(
      async () =>
        (await browser.execute(() =>
          Array.from(document.querySelectorAll(".ask-card")).some((c) =>
            (c.textContent ?? "").includes("Run the taxonomy migration now?"),
          ),
        )) as boolean,
      "no ask card with the question",
    );
    expect(await domClick(".ask-card-opt", "Run it now")).toBe(true);
    const out = await reply;
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.answers["Run the taxonomy migration now?"]).toBe("Run it now");
    await waitFor(async () => (await count(".ask-card")) === 0, "card did not go away");
  });

  it("'Answer in terminal' hands the question back", async () => {
    await invoke("set_ask_gate", { open: true });
    const reply = postAsk(a.id);
    await waitFor(async () => (await count(".ask-card")) > 0, "no ask card");
    expect(await domClick(".ask-card-link")).toBe(true);
    expect(await reply).toEqual({});
    await waitFor(async () => (await count(".ask-card")) === 0, "card did not go away");
    // The arrow promises the jump: the overlay drops so the session's terminal shows.
    await waitFor(async () => (await count(".cgraph")) === 0, "Continuity overlay still covers the terminal");
    await waitFor(() => domClick(".board-tab", "Continuity"), "no Continuity button to reopen");
    await waitFor(async () => (await count(".cgraph-node")) === 2, "graph did not come back");
  });

  it("a closed gate answers {} at once and raises no card", async () => {
    await invoke("set_ask_gate", { open: false });
    const started = Date.now();
    const out = await postAsk(a.id);
    expect(out).toEqual({});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await count(".ask-card")).toBe(0);
    await invoke("set_ask_gate", { open: true });
  });

  it("a click on a node opens the drawer and Escape closes it", async () => {
    await pressFirstNode();
    await waitFor(async () => (await count(".session-drawer")) === 1, "drawer never opened");
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("Escape");
    await waitFor(async () => (await count(".session-drawer")) === 0, "drawer did not close");
  });

  it("'Open session' in the drawer shows that session's terminal, not the overlay", async () => {
    await pressFirstNode();
    await waitFor(async () => (await count(".session-drawer")) === 1, "drawer never opened");
    expect(await domClick(".session-drawer .header-btn", "Open session")).toBe(true);
    await waitFor(async () => (await count(".cgraph")) === 0, "Continuity overlay still covers the terminal");
    expect(await count(".session-drawer")).toBe(0);
  });
});
