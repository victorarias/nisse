//! Plays a recorded claude to Nisse. It reads the fixture `.nisse-claude-replay.ndjson` from its
//! working directory, takes the recorded processes in the order they were started (counting
//! starts in `.nisse-claude-replay.started`) and checks that its argv matches, prints that
//! process's inbound frames in order, and checks every frame Nisse writes against the recorded
//! one. `"<any>"` matches any value; `<nisse:N>` binds to the id Nisse chose there; `<session>`,
//! `<workspace>` and `<home>` stand for this run's values. A mismatch exits with status 1.

use std::{
    collections::HashMap,
    io::{BufRead, Write},
    path::Path,
    process::ExitCode,
};

use serde_json::Value;

const FIXTURE: &str = ".nisse-claude-replay.ndjson";
const STARTED: &str = ".nisse-claude-replay.started";

enum Step {
    Emit(Value),
    Expect(Value),
}

type Bindings = HashMap<String, String>;

fn main() -> ExitCode {
    match replay() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("nisse-claude-replay: {error}");
            ExitCode::FAILURE
        }
    }
}

fn replay() -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let fixture = std::fs::read_to_string(cwd.join(FIXTURE))
        .map_err(|error| format!("could not read {FIXTURE}: {error}"))?;
    let argv: Vec<String> = std::env::args().skip(1).collect();

    let mut bindings = Bindings::new();
    bindings.insert("<workspace>".into(), cwd.to_string_lossy().into_owned());
    if let Some(home) = std::env::var_os("HOME") {
        bindings.insert("<home>".into(), home.to_string_lossy().into_owned());
    }
    if let Some(session) = argv
        .windows(2)
        .find(|pair| pair[0] == "--session-id" || pair[0] == "--resume")
        .map(|pair| pair[1].clone())
    {
        bindings.insert("<session>".into(), session);
    }

    let steps = process_steps(&cwd, &fixture, &argv, &mut bindings)?;
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut stdout = std::io::stdout().lock();
    let mut steps = steps.into_iter().peekable();
    while let Some(step) = steps.next() {
        match step {
            Step::Emit(frame) => {
                let line = substituted(frame, &bindings).to_string();
                if writeln!(stdout, "{line}")
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    return Ok(());
                }
            }
            Step::Expect(first) => {
                let mut window = vec![first];
                while let Some(Step::Expect(_)) = steps.peek() {
                    if let Some(Step::Expect(next)) = steps.next() {
                        window.push(next);
                    }
                }
                while !window.is_empty() {
                    let Some(Ok(line)) = lines.next() else {
                        return Err(format!(
                            "nisse closed stdin while {} recorded frame(s) were still expected, \
                             the first: {}",
                            window.len(),
                            window[0]
                        ));
                    };
                    let actual: Value = serde_json::from_str(&line).map_err(|error| {
                        format!("nisse wrote a line that is not JSON ({error}): {line}")
                    })?;
                    let matched = window.iter().position(|expected| {
                        let mut tentative = bindings.clone();
                        let found = matches(expected, &actual, &mut tentative);
                        if found {
                            bindings = tentative;
                        }
                        found
                    });
                    match matched {
                        Some(index) => {
                            window.remove(index);
                        }
                        None => {
                            return Err(format!(
                                "nisse wrote {actual}\nbut the recording expects one of:\n{}",
                                window
                                    .iter()
                                    .map(Value::to_string)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            ));
                        }
                    }
                }
            }
        }
    }
    match lines.next() {
        Some(Ok(line)) => Err(format!("nisse wrote past the end of the recording: {line}")),
        Some(Err(error)) => Err(error.to_string()),
        None => Ok(()),
    }
}

/// The steps of the next recorded process: the nth claude started in this workspace plays the
/// nth one, and its argv must match.
fn process_steps(
    cwd: &Path,
    fixture: &str,
    argv: &[String],
    bindings: &mut Bindings,
) -> Result<Vec<Step>, String> {
    let mut processes: Vec<(Value, Vec<Step>)> = Vec::new();
    for (number, line) in fixture.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(line)
            .map_err(|error| format!("{FIXTURE}:{}: {error}", number + 1))?;
        let frame = record["frame"].clone();
        match record["type"].as_str() {
            Some("expect_outbound") if frame.get("argv").is_some() => {
                processes.push((frame["argv"].clone(), Vec::new()));
            }
            Some("expect_outbound") => {
                if let Some((_, steps)) = processes.last_mut() {
                    steps.push(Step::Expect(frame));
                }
            }
            Some("emit_inbound") => {
                if let Some((_, steps)) = processes.last_mut() {
                    steps.push(Step::Emit(frame));
                }
            }
            _ => {}
        }
    }
    let started_path = cwd.join(STARTED);
    let started: usize = std::fs::read_to_string(&started_path)
        .ok()
        .and_then(|count| count.trim().parse().ok())
        .unwrap_or(0);
    std::fs::write(&started_path, (started + 1).to_string())
        .map_err(|error| format!("could not write {STARTED}: {error}"))?;
    let actual = Value::from(argv.to_vec());
    let Some((expected, steps)) = processes.into_iter().nth(started) else {
        return Err(format!(
            "claude was started {} times, more than the recording holds, with {actual}",
            started + 1
        ));
    };
    if !matches(&expected, &actual, bindings) {
        return Err(format!(
            "start {} of claude was recorded with {expected} but was started with {actual}",
            started + 1
        ));
    }
    Ok(steps)
}

fn matches(expected: &Value, actual: &Value, bindings: &mut Bindings) -> bool {
    match (expected, actual) {
        (Value::String(any), _) if any == "<any>" => true,
        (Value::String(expected), Value::String(actual)) => {
            if is_binding(expected) && !bindings.contains_key(expected) {
                bindings.insert(expected.clone(), actual.clone());
                return true;
            }
            substitute(expected, bindings) == *actual
        }
        (Value::Array(expected), Value::Array(actual)) => {
            expected.len() == actual.len()
                && expected
                    .iter()
                    .zip(actual)
                    .all(|(expected, actual)| matches(expected, actual, bindings))
        }
        (Value::Object(expected), Value::Object(actual)) => {
            expected.len() == actual.len()
                && expected.iter().all(|(key, expected)| {
                    actual
                        .get(key)
                        .is_some_and(|actual| matches(expected, actual, bindings))
                })
        }
        (expected, actual) => expected == actual,
    }
}

fn is_binding(text: &str) -> bool {
    text.strip_prefix("<nisse:")
        .and_then(|rest| rest.strip_suffix('>'))
        .is_some_and(|number| number.chars().all(|digit| digit.is_ascii_digit()))
}

fn substitute(text: &str, bindings: &Bindings) -> String {
    bindings
        .iter()
        .fold(text.to_owned(), |text, (placeholder, value)| {
            text.replace(placeholder.as_str(), value)
        })
}

fn substituted(frame: Value, bindings: &Bindings) -> Value {
    match frame {
        Value::String(text) => Value::String(substitute(&text, bindings)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| substituted(item, bindings))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, substituted(value, bindings)))
                .collect(),
        ),
        other => other,
    }
}
