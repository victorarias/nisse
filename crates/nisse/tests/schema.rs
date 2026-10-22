//! The committed protocol schema is what clients generate their types from.

use std::process::Command;

#[test]
fn committed_schema_matches_the_protocol() {
    let committed = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../schema/nisse.schema.json"
    ))
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nisse"))
        .arg("schema")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout).unwrap() == committed,
        "schema/nisse.schema.json is stale: run `cargo run -q -p nisse -- schema > schema/nisse.schema.json`"
    );
}
