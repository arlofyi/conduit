//! The mobile bridge's protocol, frozen against the phone apps already installed.
//!
//! A phone updates on its own schedule (an APK someone has not installed yet, an iOS build
//! that predates this desktop), so the desktop must keep understanding every frame a
//! RELEASED phone sends and keep sending every frame type it reads. Nothing enforced that:
//! `ClientMsg` is a serde enum, and making a field required, renaming one, or dropping a
//! frame type compiles and passes every other test while silently breaking those phones.
//! The worst case does not even fail to parse -- a renamed OPTIONAL field deserializes as
//! its default, so the phone's setting is quietly ignored.
//!
//! `bridge_protocol_released.json` is the record:
//!
//! - `clientFrames`: example frames as a released phone sends them, each with the value it
//!   must still parse to (the `Debug` text, which redacts secrets).
//! - `serverFrameTypes`: the `type` values a released phone reads.
//!
//! The rule is ADD, NEVER EDIT. A new message or field gets new entries; an existing entry
//! changing is the breaking change this file exists to catch. To record new frames, add
//! them with `"parsed": ""` and run
//! `CONDUIT_BLESS_BRIDGE_PROTOCOL=1 cargo test bridge_protocol` -- that fills in empty
//! entries only and never rewrites one that already has a value.
//!
//! The idea is Herdr's `released.openrpc.json` (its core fails CI on a breaking API
//! change); this is the same guard for a protocol with no schema generator.

use crate::bridge::{parse_client_msg, ClientMsg};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

const RELEASED: &str = include_str!("bridge_protocol_released.json");

fn released_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bridge_protocol_released.json")
}

/// The wire `type` of a parsed message. No wildcard arm on purpose: adding a variant to
/// `ClientMsg` fails to compile here, and the test below then demands a frozen frame for it.
fn wire_type(msg: &ClientMsg) -> &'static str {
    match msg {
        ClientMsg::List => "list",
        ClientMsg::Attach { .. } => "attach",
        ClientMsg::Input { .. } => "input",
        ClientMsg::Resize { .. } => "resize",
        ClientMsg::Git { .. } => "git",
        ClientMsg::Kill { .. } => "kill",
        ClientMsg::Spawn { .. } => "spawn",
        ClientMsg::Auth { .. } => "auth",
        ClientMsg::Pair { .. } => "pair",
        ClientMsg::Discover => "discover",
        ClientMsg::Interrupt { .. } => "interrupt",
        ClientMsg::Answer { .. } => "answer",
        ClientMsg::Approve { .. } => "approve",
        ClientMsg::Upload { .. } => "upload",
        ClientMsg::SessionAction { .. } => "sessionaction",
        ClientMsg::SessionOptions { .. } => "sessionoptions",
        ClientMsg::SessionSet { .. } => "sessionset",
        ClientMsg::Usage { .. } => "usage",
        ClientMsg::Ports => "ports",
        ClientMsg::Tunnel { .. } => "tunnel",
        ClientMsg::FsList { .. } => "fslist",
        ClientMsg::FsRead { .. } => "fsread",
        ClientMsg::FsWrite { .. } => "fswrite",
        ClientMsg::FsDownload { .. } => "fsdownload",
        ClientMsg::FsAck { .. } => "fsack",
        ClientMsg::RootChats => "rootchats",
        ClientMsg::RootChatCreate { .. } => "rootchatcreate",
        ClientMsg::RootChatSettings { .. } => "rootchatsettings",
        ClientMsg::RootChatOptions { .. } => "rootchatoptions",
        ClientMsg::RootChatHistory { .. } => "rootchathistory",
        ClientMsg::RootChatSend { .. } => "rootchatsend",
        ClientMsg::RootChatStop { .. } => "rootchatstop",
        ClientMsg::RootChatScope { .. } => "rootchatscope",
    }
}

/// Every wire type `wire_type` can answer. Kept beside it: a new arm above with no entry
/// here fails `every_message_has_a_frozen_frame` through `the_type_list_matches_the_enum`.
const WIRE_TYPES: &[&str] = &[
    "list",
    "attach",
    "input",
    "resize",
    "git",
    "kill",
    "spawn",
    "auth",
    "pair",
    "discover",
    "interrupt",
    "answer",
    "approve",
    "upload",
    "sessionaction",
    "sessionoptions",
    "sessionset",
    "usage",
    "ports",
    "tunnel",
    "fslist",
    "fsread",
    "fswrite",
    "fsdownload",
    "fsack",
    "rootchats",
    "rootchatcreate",
    "rootchatsettings",
    "rootchatoptions",
    "rootchathistory",
    "rootchatsend",
    "rootchatstop",
    "rootchatscope",
];

fn released() -> Value {
    serde_json::from_str(RELEASED).expect("bridge_protocol_released.json is valid JSON")
}

/// `"type": "<word>"` literals in a Rust source: how every server frame is spelled, since
/// they are built with `json!` wherever they are sent.
fn type_literals(source: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = source;
    while let Some(at) = rest.find("\"type\"") {
        rest = &rest[at + 6..];
        let after = rest.trim_start();
        let Some(after) = after.strip_prefix(':') else {
            continue;
        };
        let Some(after) = after.trim_start().strip_prefix('"') else {
            continue;
        };
        let word: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if !word.is_empty() && after[word.len()..].starts_with('"') {
            found.insert(word);
        }
    }
    found
}

#[test]
fn type_literals_reads_json_macro_spellings() {
    let src = r#"json!({ "type": "authOk" }); json!({"type":"hello","v":1}); let t = "type"; x["type"] == "no""#;
    let found = type_literals(src);
    assert!(found.contains("authOk") && found.contains("hello"));
    assert_eq!(found.len(), 2, "{found:?}");
}

#[test]
fn a_released_phones_frames_still_parse_to_the_same_values() {
    let bless = std::env::var("CONDUIT_BLESS_BRIDGE_PROTOCOL").as_deref() == Ok("1");
    let mut doc = released();
    let mut blessed = 0;
    let mut problems = Vec::new();
    for entry in doc["clientFrames"].as_array_mut().expect("clientFrames") {
        let text = entry["frame"].to_string();
        let parsed = parse_client_msg(&text).map(|m| format!("{m:?}"));
        let expected = entry["parsed"].as_str().unwrap_or_default().to_string();
        match parsed {
            None => problems.push(format!("no longer parses: {text}")),
            Some(now) if expected.is_empty() => {
                if bless {
                    entry["parsed"] = Value::String(now);
                    blessed += 1;
                } else {
                    problems.push(format!(
                        "not recorded yet (run with CONDUIT_BLESS_BRIDGE_PROTOCOL=1): {text}"
                    ));
                }
            }
            Some(now) if now != expected => problems.push(format!(
                "parses differently now: {text}\n    released: {expected}\n    now:      {now}"
            )),
            Some(_) => {}
        }
    }
    if blessed > 0 {
        let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
        std::fs::write(released_path(), text).expect("write the released file");
    }
    assert!(
        problems.is_empty(),
        "the bridge no longer understands frames a released phone sends:\n  {}",
        problems.join("\n  ")
    );
}

#[test]
fn the_type_list_matches_the_enum() {
    // Each listed type parses (from its frozen frame) to a message that reports that type,
    // so the list and `wire_type` cannot drift apart.
    let doc = released();
    let frames = doc["clientFrames"].as_array().unwrap();
    for ty in WIRE_TYPES {
        let frame = frames
            .iter()
            .find(|e| e["frame"]["type"] == *ty)
            .unwrap_or_else(|| panic!("no frozen frame for `{ty}`"));
        let msg = parse_client_msg(&frame["frame"].to_string())
            .unwrap_or_else(|| panic!("the frozen `{ty}` frame does not parse"));
        assert_eq!(wire_type(&msg), *ty);
    }
    let unique: BTreeSet<_> = WIRE_TYPES.iter().collect();
    assert_eq!(
        unique.len(),
        WIRE_TYPES.len(),
        "a wire type is listed twice"
    );
}

#[test]
fn every_frozen_frame_is_a_known_message() {
    let doc = released();
    for entry in doc["clientFrames"].as_array().unwrap() {
        let ty = entry["frame"]["type"].as_str().expect("a frame has a type");
        assert!(
            WIRE_TYPES.contains(&ty),
            "frozen frame of unknown type `{ty}`"
        );
    }
}

#[test]
fn every_frame_type_a_released_phone_reads_is_still_sent() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sent = BTreeSet::new();
    for entry in std::fs::read_dir(&dir).expect("src dir").flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "rs")
            && path.file_name().is_some_and(|n| n != "bridge_protocol.rs")
        {
            sent.extend(type_literals(
                &std::fs::read_to_string(&path).unwrap_or_default(),
            ));
        }
    }
    let doc = released();
    let missing: Vec<&str> = doc["serverFrameTypes"]
        .as_array()
        .expect("serverFrameTypes")
        .iter()
        .filter_map(Value::as_str)
        .filter(|ty| !sent.contains(*ty))
        .collect();
    assert!(
        missing.is_empty(),
        "frame types a released phone reads are no longer sent anywhere: {missing:?}"
    );
}

#[test]
fn a_breaking_change_would_be_caught() {
    // The guard itself, exercised: the three ways a change breaks an installed phone.
    // A field the phone does not send becomes required -> its frame stops parsing.
    assert!(parse_client_msg(r#"{"type":"fsack"}"#).is_none());
    // A message type is renamed -> the old spelling stops parsing.
    assert!(parse_client_msg(
        r#"{"type":"sessionAction","requestId":"r","action":"stop","sessionIds":[]}"#
    )
    .is_none());
    // An optional field is renamed -> it parses, but to a different value. This is the
    // silent one, and the reason the frozen file records values, not just "it parsed".
    let sent = parse_client_msg(
        r#"{"type":"sessionset","sessionId":"s","requestId":"r","keepRunning":true}"#,
    )
    .map(|m| format!("{m:?}"));
    let misspelt = parse_client_msg(
        r#"{"type":"sessionset","sessionId":"s","requestId":"r","keep_running":true}"#,
    )
    .map(|m| format!("{m:?}"));
    assert!(sent.is_some() && misspelt.is_some());
    assert_ne!(sent, misspelt);
}
