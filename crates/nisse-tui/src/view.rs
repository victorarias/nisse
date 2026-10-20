use nisse_protocol::{Actor, ConversationStatus, Entry, kinds};
use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Paragraph},
};

use crate::{
    App,
    theme::{LOGO, Theme},
};

pub fn draw(frame: &mut Frame, app: &App, theme: &Theme) {
    let [header, transcript, input, status] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    frame.render_widget(header_line(app, theme), header);
    if app.entries.is_empty() {
        draw_splash(frame, transcript, theme);
    } else {
        draw_transcript(frame, transcript, app, theme);
    }
    draw_input(frame, input, app, theme);
    frame.render_widget(status_bar(app, theme), status);
}

fn header_line(app: &App, theme: &Theme) -> Line<'static> {
    let mut spans: Vec<Span> = "NISSE"
        .chars()
        .zip(theme.chrome.iter().cycle())
        .map(|(letter, color)| Span::styled(format!("{letter} "), Theme::glow(*color)))
        .collect();
    spans.insert(0, Span::raw(" "));
    spans.push(Span::styled("░▒▓ ", Style::new().fg(theme.violet)));
    let title = app.conversation.title.clone().unwrap_or_else(|| {
        app.conversation
            .id
            .chars()
            .rev()
            .take(8)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    });
    spans.push(Span::styled(format!("conversation {title}"), theme.quiet()));
    Line::from(spans)
}

fn draw_splash(frame: &mut Frame, area: Rect, theme: &Theme) {
    let width = area.width as usize;
    let mut lines: Vec<Line> = LOGO
        .iter()
        .zip(theme.chrome)
        .map(|(row, color)| Line::styled(*row, Theme::glow(color)))
        .collect();
    lines.push(Line::raw(""));
    for (bar, color) in [(23, theme.sunset), (19, theme.magenta), (13, theme.violet)] {
        lines.push(Line::styled("▀".repeat(bar), Style::new().fg(color)));
    }
    lines.push(Line::styled(
        "━".repeat(width.min(64)),
        Theme::glow(theme.magenta),
    ));
    lines.extend(
        horizon_grid(width.min(64))
            .into_iter()
            .map(|row| Line::styled(row, Style::new().fg(theme.grid))),
    );
    lines.push(Line::raw(""));
    lines.push(Line::styled(
        "type a message  ·  !cmd runs a shell command  ·  ctrl-c quits",
        theme.quiet(),
    ));
    let height = lines.len() as u16;
    let top = area.y + area.height.saturating_sub(height) / 2;
    let centred = Rect {
        y: top,
        height: height.min(area.height),
        ..area
    };
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), centred);
}

/// Rays from a vanishing point on the horizon, crossed by rows that spread as they come closer.
fn horizon_grid(width: usize) -> Vec<String> {
    let centre = width as i32 / 2;
    (1..=4)
        .map(|depth: i32| {
            let spacing = depth * 3;
            (0..width as i32)
                .map(|x| {
                    let offset = x - centre;
                    if offset == 0 {
                        '│'
                    } else if offset % spacing == 0 {
                        if offset < 0 { '╱' } else { '╲' }
                    } else if depth % 2 == 0 {
                        '─'
                    } else {
                        ' '
                    }
                })
                .collect()
        })
        .collect()
}

fn draw_transcript(frame: &mut Frame, area: Rect, app: &App, theme: &Theme) {
    let width = area.width.saturating_sub(2) as usize;
    let lines: Vec<Line> = app
        .entries
        .iter()
        .flat_map(|entry| entry_lines(entry, width, theme))
        .collect();
    let visible = area.height as usize;
    let bottom = lines.len().saturating_sub(app.scroll_back as usize);
    let top = bottom.saturating_sub(visible);
    let shown: Vec<Line> = lines.into_iter().skip(top).take(bottom - top).collect();
    let padded = Rect {
        x: area.x + 1,
        width: area.width.saturating_sub(2),
        ..area
    };
    frame.render_widget(Paragraph::new(shown), padded);
}

fn entry_lines(entry: &Entry, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let text = entry.data["text"].as_str().unwrap_or_default();
    let mut lines = match entry.kind.as_str() {
        kinds::USER => {
            let who = match &entry.author {
                Actor::Person { name, .. } => name.clone(),
                _ => "input".into(),
            };
            let mut lines = vec![Line::styled(format!("▍{who}"), Theme::glow(theme.magenta))];
            lines.extend(wrap(text, width.saturating_sub(2)).into_iter().map(|row| {
                Line::from(vec![
                    Span::styled("▍ ", Style::new().fg(theme.magenta)),
                    Span::styled(row, Style::new().fg(theme.ink)),
                ])
            }));
            lines
        }
        kinds::ASSISTANT => {
            let tone = if entry.data["is_error"].as_bool() == Some(true) {
                theme.sunset
            } else {
                theme.cyan
            };
            let mut lines = vec![Line::styled("▍nisse", Theme::glow(tone))];
            lines.extend(wrap(text, width.saturating_sub(2)).into_iter().map(|row| {
                Line::from(vec![
                    Span::styled("▍ ", Style::new().fg(tone)),
                    Span::styled(row, Style::new().fg(tone)),
                ])
            }));
            lines
        }
        kinds::TOOL_CALL => {
            let command = entry.data["args"]["command"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| entry.data["args"].to_string());
            vec![Line::from(vec![
                Span::styled(
                    format!("⚡ {} ", entry.data["name"].as_str().unwrap_or("tool")),
                    Theme::glow(theme.violet),
                ),
                Span::styled(command, Style::new().fg(theme.ink)),
            ])]
        }
        kinds::TOOL_RESULT => {
            if let Some(reason) = entry.data["denied"].as_str() {
                vec![Line::styled(
                    format!("  ⊘ denied: {reason}"),
                    Theme::glow(theme.sunset),
                )]
            } else {
                let (mark, style) = if entry.data["is_error"].as_bool() == Some(true) {
                    ("  ✗ ", Style::new().fg(theme.sunset))
                } else {
                    ("  ↳ ", theme.quiet())
                };
                let output = entry.data["output"].as_str().unwrap_or_default().trim_end();
                let rows = wrap(
                    if output.is_empty() {
                        "(no output)"
                    } else {
                        output
                    },
                    width.saturating_sub(4),
                );
                rows.into_iter()
                    .enumerate()
                    .map(|(index, row)| {
                        Line::styled(
                            format!("{}{row}", if index == 0 { mark } else { "    " }),
                            style,
                        )
                    })
                    .collect()
            }
        }
        other => vec![Line::styled(format!("· {other}"), theme.quiet())],
    };
    lines.push(Line::raw(""));
    lines
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
    let mut block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(theme.violet));
    if let Some(error) = &app.error {
        block = block.title(Span::styled(
            format!(" {error} "),
            Theme::glow(theme.sunset),
        ));
    }
    let room = area.width.saturating_sub(6) as usize;
    let typed: String = app
        .input
        .chars()
        .rev()
        .take(room)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let line = Line::from(vec![
        Span::styled("❯ ", Theme::glow(theme.magenta)),
        Span::styled(typed, Style::new().fg(theme.ink)),
        Span::styled("█", Style::new().fg(theme.magenta)),
    ]);
    frame.render_widget(Paragraph::new(line).block(block), area);
}

fn status_bar(app: &App, theme: &Theme) -> Line<'static> {
    let mut spans = match (app.status, app.working_since) {
        (ConversationStatus::Working, Some(since)) => {
            let elapsed = since.elapsed().as_secs();
            vec![
                Span::styled(
                    " ▶ WORKING ",
                    Theme::glow(theme.cyan).add_modifier(Modifier::REVERSED),
                ),
                Span::styled(
                    format!(
                        " {:02}:{:02}:{:02} ",
                        elapsed / 3600,
                        elapsed / 60 % 60,
                        elapsed % 60
                    ),
                    Theme::glow(theme.cyan),
                ),
                Span::styled(spinner(app.frame), Theme::glow(theme.magenta)),
            ]
        }
        (ConversationStatus::NeedsApproval, _) => vec![Span::styled(
            " ⏸ APPROVAL ",
            Theme::glow(theme.sunset).add_modifier(Modifier::REVERSED),
        )],
        (ConversationStatus::Parked, _) => vec![Span::styled(
            " ⏏ PARKED ",
            Theme::glow(theme.sunset).add_modifier(Modifier::REVERSED),
        )],
        _ => vec![Span::styled(
            " ■ WAITING ",
            Theme::glow(theme.magenta).add_modifier(Modifier::REVERSED),
        )],
    };
    for (extension, text) in &app.extension_status {
        spans.push(Span::styled(
            format!("  ◆ {extension}: {text}"),
            Style::new().fg(theme.violet),
        ));
    }
    if let Some((toast, _)) = &app.toast {
        spans.push(Span::styled(
            format!("  ✦ {toast}"),
            Theme::glow(theme.sunset),
        ));
    }
    spans.push(Span::styled(
        format!("   {} · nisse {}", app.model, env!("CARGO_PKG_VERSION")),
        theme.quiet(),
    ));
    Line::from(spans)
}

fn spinner(frame: usize) -> String {
    let lit = frame % 9;
    (0..6)
        .map(|cell| {
            if (lit..lit + 3).contains(&(cell + 2)) {
                '▰'
            } else {
                '▱'
            }
        })
        .collect()
}
