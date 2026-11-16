//! Screen rules: reading an agent's own screen to learn that it is waiting on the user.
//!
//! Conduit learns status from hooks, and for some agents the hooks cannot say "I am on a
//! dialog": Antigravity fires none at all (its status line only says busy or not), and a
//! folder-trust prompt runs before any hook exists. The text on screen does say it. A rule
//! file per agent lists what a dialog looks like, and `detect` matches the visible screen
//! against it.
//!
//! # Where the rules come from
//!
//! The files in `manifests/` are from Herdr (<https://github.com/herdrdev/herdr>,
//! `src/detect/manifests/`, commit `ee5bfb5`, 2026-10-29), Apache License 2.0, copied
//! UNMODIFIED. Their license is `manifests/LICENSE-APACHE-2.0`; `manifests/NOTICE.md` says
//! what was taken. The patterns were measured by Herdr's authors against live agents (each
//! file's header says which versions), which is the whole reason to adopt them rather than
//! write our own: a guessed pattern is a wrong status.
//!
//! This engine is ours, written to give those files the meaning Herdr's engine gives them
//! (`src/detect/manifest.rs`): every listed matcher must hold, `contains` ignores case,
//! `regex` sees the whole region and `line_regex` one line at a time, and among matching
//! rules the highest priority wins, the earlier one on a tie.
//!
//! Only two regions are implemented, `whole_recent` and `bottom_non_empty_lines(N)`,
//! because those are all the adopted files use. A file naming any other region fails to
//! load rather than half-work: Herdr's other regions need an OSC title or prompt-marker
//! parsing Conduit does not have, and a rule evaluated against the wrong text is worse
//! than no rule.

use crate::agent::AgentId;
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

/// What a screen shows the agent doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenState {
    Idle,
    Working,
    /// Waiting on the user: a permission, a question, a trust prompt.
    Blocked,
    Unknown,
}

/// The rule that matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Detection {
    pub state: ScreenState,
    pub rule: String,
}

impl Detection {
    /// What a blocked screen is waiting for, in `conduit report`'s words, read from the
    /// rule's name. Herdr's files have no such field; their rule ids are consistent enough
    /// to carry it, and an id that says nothing falls back to the plain "needs you".
    pub fn kind(&self) -> Option<&'static str> {
        if self.state != ScreenState::Blocked {
            return None;
        }
        let id = self.rule.as_str();
        if id.contains("question") {
            Some("question")
        } else if ["permission", "trust", "allow", "apply"]
            .iter()
            .any(|w| id.contains(w))
        {
            Some("permission")
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    id: String,
    #[serde(rename = "version")]
    _version: Option<String>,
    min_engine_version: Option<u32>,
    #[serde(rename = "updated_at")]
    _updated_at: Option<String>,
    #[serde(default, rename = "aliases")]
    _aliases: Vec<String>,
    #[serde(default)]
    rules: Vec<RawRule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    id: String,
    state: Option<ScreenState>,
    #[serde(default)]
    priority: i32,
    #[serde(default = "default_region")]
    region: String,
    // Diagnostics in Herdr's own tools; accepted so its files parse unmodified.
    #[serde(default, rename = "visible_idle")]
    _visible_idle: bool,
    #[serde(default, rename = "visible_blocker")]
    _visible_blocker: bool,
    #[serde(default, rename = "visible_working")]
    _visible_working: bool,
    #[serde(default)]
    skip_state_update: bool,
    // The rule's own gate, spelled out rather than flattened: serde cannot refuse unknown
    // fields through a flattened struct, and refusing them is the point.
    #[serde(default)]
    all: Vec<RawGate>,
    #[serde(default)]
    any: Vec<RawGate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<RawGate>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

impl RawRule {
    fn gate(&self) -> RawGate {
        RawGate {
            all: self.all.clone(),
            any: self.any.clone(),
            not_gate: self.not_gate.clone(),
            contains: self.contains.clone(),
            regex: self.regex.clone(),
            line_regex: self.line_regex.clone(),
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct RawGate {
    #[serde(default)]
    all: Vec<RawGate>,
    #[serde(default)]
    any: Vec<RawGate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<RawGate>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

fn default_region() -> String {
    "whole_recent".to_string()
}

/// The rule-file format version this engine understands.
const ENGINE_VERSION: u32 = 1;
/// A gate nested deeper than this is a malformed file, not a rule.
const MAX_DEPTH: usize = 8;

#[derive(Debug)]
enum Region {
    Whole,
    BottomNonEmpty(usize),
}

impl Region {
    fn parse(spec: &str) -> Result<Region, String> {
        let spec = spec.trim();
        if spec == "whole_recent" {
            return Ok(Region::Whole);
        }
        spec.strip_prefix("bottom_non_empty_lines(")
            .and_then(|rest| rest.strip_suffix(')'))
            .and_then(|n| n.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .map(Region::BottomNonEmpty)
            .ok_or_else(|| format!("region `{spec}` is not one this engine implements"))
    }

    fn of<'a>(&self, screen: &'a str) -> &'a str {
        match self {
            Region::Whole => screen,
            Region::BottomNonEmpty(count) => bottom_non_empty_lines(screen, *count),
        }
    }
}

/// From the `count`-th non-empty line from the bottom, to the end. Blank lines inside the
/// span stay: a dialog's rows are matched as they sit on screen.
fn bottom_non_empty_lines(screen: &str, count: usize) -> &str {
    let mut offset = 0;
    let mut starts = Vec::new();
    for line in screen.split_inclusive('\n') {
        if !line.trim().is_empty() {
            starts.push(offset);
        }
        offset += line.len();
    }
    match starts.len().saturating_sub(count) {
        _ if starts.is_empty() => "",
        first => &screen[starts[first]..],
    }
}

#[derive(Debug)]
struct Gate {
    all: Vec<Gate>,
    any: Vec<Gate>,
    not_gate: Vec<Gate>,
    /// Lowercased: `contains` ignores case.
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
}

impl Gate {
    fn compile(raw: &RawGate, depth: usize) -> Result<Gate, String> {
        if depth > MAX_DEPTH {
            return Err("gates are nested too deeply".into());
        }
        let nested = |list: &[RawGate]| -> Result<Vec<Gate>, String> {
            list.iter().map(|g| Gate::compile(g, depth + 1)).collect()
        };
        let patterns = |list: &[String]| -> Result<Vec<Regex>, String> {
            list.iter()
                .map(|p| Regex::new(p).map_err(|e| format!("bad pattern `{p}`: {e}")))
                .collect()
        };
        Ok(Gate {
            all: nested(&raw.all)?,
            any: nested(&raw.any)?,
            not_gate: nested(&raw.not_gate)?,
            contains: raw.contains.iter().map(|n| n.to_lowercase()).collect(),
            regex: patterns(&raw.regex)?,
            line_regex: patterns(&raw.line_regex)?,
        })
    }

    /// Whether this gate says anything at all. A rule with no matcher would match every
    /// screen.
    fn has_matcher(&self) -> bool {
        !self.contains.is_empty()
            || !self.regex.is_empty()
            || !self.line_regex.is_empty()
            || self.all.iter().any(Gate::has_matcher)
            || self.any.iter().any(Gate::has_matcher)
    }

    fn matches(&self, text: &str, lower: &str) -> bool {
        self.contains.iter().all(|needle| lower.contains(needle))
            && self.regex.iter().all(|re| re.is_match(text))
            && self
                .line_regex
                .iter()
                .all(|re| text.lines().any(|line| re.is_match(line)))
            && self.all.iter().all(|g| g.matches(text, lower))
            && (self.any.is_empty() || self.any.iter().any(|g| g.matches(text, lower)))
            && !self.not_gate.iter().any(|g| g.matches(text, lower))
    }
}

#[derive(Debug)]
struct Rule {
    id: String,
    state: ScreenState,
    priority: i32,
    region: Region,
    skip_state_update: bool,
    gate: Gate,
}

/// One agent's compiled rule file.
#[derive(Debug)]
pub struct Manifest {
    rules: Vec<Rule>,
}

impl Manifest {
    /// Parses and compiles a rule file. Any part this engine cannot honour exactly is an
    /// error for the WHOLE file.
    pub fn parse(text: &str) -> Result<Manifest, String> {
        let raw: RawManifest = toml::from_str(text).map_err(|e| e.to_string())?;
        if raw.min_engine_version.is_some_and(|v| v > ENGINE_VERSION) {
            return Err(format!("`{}` needs a newer rule engine", raw.id));
        }
        let rules = raw
            .rules
            .iter()
            .map(|r| {
                let gate =
                    Gate::compile(&r.gate(), 0).map_err(|e| format!("rule {}: {e}", r.id))?;
                if !gate.has_matcher() {
                    return Err(format!("rule {} has no matcher", r.id));
                }
                Ok(Rule {
                    id: r.id.clone(),
                    state: r.state.unwrap_or(ScreenState::Unknown),
                    priority: r.priority,
                    region: Region::parse(&r.region).map_err(|e| format!("rule {}: {e}", r.id))?,
                    skip_state_update: r.skip_state_update,
                    gate,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Manifest { rules })
    }

    /// The highest-priority rule the screen matches; the earlier rule on a tie. `None`
    /// when nothing matches, which means "no opinion", never "idle".
    pub fn detect(&self, screen: &str) -> Option<Detection> {
        let mut best: Option<&Rule> = None;
        for rule in &self.rules {
            let text = rule.region.of(screen);
            if !rule.gate.matches(text, &text.to_lowercase()) {
                continue;
            }
            if best.is_none_or(|b| rule.priority > b.priority) {
                best = Some(rule);
            }
        }
        // A rule marked `skip_state_update` recognises a screen that says nothing about
        // status (a transcript viewer): it wins, and the answer is still "no opinion".
        best.filter(|r| !r.skip_state_update).map(|r| Detection {
            state: r.state,
            rule: r.id.clone(),
        })
    }
}

const ANTIGRAVITY: &str = include_str!("manifests/antigravity.toml");
const GEMINI: &str = include_str!("manifests/gemini.toml");
const OPENCODE: &str = include_str!("manifests/opencode.toml");

fn source_for(agent: AgentId) -> Option<&'static str> {
    match agent {
        AgentId::Antigravity => Some(ANTIGRAVITY),
        AgentId::Gemini => Some(GEMINI),
        AgentId::OpenCode => Some(OPENCODE),
        // Claude, Codex, Command Code and Hermes report through hooks Conduit installs
        // and has measured itself; a second opinion from the screen would only be a way
        // for the two to disagree.
        _ => None,
    }
}

/// The compiled rules for an agent, or `None` when it has none. A bundled file that fails
/// to compile is logged once and treated as absent.
pub fn manifest_for(agent: AgentId) -> Option<&'static Manifest> {
    static CACHE: OnceLock<Vec<(AgentId, Option<Manifest>)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        [AgentId::Antigravity, AgentId::Gemini, AgentId::OpenCode]
            .into_iter()
            .map(|a| {
                let compiled = source_for(a).and_then(|text| match Manifest::parse(text) {
                    Ok(m) => Some(m),
                    Err(e) => {
                        crate::diag::error("screen-rules", format!("{a:?}: {e}"));
                        None
                    }
                });
                (a, compiled)
            })
            .collect()
    });
    cache
        .iter()
        .find(|(a, _)| *a == agent)
        .and_then(|(_, m)| m.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(text: &str) -> Manifest {
        Manifest::parse(text).expect("the rule file compiles")
    }

    fn state(m: &Manifest, screen: &str) -> Option<ScreenState> {
        m.detect(screen).map(|d| d.state)
    }

    #[test]
    fn every_adopted_file_compiles_unmodified() {
        for agent in [AgentId::Antigravity, AgentId::Gemini, AgentId::OpenCode] {
            let text = source_for(agent).unwrap();
            let m = Manifest::parse(text).unwrap_or_else(|e| panic!("{agent:?}: {e}"));
            assert!(!m.rules.is_empty(), "{agent:?} has no rules");
            assert!(manifest_for(agent).is_some());
        }
        // Agents whose hooks Conduit owns get no screen rules.
        for agent in [
            AgentId::Claude,
            AgentId::Codex,
            AgentId::CommandCode,
            AgentId::Hermes,
        ] {
            assert!(manifest_for(agent).is_none(), "{agent:?}");
        }
    }

    #[test]
    fn the_adopted_files_are_byte_for_byte_what_was_taken() {
        // "Unmodified" is a licence statement and the reason the patterns can be trusted,
        // so it is pinned: an edit here must be a deliberate, recorded change.
        fn fnv(text: &str) -> u64 {
            text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
            })
        }
        assert_eq!(
            fnv(ANTIGRAVITY),
            EXPECTED_ANTIGRAVITY,
            "antigravity.toml changed"
        );
        assert_eq!(fnv(GEMINI), EXPECTED_GEMINI, "gemini.toml changed");
        assert_eq!(fnv(OPENCODE), EXPECTED_OPENCODE, "opencode.toml changed");
        assert!(include_str!("manifests/LICENSE-APACHE-2.0").contains("Apache License"));
        let notice = include_str!("manifests/NOTICE.md");
        assert!(notice.contains("herdrdev/herdr") && notice.contains("ee5bfb5"));
    }
    const EXPECTED_ANTIGRAVITY: u64 = 5779760258953091620;
    const EXPECTED_GEMINI: u64 = 18102169003057823740;
    const EXPECTED_OPENCODE: u64 = 8261663656010003576;

    // ---- The adopted files against the screens their own headers describe ----

    #[test]
    fn antigravity_dialogs_read_as_blocked_with_their_kind() {
        let m = manifest(ANTIGRAVITY);
        let permission = "\
some earlier output
  Run command: cargo test
  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
──────────────── esc to cancel";
        let d = m.detect(permission).unwrap();
        assert_eq!(d.state, ScreenState::Blocked);
        assert_eq!(d.rule, "permission_prompt");
        assert_eq!(d.kind(), Some("permission"));

        let question = "\
Which approach?
  ↑/↓ Navigate · enter Select · esc Skip
──────────────── esc to cancel";
        let d = m.detect(question).unwrap();
        assert_eq!(d.rule, "question_prompt");
        assert_eq!(d.kind(), Some("question"));

        let trust = "\
Do you trust the contents of this project?
  > Yes, I trust this folder
    No, exit

  ↑/↓ Navigate · enter Confirm";
        let d = m.detect(trust).unwrap();
        assert_eq!(d.rule, "trust_prompt");
        assert_eq!(d.kind(), Some("permission"));
    }

    #[test]
    fn antigravity_working_and_idle_screens() {
        let m = manifest(ANTIGRAVITY);
        let working = "\
⠹ Reading the repository
╭──────────────────────╮
│ >                    │
╰──────────────────────╯
────────────────── esc to cancel";
        assert_eq!(state(&m, working), Some(ScreenState::Working));
        let idle = "\
Done. 3 files changed.
╭──────────────────────╮
│ >                    │
╰──────────────────────╯
  ? for shortcuts";
        // Nothing matches an idle screen: no opinion, which is NOT a claim that it is idle.
        assert_eq!(m.detect(idle), None);
        // The slash menu shares "Navigate" but not "tab Amend" or "esc Skip".
        let slash = "  ↑/↓ Navigate · enter Select · tab Complete\n  ? for shortcuts";
        assert_eq!(m.detect(slash), None);
    }

    #[test]
    fn a_dialog_outranks_the_working_footer_it_sits_above() {
        // The permission dialog's footer row also reads "esc to cancel", which is the
        // working rule's pattern. Priority is what makes it blocked.
        let m = manifest(ANTIGRAVITY);
        let screen = "\
⠹ Running
  ↑/↓ Navigate · tab Amend · f full diff
──────────────── esc to cancel";
        assert_eq!(state(&m, screen), Some(ScreenState::Blocked));
    }

    #[test]
    fn gemini_and_opencode_dialogs_and_working_screens() {
        let g = manifest(GEMINI);
        let d = g
            .detect("│ Apply this change?\n│ ● Yes, allow once\n│   No")
            .unwrap();
        assert_eq!(d.state, ScreenState::Blocked);
        assert_eq!(d.kind(), Some("permission"));
        assert_eq!(
            state(&g, "⠏ Thinking (esc to cancel, 12s)"),
            Some(ScreenState::Working)
        );
        assert_eq!(g.detect("> Type your message"), None);

        let o = manifest(OPENCODE);
        let d = o
            .detect("△ Permission required\n  bash: rm -rf build")
            .unwrap();
        assert_eq!(d.state, ScreenState::Blocked);
        assert_eq!(d.kind(), Some("permission"));
        assert_eq!(
            state(&o, "working…  esc to interrupt"),
            Some(ScreenState::Working)
        );
        assert_eq!(state(&o, "■■■■■⬝⬝⬝ build"), Some(ScreenState::Working));
        assert_eq!(o.detect("Ask anything"), None);
    }

    // ---- The engine's own semantics ----

    const HEAD: &str = "id = \"t\"\n";

    #[test]
    fn contains_ignores_case_and_every_needle_must_be_there() {
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"a\"\nstate = \"blocked\"\ncontains = [\"Do You\", \"proceed\"]\n"
        ));
        assert_eq!(
            state(&m, "DO YOU want to PROCEED?"),
            Some(ScreenState::Blocked)
        );
        assert_eq!(m.detect("do you want to"), None);
    }

    #[test]
    fn regex_sees_the_region_and_line_regex_one_line() {
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"whole\"\nstate = \"working\"\nregex = ['a\\nb']\n\
             [[rules]]\nid = \"line\"\nstate = \"blocked\"\npriority = 5\nline_regex = ['^x$']\n"
        ));
        assert_eq!(m.detect("a\nb").unwrap().rule, "whole");
        assert_eq!(m.detect("a\nb\nx").unwrap().rule, "line");
        // `^x$` must be a whole LINE, not a substring of the region.
        assert_eq!(m.detect("axb").map(|d| d.rule), None);
    }

    #[test]
    fn all_any_and_not_combine() {
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"r\"\nstate = \"blocked\"\ncontains = [\"menu\"]\n\
             any = [{{ contains = [\"yes\"] }}, {{ contains = [\"allow\"] }}]\n\
             not = [{{ contains = [\"transcript\"] }}]\n"
        ));
        assert!(m.detect("menu: yes / no").is_some());
        assert!(m.detect("menu: allow / deny").is_some());
        assert!(m.detect("menu: ok").is_none(), "neither `any` branch held");
        assert!(m.detect("transcript — menu: yes").is_none(), "`not` held");
    }

    #[test]
    fn the_highest_priority_wins_and_the_earlier_rule_on_a_tie() {
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"low\"\nstate = \"working\"\npriority = 1\ncontains = [\"x\"]\n\
             [[rules]]\nid = \"high\"\nstate = \"blocked\"\npriority = 9\ncontains = [\"x\"]\n\
             [[rules]]\nid = \"tie\"\nstate = \"idle\"\npriority = 9\ncontains = [\"x\"]\n"
        ));
        assert_eq!(m.detect("x").unwrap().rule, "high");
    }

    #[test]
    fn a_skip_rule_that_wins_means_no_opinion() {
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"viewer\"\npriority = 9\nskip_state_update = true\ncontains = [\"transcript\"]\n\
             [[rules]]\nid = \"work\"\nstate = \"working\"\npriority = 1\ncontains = [\"esc to cancel\"]\n"
        ));
        assert_eq!(m.detect("transcript … esc to cancel"), None);
        assert_eq!(state(&m, "esc to cancel"), Some(ScreenState::Working));
    }

    #[test]
    fn bottom_lines_count_only_non_empty_ones_and_keep_the_blanks_between() {
        let screen = "one\n\ntwo\n\n\nthree\n\n";
        assert_eq!(bottom_non_empty_lines(screen, 1), "three\n\n");
        assert_eq!(bottom_non_empty_lines(screen, 2), "two\n\n\nthree\n\n");
        assert_eq!(bottom_non_empty_lines(screen, 99), screen);
        assert_eq!(bottom_non_empty_lines("\n \n", 3), "");
        assert_eq!(bottom_non_empty_lines("", 3), "");
        // A dialog further up the screen is out of a bottom region's reach.
        let m = manifest(&format!(
            "{HEAD}[[rules]]\nid = \"r\"\nstate = \"blocked\"\nregion = \"bottom_non_empty_lines(2)\"\ncontains = [\"old dialog\"]\n"
        ));
        assert!(m.detect("old dialog\nline\nline\nprompt").is_none());
        assert!(m.detect("x\nold dialog\nprompt").is_some());
    }

    #[test]
    fn a_file_this_engine_cannot_honour_exactly_is_refused_whole() {
        let rule =
            |extra: &str| format!("{HEAD}[[rules]]\nid = \"r\"\nstate = \"blocked\"\n{extra}\n");
        // A region Herdr has and Conduit does not.
        for region in [
            "osc_title",
            "after_last_prompt_marker",
            "prompt_box_body",
            "bottom_non_empty_lines(0)",
        ] {
            let err = Manifest::parse(&rule(&format!("region = \"{region}\"\ncontains = [\"x\"]")))
                .unwrap_err();
            assert!(err.contains("region"), "{region}: {err}");
        }
        assert!(Manifest::parse(&rule("regex = ['(']"))
            .unwrap_err()
            .contains("bad pattern"));
        assert!(Manifest::parse(&rule(""))
            .unwrap_err()
            .contains("no matcher"));
        // A rule made only of `not` matches every other screen.
        assert!(Manifest::parse(&rule("not = [{ contains = [\"x\"] }]"))
            .unwrap_err()
            .contains("no matcher"));
        assert!(Manifest::parse(&rule("contains = [\"x\"]\nsurprise = true")).is_err());
        assert!(Manifest::parse("id = \"t\"\nmin_engine_version = 2\n")
            .unwrap_err()
            .contains("newer"));
        assert!(Manifest::parse("not toml [").is_err());
    }

    #[test]
    fn kind_comes_from_the_rule_name_and_only_for_a_blocked_screen() {
        let d = |state, rule: &str| Detection {
            state,
            rule: rule.into(),
        };
        assert_eq!(
            d(ScreenState::Blocked, "question_prompt").kind(),
            Some("question")
        );
        assert_eq!(
            d(ScreenState::Blocked, "legacy_permission_prompt").kind(),
            Some("permission")
        );
        assert_eq!(
            d(ScreenState::Blocked, "apply_or_allow_change").kind(),
            Some("permission")
        );
        assert_eq!(d(ScreenState::Blocked, "something_else").kind(), None);
        assert_eq!(d(ScreenState::Working, "permission_prompt").kind(), None);
    }
}
