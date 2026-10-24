use std::collections::{HashMap, HashSet};

use nisse_protocol::{
    Actor, AuthInteraction, AuthPhase, ConversationStatus, Entry, ModelSelection, ProviderStatus,
    kinds,
};
use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Padding, Paragraph},
};
use serde_json::Value;

use nisse_protocol::AuthState;

use crate::{
    App, gnome,
    picker::Picker,
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
    let said_nothing = app.entries.iter().all(|entry| entry.kind == kinds::MODEL);
    if let Some(picker) = &app.picker {
        draw_picker(frame, transcript, picker, theme);
    } else if said_nothing && app.live.is_empty() {
        draw_splash(frame, transcript, app, theme);
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

/// The gnome and the wordmark, then each provider's setup, or the sign-in on show. The art
/// gives way when the rest needs the room.
fn draw_splash(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let logo_width = LOGO[0].chars().count();
    let art: Vec<Line> = if area.width as usize > gnome::WIDTH + GNOME_GAP + logo_width {
        gnome_beside_logo(theme)
    } else {
        gnome::rows(theme).into_iter().map(Line::from).collect()
    };
    let mut lines = vec![
        Line::styled(
            "D U R A B L E  ·  M U L T I P L A Y E R  ·  C O D I N G   A G E N T",
            theme.fg(theme.dim),
        ),
        Line::raw(""),
        Line::from(vec![
            Span::styled("━━━━━━━━━━━━━━━━ ", theme.fg(theme.faint)),
            Span::styled("◆", theme.glow(theme.magenta)),
            Span::styled(" ━━━━━━━━━━━━━━━━", theme.fg(theme.faint)),
        ]),
        Line::raw(""),
    ];
    let setup = match &app.sign_in {
        Some(state) => sign_in_lines(state, area.width as usize, theme),
        None => provider_lines(app, theme),
    };
    if !setup.is_empty() {
        lines.extend(setup);
        lines.push(Line::raw(""));
    }
    lines.push(key_hints(theme));
    if art.len() + 1 + lines.len() <= area.height as usize {
        lines.splice(0..0, art.into_iter().chain([Line::raw("")]));
    }
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

const SETUP_WIDTH: usize = 60;

/// One line per provider instance, padded alike so they line up when centred. The first one
/// signed out offers the key to sign in.
fn provider_lines(app: &App, theme: &Theme) -> Vec<Line<'static>> {
    let hinted = app
        .providers
        .iter()
        .position(|provider| provider.health.status == ProviderStatus::SignedOut);
    let hint_width = if hinted.is_some() {
        HINT.chars().count() + 4
    } else {
        0
    };
    let id_width = app
        .providers
        .iter()
        .map(|provider| provider.id.chars().count())
        .max()
        .unwrap_or_default();
    let details: Vec<(&str, Color, String)> = app
        .providers
        .iter()
        .map(|provider| {
            let health = &provider.health;
            match health.status {
                ProviderStatus::Ready => (
                    "●",
                    theme.cyan,
                    health.account.clone().unwrap_or_else(|| "ready".into()),
                ),
                ProviderStatus::SignedOut => ("○", theme.yellow, "signed out".into()),
                ProviderStatus::Unavailable => (
                    "✗",
                    theme.faint,
                    health
                        .message
                        .clone()
                        .unwrap_or_else(|| "unavailable".into()),
                ),
            }
        })
        .collect();
    let detail_width = details
        .iter()
        .map(|(_, _, detail)| detail.chars().count())
        .max()
        .unwrap_or_default()
        .min(SETUP_WIDTH.saturating_sub(id_width + 4 + hint_width));
    app.providers
        .iter()
        .zip(details)
        .enumerate()
        .map(|(index, (provider, (mark, color, detail)))| {
            let mut spans = vec![
                Span::styled(format!("{mark} "), theme.glow(color)),
                Span::styled(format!("{:<id_width$}  ", provider.id), theme.fg(theme.ink)),
                Span::styled(
                    format!("{:<detail_width$}", truncate(&detail, detail_width)),
                    theme.fg(theme.dim),
                ),
            ];
            if hinted == Some(index) {
                spans.push(Span::raw("  "));
                spans.push(Span::styled(" ^L ", theme.key()));
                spans.push(Span::styled(format!(" {HINT}"), theme.fg(theme.dim)));
            } else if hint_width > 0 {
                spans.push(Span::raw(" ".repeat(hint_width + 3)));
            }
            Line::from(spans)
        })
        .collect()
}

const HINT: &str = "sign in";

fn sign_in_lines(state: &AuthState, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        Span::styled("◆ ", theme.glow(theme.magenta)),
        Span::styled(
            format!("signing in to {}", state.provider),
            theme.fg(theme.ink),
        ),
    ])];
    let say = |text: String| Line::styled(text, theme.fg(theme.dim));
    match (&state.phase, &state.interaction) {
        (AuthPhase::Waiting, Some(AuthInteraction::Browser { url })) => {
            lines.push(say(
                "finish in the browser that just opened, or open:".into()
            ));
            let room = width.saturating_sub(4).clamp(1, url.chars().count().max(1));
            lines.extend(url.chars().collect::<Vec<_>>().chunks(room).map(|row| {
                let row: String = row.iter().collect();
                Line::styled(format!("{row:<room$}"), theme.fg(theme.violet))
            }));
            lines.push(say(
                "browser on another machine? paste the address it ends on below".into(),
            ));
        }
        (AuthPhase::Waiting, Some(AuthInteraction::DeviceCode { url, code })) => {
            lines.push(say(format!("on any device, open {url}")));
            lines.push(Line::from(vec![
                Span::styled("and enter ", theme.fg(theme.dim)),
                Span::styled(format!(" {code} "), theme.chip(theme.cyan)),
            ]));
        }
        (AuthPhase::Waiting, Some(AuthInteraction::Terminal { command, .. })) => {
            lines.push(say(format!("`{}` runs in a terminal", command.join(" "))));
        }
        (AuthPhase::Verifying, _) => lines.push(say("checking the sign-in…".into())),
        _ => lines.push(say("starting…".into())),
    }
    lines.push(Line::from(vec![
        Span::styled(" Esc ", theme.key()),
        Span::styled(" cancel", theme.fg(theme.dim)),
    ]));
    lines
}

fn key_hints(theme: &Theme) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, (key, action)) in [
        ("⏎", "send"),
        ("!cmd", "shell"),
        ("/model", "model"),
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

/// Every provider's models in one list, the highlighted one with the effort it would get.
fn draw_picker(frame: &mut Frame, area: Rect, picker: &Picker, theme: &Theme) {
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(theme.fg(theme.violet))
        .padding(Padding::horizontal(1))
        .title(Line::from(Span::styled(
            " MODEL ",
            theme.glow(theme.magenta),
        )))
        .title_bottom(Line::from(vec![
            Span::styled(" ↑↓ ", theme.key()),
            Span::styled(" model  ", theme.fg(theme.dim)),
            Span::styled(" ←→ ", theme.key()),
            Span::styled(" effort  ", theme.fg(theme.dim)),
            Span::styled(" ⏎ ", theme.key()),
            Span::styled(" switch  ", theme.fg(theme.dim)),
            Span::styled(" Esc ", theme.key()),
            Span::styled(" close ", theme.fg(theme.dim)),
        ]));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if !picker.listed {
        frame.render_widget(
            Paragraph::new(Line::styled("asking the providers…", theme.fg(theme.dim))),
            inner,
        );
        return;
    }
    let width = inner.width as usize;
    let provider_width = column_width(picker.rows.iter().map(|row| row.provider.as_str()));
    let name_width = column_width(picker.rows.iter().map(|row| row.name.as_str()));
    let effort_width = picker
        .rows
        .iter()
        .flat_map(|row| row.efforts.iter().map(|effort| effort.chars().count()))
        .chain(["default".len()])
        .max()
        .unwrap_or_default();
    let visible = inner.height as usize;
    let top = (picker.cursor + 1).saturating_sub(visible);
    let lines: Vec<Line> = picker
        .rows
        .iter()
        .enumerate()
        .skip(top)
        .take(visible)
        .map(|(index, row)| {
            let highlighted = index == picker.cursor;
            let ink = if highlighted { theme.ink } else { theme.dim };
            let effort = match row.effort {
                Some(effort) => row.efforts[effort].clone(),
                None => "default".into(),
            };
            let mut spans = vec![
                Span::styled(
                    if highlighted { "▸ " } else { "  " },
                    theme.glow(theme.magenta),
                ),
                Span::styled(
                    if row.current { "● " } else { "  " },
                    theme.glow(theme.cyan),
                ),
                Span::styled(
                    format!("{:<provider_width$}  ", row.provider),
                    theme.fg(theme.violet),
                ),
                Span::styled(format!("{:<name_width$}  ", row.name), theme.fg(ink)),
            ];
            let effort = if row.efforts.is_empty() {
                " ".repeat(effort_width + 4)
            } else if highlighted {
                format!("‹ {effort:<effort_width$} ›")
            } else {
                format!("  {effort:<effort_width$}  ")
            };
            spans.push(Span::styled(effort, theme.fg(theme.yellow)));
            let used: usize = spans.iter().map(|span| span.width()).sum();
            if let Some(description) = &row.description {
                spans.push(Span::styled(
                    format!(
                        "  {}",
                        truncate(description, width.saturating_sub(used + 2))
                    ),
                    theme.fg(theme.faint),
                ));
            }
            Line::from(spans)
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn column_width<'a>(cells: impl Iterator<Item = &'a str>) -> usize {
    cells
        .map(|cell| cell.chars().count())
        .max()
        .unwrap_or_default()
}

/// How the status bar and the transcript name a selection: its model, or the provider when it
/// picks, then the effort when one was chosen.
fn selection_label(selection: &ModelSelection) -> String {
    let model = selection
        .model
        .clone()
        .unwrap_or_else(|| selection.provider.clone());
    match &selection.effort {
        Some(effort) => format!("{model} · {effort}"),
        None => model,
    }
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
        .flat_map(|entry| entry_lines(entry, &calls, app, width, theme))
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
    /// The calls that started a subagent, which its card shows instead.
    spawned: HashSet<&'a str>,
    called: HashSet<&'a str>,
    asked: HashSet<&'a str>,
    answers: HashMap<&'a str, &'a Entry>,
    finished: HashSet<&'a str>,
}

impl<'a> Calls<'a> {
    fn of(entries: &'a [Entry]) -> Self {
        let mut calls = Self {
            spawned: HashSet::new(),
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
                kinds::SUBAGENT => {
                    calls.spawned.insert(call_id(entry, "call_id"));
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
fn entry_lines(
    entry: &Entry,
    calls: &Calls,
    app: &App,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    if !entry.data["parent"].is_string() {
        return own_lines(entry, calls, app, width, theme);
    }
    let mut lines = own_lines(entry, calls, app, width.saturating_sub(2), theme);
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

fn own_lines(
    entry: &Entry,
    calls: &Calls,
    app: &App,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let text = entry.data["text"].as_str().unwrap_or_default();
    let spawned = match entry.kind.as_str() {
        kinds::TOOL_CALL => calls.spawned.contains(call_id(entry, "id")),
        kinds::TOOL_RESULT => calls.spawned.contains(call_id(entry, "call_id")),
        _ => false,
    };
    if spawned {
        return Vec::new();
    }
    let mut lines = match entry.kind.as_str() {
        kinds::USER => {
            let who = match (&entry.author, entry.data["mail"]["sender"].as_str()) {
                (_, Some(sender)) => sender.rsplit('/').next().unwrap_or(sender).to_uppercase(),
                (Actor::Person { name, .. }, None) => name.to_uppercase(),
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
        kinds::MODEL => {
            let switched = serde_json::from_value::<ModelSelection>(entry.data.clone())
                .map(|selection| {
                    format!("{} ({})", selection_label(&selection), selection.provider)
                })
                .unwrap_or_else(|_| "another model".into());
            vec![Line::from(vec![
                Span::styled("◆ ", theme.glow(theme.violet)),
                Span::styled(
                    format!("{} switched to ", actor_name(&entry.author)),
                    theme.fg(theme.dim),
                ),
                Span::styled(switched, theme.fg(theme.ink)),
            ])]
        }
        kinds::TOOL_RESULT => tool_result_lines(entry, width, theme),
        kinds::SUBAGENT => subagent_lines(entry, app, width, theme),
        kinds::TOAST => return Vec::new(),
        other => vec![Line::styled(format!("· {other}"), theme.fg(theme.dim))],
    };
    lines.push(Line::raw(""));
    lines
}

/// A subagent's card: what it last did, and whether it works, waits on a person, or ended.
fn subagent_lines(entry: &Entry, app: &App, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let mut label = entry.data["title"]
        .as_str()
        .unwrap_or("subagent")
        .to_owned();
    if let Some(agent_type) = entry.data["agent_type"].as_str() {
        label.push_str(&format!(" · {agent_type}"));
    }
    let mut lines = vec![Line::from(vec![
        Span::styled("┏━ ", theme.fg(theme.faint)),
        Span::styled("◆ AGENT", theme.glow(theme.magenta)),
        Span::raw("  "),
        Span::styled(
            truncate(&label, width.saturating_sub(12)),
            theme.fg(theme.ink),
        ),
    ])];
    let Some(subagent) = entry.data["conversation_id"]
        .as_str()
        .and_then(|id| app.subagents.get(id))
    else {
        return lines;
    };
    let latest = subagent
        .entries
        .iter()
        .rev()
        .find(|entry| entry.kind == kinds::TOOL_CALL || entry.kind == kinds::ASSISTANT);
    let activity = latest.map(|entry| match entry.kind.as_str() {
        kinds::TOOL_CALL => format!(
            "⚙ {}  {}",
            entry.data["name"].as_str().unwrap_or("tool").to_uppercase(),
            args_summary(&entry.data["args"])
        ),
        _ => entry.data["text"].as_str().unwrap_or_default().to_owned(),
    });
    let asking = pending_approval(&subagent.entries).and_then(|id| {
        subagent
            .entries
            .iter()
            .find(|entry| entry.kind == kinds::APPROVAL_REQUEST && call_id(entry, "call_id") == id)
    });
    if let Some(request) = asking {
        let label = format!(
            "⏸ APPROVE {}",
            request.data["name"]
                .as_str()
                .unwrap_or("tool")
                .to_uppercase()
        );
        let room = width.saturating_sub(label.chars().count() + 5);
        lines.push(Line::from(vec![
            Span::styled("┃ ", theme.fg(theme.faint)),
            Span::styled(label, theme.glow(theme.yellow)),
            Span::raw("  "),
            Span::styled(
                truncate(&args_summary(&request.data["args"]), room),
                theme.fg(theme.ink),
            ),
        ]));
    } else if let Some(activity) = activity.filter(|activity| !activity.is_empty()) {
        lines.push(Line::from(vec![
            Span::styled("┃ ", theme.fg(theme.faint)),
            Span::styled(
                truncate(&activity, width.saturating_sub(3)),
                theme.fg(theme.dim),
            ),
        ]));
    }
    let interrupted = latest.is_some_and(|entry| entry.data["interrupted"] == true);
    let end = match (asking, subagent.status) {
        (Some(_), _) => vec![
            Span::styled("^Y", theme.glow(theme.yellow)),
            Span::styled(" allow · ", theme.fg(theme.dim)),
            Span::styled("^N", theme.glow(theme.yellow)),
            Span::styled(" deny", theme.fg(theme.dim)),
        ],
        (None, ConversationStatus::Idle) if interrupted => {
            vec![Span::styled("■ STOPPED", theme.glow(theme.yellow))]
        }
        (None, ConversationStatus::Idle) => vec![Span::styled("✓ DONE", theme.glow(theme.cyan))],
        (None, _) => vec![Span::styled(
            format!("{} WORKING", SPINNER[app.frame % SPINNER.len()]),
            theme.glow(theme.yellow),
        )],
    };
    let mut last = Line::from(Span::styled("┗━ ", theme.fg(theme.faint)));
    last.spans.extend(end);
    lines.push(last);
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
            if app.pending_approval().is_some() {
                "^Y to allow, ^N to deny, or type a message"
            } else if app.awaits_callback() {
                "paste the address your browser ended on"
            } else if working {
                "type to queue a follow-up, or Esc to stop"
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
        Span::styled(
            selection_label(&app.conversation.selection),
            theme.fg(theme.violet),
        ),
        Span::styled("  │  ", theme.fg(theme.faint)),
        Span::styled(
            format!("nisse {} ", env!("CARGO_PKG_VERSION")),
            theme.fg(theme.dim),
        ),
    ])
}
