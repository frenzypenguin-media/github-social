#!/usr/bin/env python3
"""
render_svg.py — Pure stdlib SVG graph renderer for GitHub Social metrics.

Generates line charts for:
  - visits over time
  - hearts over time
  - new users over time
  - reactions over time

Dark theme matching the GitHub Social UI. No external dependencies.
"""

import argparse
import json
import re
import sys
from pathlib import Path


# GitHub dark theme colors
THEME = {
    "bg": "#0d1117",
    "surface": "#161b22",
    "border": "#30363d",
    "border_muted": "#21262d",
    "fg": "#c9d1d9",
    "muted": "#8b949e",
    "accent": "#58a6ff",
    "accent_emphasis": "#1f6feb",
    "success": "#3fb950",
    "danger": "#f85149",
    "warn": "#d29922",
}

SERIES_COLORS = {
    "visits": "#58a6ff",
    "hearts": "#d23",
    "new_users": "#3fb950",
    "reactions": "#d29922",
    "comments": "#a371f7",
    "issues": "#79c0ff",
}

FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def parse_metrics_input(text):
    """Parse metrics text into a dict of weekly time-series data.

    Accepts:
      - JSON object with 'weekly_visits', 'weekly_hearts', etc. as arrays or numbers
      - Plain markdown with `key: value` lines
    """
    text = (text or "").strip()
    if not text:
        return {}

    # Try JSON first
    if text.startswith("{"):
        try:
            data = json.loads(text)
            return _normalize_metrics(data)
        except json.JSONDecodeError:
            pass

    # Try key:value markdown
    out = {}
    for line in text.splitlines():
        m = re.match(r"\s*[-*]?\s*`?(\w+):\s*([^`\n]+)", line)
        if m:
            key, val = m.group(1).strip(), m.group(2).strip()
            out[key] = val

    return _normalize_metrics(out)


def _normalize_metrics(data):
    """Normalize metric values — accept numbers, lists, or comma-separated strings."""
    out = {}
    for k, v in data.items():
        if isinstance(v, (int, float)):
            out[k] = [int(v)]
        elif isinstance(v, list):
            out[k] = [int(x) for x in v if isinstance(x, (int, float)) or (isinstance(x, str) and x.strip().lstrip("-").isdigit())]
        elif isinstance(v, str):
            # Comma-separated or single number
            parts = [p.strip() for p in re.split(r"[,\s]+", v) if p.strip()]
            nums = []
            for p in parts:
                try:
                    nums.append(int(p))
                except ValueError:
                    pass
            out[k] = nums
    return out


def _synthesize_series(weekly_metrics, weeks=8, *, synthesize=False):
    """Build a per-series time-series array.

    Args:
      weekly_metrics: parsed metric dict from parse_metrics_input()
      weeks:          number of time slots (default 8)
      synthesize:     if True, synthesize fake ramp for missing data;
                     if False (default), use flat zero instead so charts
                     honestly show "no data" rather than misleading uptick.
    """
    series_map = {
        "visits": "weekly_visits",
        "hearts": "weekly_hearts",
        "reactions": "weekly_reactions",
        "new_users": "weekly_new_users",
        "comments": "weekly_comments",
    }

    out = {}
    for name, key in series_map.items():
        vals = weekly_metrics.get(key, [])
        if not vals:
            if synthesize:
                # Synthetic ramp retained for the "demo / first-run" mode when
                # synthesize=True is explicitly requested (e.g. preview tool).
                base = {"visits": 10, "hearts": 2, "reactions": 1, "new_users": 0, "comments": 0}[name]
                vals = [base * i for i in range(1, weeks + 1)]
            else:
                # Honest empty state: flat zero line.
                vals = [0] * weeks
        else:
            # Normalise a single scalar to a list.
            if isinstance(vals, (int, float)):
                vals = [int(vals)]
            elif isinstance(vals, list) and len(vals) == 1:
                vals = [int(vals[0])]
        # Pad to `weeks` length
        while len(vals) < weeks:
            vals.insert(0, 0)
        out[name] = vals[:weeks]
    return out


def build_svg_line_chart(title, data, color, width=600, height=240):
    """Build a line chart SVG for a single series.

    If every value in data is 0, renders an honest "No data yet" state
    instead of a misleading chart.
    """
    if not data:
        data = [0]

    no_data = all(v == 0 for v in data)
    max_val = max(data) or 1
    padding_left = 50
    padding_right = 20
    padding_top = 40
    padding_bottom = 50

    plot_w = width - padding_left - padding_right
    plot_h = height - padding_top - padding_bottom

    n = len(data)
    step = plot_w / max(1, n - 1) if n > 1 else 0

    # Y-axis ticks
    y_ticks = 4
    tick_vals = []
    for i in range(y_ticks + 1):
        v = (max_val * i) / y_ticks
        y = padding_top + plot_h - (plot_h * i / y_ticks)
        tick_vals.append((v, y))

    # Build polyline
    points = []
    for i, v in enumerate(data):
        x = padding_left + (step * i if n > 1 else plot_w / 2)
        y = padding_top + plot_h - (plot_h * v / max_val)
        points.append(f"{x:.1f},{y:.1f}")
    polyline = " ".join(points)

    # Area fill polygon
    area_points = [f"{padding_left},{padding_top + plot_h}"] + points + [f"{padding_left + plot_w},{padding_top + plot_h}"]
    area_polygon = " ".join(area_points)

    # X-axis labels (week numbers)
    x_labels = []
    for i in range(n):
        x = padding_left + (step * i if n > 1 else plot_w / 2)
        x_labels.append(f'<text x="{x:.1f}" y="{height - 20}" fill="{THEME["muted"]}" font-size="11" text-anchor="middle">W{i+1}</text>')

    # Y-axis labels
    y_labels = []
    for v, y in tick_vals:
        y_labels.append(
            f'<text x="{padding_left - 8}" y="{y + 4:.1f}" fill="{THEME["muted"]}" font-size="11" text-anchor="end">{int(v)}</text>'
        )
        y_labels.append(
            f'<line x1="{padding_left}" y1="{y:.1f}" x2="{padding_left + plot_w}" y2="{y:.1f}" stroke="{THEME["border_muted"]}" stroke-width="1"/>'
        )

    # Data point dots
    dots = []
    for i, v in enumerate(data):
        x = padding_left + (step * i if n > 1 else plot_w / 2)
        y = padding_top + plot_h - (plot_h * v / max_val)
        dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}" stroke="{THEME["surface"]}" stroke-width="1.5"/>')

    # Current value annotation (last point)
    last_v = data[-1]
    last_x = padding_left + (step * (n - 1) if n > 1 else plot_w / 2)
    last_y = padding_top + plot_h - (plot_h * last_v / max_val)
    annotation = f'<text x="{last_x:.1f}" y="{last_y - 12:.1f}" fill="{color}" font-size="12" font-weight="600" text-anchor="middle">{int(last_v)}</text>'

    if no_data:
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">
  <style>text {{ font-family: {FONT_FAMILY}; }}</style>
  <rect x="0" y="0" width="{width}" height="{height}" fill="{THEME["surface"]}" rx="8"/>
  <rect x="0.5" y="0.5" width="{width-1}" height="{height-1}" fill="none" stroke="{THEME["border"]}" rx="8"/>
  <text x="{padding_left}" y="24" fill="{THEME["fg"]}" font-size="14" font-weight="600">{title}</text>
  <text x="{width // 2}" y="{height // 2}" fill="{THEME["muted"]}" font-size="13" text-anchor="middle">No data yet</text>
  <text x="{padding_left}" y="{height - 18}" fill="{THEME["border_muted"]}" font-size="11">Last {n} weeks · all values zero</text>
</svg>'''
    else:
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">
  <style>text {{ font-family: {FONT_FAMILY}; }}</style>
  <rect x="0" y="0" width="{width}" height="{height}" fill="{THEME["surface"]}" rx="8"/>
  <rect x="0.5" y="0.5" width="{width-1}" height="{height-1}" fill="none" stroke="{THEME["border"]}" rx="8"/>
  <text x="{padding_left}" y="24" fill="{THEME["fg"]}" font-size="14" font-weight="600">{title}</text>
  <text x="{padding_left}" y="38" fill="{THEME["muted"]}" font-size="11">Last {n} weeks</text>
  {chr(10).join(y_labels)}
  <polygon points="{area_polygon}" fill="{color}" fill-opacity="0.12"/>
  <polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  {chr(10).join(dots)}
  {annotation}
  {chr(10).join(x_labels)}
</svg>'''
    return svg


def render_all(input_text, output_dir):
    """Render all four charts and write them to the output directory."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    metrics = parse_metrics_input(input_text)
    series = _synthesize_series(metrics, weeks=8)

    charts = [
        ("Visits", "visits", SERIES_COLORS["visits"]),
        ("Hearts", "hearts", SERIES_COLORS["hearts"]),
        ("New Users", "new_users", SERIES_COLORS["new_users"]),
        ("Reactions", "reactions", SERIES_COLORS["reactions"]),
    ]

    written = []
    for title, key, color in charts:
        data = series.get(key, [0])
        svg = build_svg_line_chart(title, data, color)
        out_path = output_dir / f"{key.replace('_', '-')}.svg"
        out_path.write_text(svg, encoding="utf-8")
        written.append(str(out_path))

    # Combined dashboard SVG
    combined_svg = build_dashboard_svg(series)
    combined_path = output_dir / "dashboard.svg"
    combined_path.write_text(combined_svg, encoding="utf-8")
    written.append(str(combined_path))

    return written


def build_dashboard_svg(series):
    """Build a combined dashboard SVG with all four series."""
    width = 600
    height = 540

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">']
    parts.append(f'  <style>text {{ font-family: {FONT_FAMILY}; }}</style>')
    parts.append(f'  <rect x="0" y="0" width="{width}" height="{height}" fill="{THEME["bg"]}" rx="8"/>')
    parts.append(f'  <text x="20" y="28" fill="{THEME["fg"]}" font-size="16" font-weight="700">GitHub Social — Weekly Metrics</text>')
    parts.append(f'  <text x="20" y="46" fill="{THEME["muted"]}" font-size="11">Updated weekly · Pure SVG · No JS</text>')

    # Mini sparkline for each series
    panel_y = 60
    for i, (name, key, color) in enumerate([
        ("Visits", "visits", SERIES_COLORS["visits"]),
        ("Hearts", "hearts", SERIES_COLORS["hearts"]),
        ("New Users", "new_users", SERIES_COLORS["new_users"]),
        ("Reactions", "reactions", SERIES_COLORS["reactions"]),
    ]):
        y = panel_y + i * 110
        parts.append(f'  <rect x="20" y="{y}" width="{width - 40}" height="100" fill="{THEME["surface"]}" rx="6" stroke="{THEME["border"]}"/>')
        parts.append(f'  <text x="32" y="{y + 24}" fill="{THEME["fg"]}" font-size="13" font-weight="600">{name}</text>')

        data = series.get(key, [0])
        latest = data[-1] if data else 0
        parts.append(f'  <text x="{width - 32}" y="{y + 24}" fill="{color}" font-size="16" font-weight="700" text-anchor="end">{int(latest)}</text>')

        # Sparkline
        if data and max(data) > 0:
            spark_w = width - 80
            spark_h = 50
            spark_x = 40
            spark_y = y + 35
            max_v = max(data) or 1
            n = len(data)
            step = spark_w / max(1, n - 1) if n > 1 else 0
            pts = []
            for j, v in enumerate(data):
                x = spark_x + (step * j if n > 1 else spark_w / 2)
                yy = spark_y + spark_h - (spark_h * v / max_v)
                pts.append(f"{x:.1f},{yy:.1f}")
            area_pts = [f"{spark_x},{spark_y + spark_h}"] + pts + [f"{spark_x + spark_w},{spark_y + spark_h}"]
            parts.append(f'  <polygon points="{" ".join(area_pts)}" fill="{color}" fill-opacity="0.15"/>')
            parts.append(f'  <polyline points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')

    parts.append('</svg>')
    return "\n".join(parts)


def main():
    p = argparse.ArgumentParser(description="Render GitHub Social metrics SVGs")
    p.add_argument("--input", help="Input text (JSON or markdown with metrics)")
    p.add_argument("--input-file", help="Read input from a file")
    p.add_argument("--output-dir", default="metrics", help="Output directory")
    args = p.parse_args()

    if args.input_file:
        text = Path(args.input_file).read_text(encoding="utf-8")
    elif args.input:
        text = args.input
    else:
        text = sys.stdin.read()

    written = render_all(text, args.output_dir)
    for path in written:
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
