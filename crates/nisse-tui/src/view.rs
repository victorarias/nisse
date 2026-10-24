use std::collections::{HashMap, HashSet};

use nisse_protocol::{Actor, ConversationStatus, Entry, kinds};
use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Padding, Paragraph},
};
use serde_json::Value;

use crate::{
    App, gnome,
    theme::{LOGO, Theme},
};

const SPINNER: [char; 8] = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

pub fn draw(frame: &mut Frame, app: &App, theme: &Theme) {
    let [header, transcript, input, status] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    frame.render_widget(
        Paragraph::new(header_line(app, theme)).style(theme.bar()),
        header,
    );
    if app.entries.is_empty() && app.live.is_empty() {
        draw_splash(frame, transcript, theme);
    } else {
        draw_transcript(frame, transcript, app, theme);
    }
    draw_input(frame, input, app, theme);
    frame.render_widget(
        Paragraph::new(status_left(app, theme)).style(theme.bar()),
        status,
    );
    frame.render_widget(
        Paragraph::new(status_right(app, theme)).alignment(Alignment::Right),
        status,
    );
}

/// A solid tag that fades into the bar behind it.
fn chip(text: &str, color: Color, theme: &Theme) -> [Span<'static>; 2] {
    [
        Span::styled(format!(" {text} "), theme.chip(color)),
        Span::styled("▓▒░", theme.chip_edge(color)),
    ]
}

fn header_line(app: &App, theme: &Theme) -> Line<'static> {
    let mut spans = vec![
        Span::styled("░▒▓", theme.chip_edge(theme.cyan)),
        Span::styled(" N I S S E ", theme.chip(theme.cyan)),
        Span::styled("▓▒░", theme.chip_edge(theme.cyan)),
        Span::styled(" // ", theme.fg(theme.faint)),
    ];
    match &app.conversation.title {
        Some(title) => spans.push(Span::styled(title.clone(), theme.fg(theme.ink))),
        None => {
            spans.push(Span::styled("conversation ", theme.fg(theme.dim)));
            spans.push(Span::styled(
                short_id(&app.conversation.id),
                theme.fg(theme.ink),
            ));
        }
    }
    Line::from(spans)
}

fn short_id(id: &str) -> String {
    let skip = id.chars().count().saturating_sub(8);
    id.chars().skip(skip).collect()
}

fn draw_splash(frame: &mut Frame, area: Rect, theme: &Theme) {
    let logo_width = LOGO[0].chars().count();
    let mut lines: Vec<Line> = if area.width as usize > gnome::WIDTH + GNOME_GAP + logo_width {
        gnome_beside_logo(theme)
    } else {
        gnome::rows(theme).into_iter().map(Line::from).collect()
    };
    lines.push(Line::raw(""));
    lines.push(Line::styled(
        "D U R A B L E  ·  M U L T I P L A Y E R  ·  C O D I N G   A G E N T",
        theme.fg(theme.dim),
    ));
    lines.push(Line::raw(""));
    lines.push(Line::from(vec![
        Span::styled("━━━━━━━━━━━━━━━━ ", theme.fg(theme.faint)),
        Span::styled("◆", theme.glow(theme.magenta)),
        Span::styled(" ━━━━━━━━━━━━━━━━", theme.fg(theme.faint)),
    ]));
    lines.push(Line::raw(""));
    lines.push(key_hints(theme));
    let height = lines.len() as u16;
    let top = area.y + area.height.saturating_sub(height) / 2;
    let centred = Rect {
        y: top,
        height: height.min(area.height),
        ..area
    };
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), centred);
}

const GNOME_GAP: usize = 4;

/// The gnome on the left, the wordmark beside it, centred on the gnome's height.
fn gnome_beside_logo(theme: &Theme) -> Vec<Line<'static>> {
    let logo_width = LOGO[0].chars().count();
    let first_logo_row = (gnome::HEIGHT - LOGO.len()) / 2;
    gnome::rows(theme)
        .into_iter()
        .enumerate()
        .map(|(row, mut spans)| {
            spans.push(Span::raw(" ".repeat(GNOME_GAP)));
            match row
                .checked_sub(first_logo_row)
                .and_then(|index| LOGO.get(index).zip(theme.logo.get(index)))
            {
                Some((logo, color)) => spans.extend(logo_row(logo, *color, theme).spans),
                None => spans.push(Span::raw(" ".repeat(logo_width))),
            }
            Line::from(spans)
        })
        .collect()
}

fn logo_row(row: &str, color: Color, theme: &Theme) -> Line<'static> {
    let spans: Vec<Span> = row
        .chars()
        .map(|cell| {
            let style = match cell {
                '█' => theme.glow(color),
                _ => theme.fg(theme.shadow),
            };
            Span::styled(cell.to_string(), style)
        })
        .collect();
    Line::from(spans)
}

fn key_hints(theme: &Theme) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, (key, action)) in [
        ("⏎", "send"),
        ("!cmd", "shell"),
        ("PgUp", "scroll"),
        ("^C", "quit"),
    ]
    .into_iter()
    .enumerate()
    {
        if index > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(format!(" {key} "), theme.key()));
        spans.push(Span::styled(format!(" {action}"), theme.fg(theme.dim)));
    }
    Line::from(spans)
}

fn draw_transcript(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let inner = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(1),
    };
    let width = inner.width as usize;
    let calls = Calls::of(&app.entries);
    let mut lines: Vec<Line> = app
        .entries
        .iter()
        .flat_map(|entry| entry_lines(entry, &calls, width, theme))
        .collect();
    let running_tool = app.status == ConversationStatus::Working
        && app.entries.last().is_some_and(|entry| {
            entry.kind == kinds::TOOL_CALL
                || (entry.kind == kinds::APPROVAL && entry.data["allow"].as_bool() == Some(true))
        });
    if running_tool {
        lines.push(Line::from(vec![
            Span::styled("┗━ ", theme.fg(theme.faint)),
            Span::styled(
                format!("{} RUNNING", SPINNER[app.frame % SPINNER.len()]),
                theme.glow(theme.yellow),
            ),
        ]));
    }
    if !app.live.is_empty() {
        lines.push(speaker("NISSE".into(), theme.cyan, width, theme));
        lines.extend(body(
            &app.live,
            width.saturating_sub(1),
            theme.fg(theme.ink),
        ));
        if let Some(last) = lines.last_mut() {
            last.push_span(Span::styled("▍", theme.glow(theme.cyan)));
        }
    }
    let visible = inner.height as usize;
    let bottom = lines.len().saturating_sub(app.scroll_back as usize);
    let top = bottom.saturating_sub(visible);
    let shown: Vec<Line> = lines.into_iter().skip(top).take(bottom - top).collect();
    frame.render_widget(Paragraph::new(shown), inner);
}

fn speaker(label: String, color: Color, width: usize, theme: &Theme) -> Line<'static> {
    let [tag, edge] = chip(&label, color, theme);
    let used = label.chars().count() + 5;
    Line::from(vec![
        tag,
        edge,
        Span::styled(
            format!(" {}", "─".repeat(width.saturating_sub(used + 1))),
            theme.fg(theme.faint),
        ),
    ])
}

fn body(text: &str, width: usize, style: Style) -> Vec<Line<'static>> {
    wrap(text, width.saturating_sub(2))
        .into_iter()
        .map(|row| Line::from(vec![Span::raw("  "), Span::styled(row, style)]))
        .collect()
}

struct Calls<'a> {
    called: HashSet<&'a str>,
    asked: HashSet<&'a str>,
    answers: HashMap<&'a str, &'a Entry>,
    finished: HashSet<&'a str>,
}

impl<'a> Calls<'a> {
    fn of(entries: &'a [Entry]) -> Self {
        let mut calls = Self {
            called: HashSet::new(),
            asked: HashSet::new(),
            answers: HashMap::new(),
            finished: HashSet::new(),
        };
        for entry in entries {
            match entry.kind.as_str() {
                kinds::TOOL_CALL => {
                    calls.called.insert(call_id(entry, "id"));
                }
                kinds::APPROVAL_REQUEST => {
                    calls.asked.insert(call_id(entry, "call_id"));
                }
                kinds::APPROVAL => {
                    calls.answers.insert(call_id(entry, "call_id"), entry);
                }
                kinds::TOOL_RESULT => {
                    calls.finished.insert(call_id(entry, "call_id"));
                }
                _ => {}
            }
        }
        calls
    }

    fn waiting(&self, id: &str) -> bool {
        !self.answers.contains_key(id) && !self.finished.contains(id)
    }
}

fn call_id<'a>(entry: &'a Entry, field: &str) -> &'a str {
    entry.data[field].as_str().unwrap_or_default()
}

/// The call id of the oldest approval request that still waits for an answer.
pub fn pending_approval(entries: &[Entry]) -> Option<&str> {
    let calls = Calls::of(entries);
    entries
        .iter()
        .filter(|entry| entry.kind == kinds::APPROVAL_REQUEST)
        .map(|request| call_id(request, "call_id"))
        .find(|id| calls.waiting(id))
}

fn args_summary(args: &Value) -> String {
    if let Some(script) = args.as_str() {
        return script.to_owned();
    }
    ["command", "file_path", "path", "pattern"]
        .into_iter()
        .find_map(|key| args[key].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| args.to_string())
}

fn card_head(
    icon: &str,
    color: Color,
    entry: &Entry,
    width: usize,
    theme: &Theme,
) -> Line<'static> {
    let label = format!(
        "{icon} {}",
        entry.data["name"].as_str().unwrap_or("tool").to_uppercase()
    );
    let room = width.saturating_sub(label.chars().count() + 5);
    Line::from(vec![
        Span::styled("┏━ ", theme.fg(theme.faint)),
        Span::styled(label, theme.glow(color)),
        Span::raw("  "),
        Span::styled(
            truncate(&args_summary(&entry.data["args"]), room),
            theme.fg(theme.ink),
        ),
    ])
}

fn actor_name(actor: &Actor) -> String {
    match actor {
        Actor::Person { name, .. } | Actor::Extension { name } => name.clone(),
        Actor::Model { model } => model.clone(),
        Actor::Agent { .. } => "an agent".into(),
        Actor::System => "nisse".into(),
    }
}

fn approval_lines(
    request: &Entry,
    calls: &Calls,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let id = call_id(request, "call_id");
    let waiting = calls.waiting(id);
    let mut lines = vec![if waiting {
        card_head("⏸ APPROVE", theme.yellow, request, width, theme)
    } else {
        card_head("⚙", theme.violet, request, width, theme)
    }];
    if let Some(reason) = request.data["reason"]
        .as_str()
        .filter(|reason| !reason.is_empty())
    {
        lines.extend(
            wrap(reason, width.saturating_sub(3))
                .into_iter()
                .map(|row| {
                    Line::from(vec![
                        Span::styled("┃ ", theme.fg(theme.faint)),
                        Span::styled(row, theme.fg(theme.dim)),
                    ])
                }),
        );
    }
    if waiting {
        lines.push(Line::from(vec![
            Span::styled("┗━ ", theme.fg(theme.faint)),
            Span::styled("^Y", theme.glow(theme.yellow)),
            Span::styled(" allow · ", theme.fg(theme.dim)),
            Span::styled("^N", theme.glow(theme.yellow)),
            Span::styled(" deny", theme.fg(theme.dim)),
        ]));
        return lines;
    }
    let Some(answer) = calls.answers.get(id) else {
        return lines;
    };
    let (mark, color) = if answer.data["allow"].as_bool() == Some(true) {
        ("✓ ALLOWED", theme.cyan)
    } else {
        ("⊘ DECLINED", theme.yellow)
    };
    let continues = calls.called.contains(id);
    lines.push(Line::from(vec![
        Span::styled(if continues { "┣━ " } else { "┗━ " }, theme.fg(theme.faint)),
        Span::styled(mark, theme.glow(color)),
        Span::styled(
            format!(" by {}", actor_name(&answer.author)),
            theme.fg(theme.dim),
        ),
    ]));
    if !continues {
        lines.push(Line::raw(""));
    }
    lines
}

/// An entry's lines; a call a script made, and what came of it, sit inside the script's card.
fn entry_lines(entry: &Entry, calls: &Calls, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    if !entry.data["parent"].is_string() {
        return own_lines(entry, calls, width, theme);
    }
    let mut lines = own_lines(entry, calls, width.saturating_sub(2), theme);
    if lines.last().is_some_and(|last| last.width() == 0) {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| {
            let mut nested = Line::from(Span::styled("┃ ", theme.fg(theme.faint)));
            nested.spans.extend(line.spans);
            nested
        })
        .collect()
}

fn own_lines(entry: &Entry, calls: &Calls, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let text = entry.data["text"].as_str().unwrap_or_default();
    let mut lines = match entry.kind.as_str() {
        kinds::USER => {
            let who = match &entry.author {
                Actor::Person { name, .. } => name.to_uppercase(),
                _ => "INPUT".into(),
            };
            let mut lines = vec![speaker(who, theme.magenta, width, theme)];
            lines.extend(body(text, width, theme.fg(theme.ink)));
            lines
        }
        kinds::ASSISTANT => {
            let failed = entry.data["is_error"].as_bool() == Some(true);
            let color = if failed { theme.yellow } else { theme.cyan };
            let mut lines = vec![speaker("NISSE".into(), color, width, theme)];
            lines.extend(body(text, width, theme.fg(theme.ink)));
            lines
        }
        kinds::TOOL_CALL if calls.asked.contains(call_id(entry, "id")) => return Vec::new(),
        kinds::TOOL_CALL => return vec![card_head("⚙", theme.violet, entry, width, theme)],
        kinds::APPROVAL_REQUEST => return approval_lines(entry, calls, width, theme),
        kinds::APPROVAL => return Vec::new(),
        kinds::TOOL_RESULT => tool_result_lines(entry, width, theme),
        other => vec![Line::styled(format!("· {other}"), theme.fg(theme.dim))],
    };
    lines.push(Line::raw(""));
    lines
}

fn tool_result_lines(entry: &Entry, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    if let Some(reason) = entry.data["denied"].as_str() {
        return vec![Line::from(vec![
            Span::styled("┗━ ", theme.fg(theme.faint)),
            Span::styled("⊘ DENIED", theme.glow(theme.yellow)),
            Span::styled(format!("  {reason}"), theme.fg(theme.yellow)),
        ])];
    }
    let failed = entry.data["is_error"].as_bool() == Some(true);
    let output = entry.data["output"].as_str().unwrap_or_default().trim_end();
    let mut lines: Vec<Line> = wrap(output, width.saturating_sub(3))
        .into_iter()
        .filter(|_| !output.is_empty())
        .map(|row| {
            Line::from(vec![
                Span::styled("┃ ", theme.fg(theme.faint)),
                Span::styled(row, theme.fg(theme.dim)),
            ])
        })
        .collect();
    let (mark, color) = if failed {
        ("✗ FAILED", theme.magenta)
    } else {
        ("✓ DONE", theme.cyan)
    };
    lines.push(Line::from(vec![
        Span::styled("┗━ ", theme.fg(theme.faint)),
        Span::styled(mark, theme.glow(color)),
    ]));
    lines
}

fn truncate(text: &str, room: usize) -> String {
    let first_line = text.lines().next().unwrap_or_default();
    if first_line.chars().count() <= room && !text.contains('\n') {
        return first_line.to_owned();
    }
    let kept: String = first_line.chars().take(room.saturating_sub(1)).collect();
    format!("{kept}…")
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(8);
    text.split('\n')
        .flat_map(|line| {
            let characters: Vec<char> = line.chars().collect();
            if characters.is_empty() {
                return vec![String::new()];
            }
            characters
                .chunks(width)
                .map(|chunk| chunk.iter().collect())
                .collect()
        })
        .collect()
}

fn draw_input(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let working = app.status == ConversationStatus::Working;
    let accent = if working { theme.faint } else { theme.magenta };
    let mut block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(theme.fg(if working { theme.faint } else { theme.violet }))
        .padding(Padding::horizontal(1))
        .title(Line::from(Span::styled(
            if working { " QUEUE " } else { " PROMPT " },
            theme.glow(accent),
        )));
    if let Some(error) = &app.error {
        block = block.title_bottom(Line::from(Span::styled(
            format!(" ✗ {error} "),
            theme.glow(theme.yellow),
        )));
    }
    let room = area.width.saturating_sub(8) as usize;
    let typed: String = app
        .input
        .chars()
        .rev()
        .take(room)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let mut spans = vec![Span::styled("❯ ", theme.glow(theme.magenta))];
    if typed.is_empty() {
        spans.push(Span::styled("▍", theme.glow(theme.magenta)));
        spans.push(Span::styled(
            if pending_approval(&app.entries).is_some() {
                "^Y to allow, ^N to deny, or type a message"
            } else if working {
                "type to queue a follow-up"
            } else {
                "type a message, or !cmd to run a shell command"
            },
            theme.fg(theme.faint),
        ));
    } else {
        spans.push(Span::styled(typed, theme.fg(theme.ink)));
        spans.push(Span::styled("▍", theme.glow(theme.magenta)));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)).block(block), area);
}

fn status_left(app: &App, theme: &Theme) -> Line<'static> {
    let mut spans: Vec<Span> = match (app.status, app.working_since) {
        (ConversationStatus::Working, Some(since)) => {
            let elapsed = since.elapsed().as_secs();
            let mut spans = chip(
                &format!("{} WORKING", SPINNER[app.frame % SPINNER.len()]),
                theme.cyan,
                theme,
            )
            .to_vec();
            spans.push(Span::styled(
                format!(
                    " {:02}:{:02}:{:02}",
                    elapsed / 3600,
                    elapsed / 60 % 60,
                    elapsed % 60
                ),
                theme.glow(theme.cyan),
            ));
            spans
        }
        (ConversationStatus::NeedsApproval, _) => chip("⏸ APPROVAL", theme.yellow, theme).to_vec(),
        (ConversationStatus::Parked, _) => chip("⏏ PARKED", theme.yellow, theme).to_vec(),
        _ => chip("■ READY", theme.magenta, theme).to_vec(),
    };
    for (extension, text) in &app.extension_status {
        spans.push(Span::styled("  ◆ ", theme.fg(theme.violet)));
        spans.push(Span::styled(format!("{extension} "), theme.fg(theme.dim)));
        spans.push(Span::styled(text.clone(), theme.fg(theme.ink)));
    }
    if let Some((toast, _)) = &app.toast {
        spans.push(Span::styled(
            format!("  ✦ {toast}"),
            theme.glow(theme.yellow),
        ));
    }
    Line::from(spans)
}

fn status_right(app: &App, theme: &Theme) -> Line<'static> {
    Line::from(vec![
        Span::styled(app.model.clone(), theme.fg(theme.violet)),
        Span::styled("  │  ", theme.fg(theme.faint)),
        Span::styled(
            format!("nisse {} ", env!("CARGO_PKG_VERSION")),
            theme.fg(theme.dim),
        ),
    ])
}
