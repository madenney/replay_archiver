import json
import math
import os
import sys
from datetime import datetime
from typing import Dict, List, Optional, Tuple

LEAD_IN_FRAMES = 123
MANIFEST_SUFFIX = ".manifest.json"
TIMESTAMP_BUFFER_SECONDS = 0.5


def load_env_value(key: str, env_path: str = ".env") -> Optional[str]:
    value = os.getenv(key)
    if value:
        return value
    try:
        with open(env_path, "r") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue
                env_key, env_value = line.split("=", 1)
                if env_key.strip() != key:
                    continue
                cleaned = env_value.strip()
                if (
                    (cleaned.startswith('"') and cleaned.endswith('"'))
                    or (cleaned.startswith("'") and cleaned.endswith("'"))
                ):
                    cleaned = cleaned[1:-1]
                return cleaned
    except FileNotFoundError:
        return None
    return None


def format_youtube_timestamp(total_seconds: float) -> str:
    safe_seconds = max(0, int(math.ceil((total_seconds or 0) + TIMESTAMP_BUFFER_SECONDS)))
    hours = safe_seconds // 3600
    minutes = (safe_seconds % 3600) // 60
    seconds = safe_seconds % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def resolve_video_duration_seconds(game: dict) -> Optional[float]:
    if isinstance(game.get("video_duration_seconds"), (int, float)):
        return float(game["video_duration_seconds"])
    if isinstance(game.get("videoDurationSeconds"), (int, float)):
        return float(game["videoDurationSeconds"])
    return None


def resolve_game_duration_seconds(game: dict) -> Tuple[float, bool]:
    duration = resolve_video_duration_seconds(game)
    if duration is not None:
        return duration, False
    frames = game.get("game_length_frames")
    if isinstance(frames, (int, float)) and math.isfinite(frames):
        return (frames + LEAD_IN_FRAMES) / 60.0, True
    return 0.0, True


def parse_date_timestamp(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        pass
    for fmt in ("%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, fmt).timestamp()
        except ValueError:
            continue
    return None


def get_manifest_sort_key(manifest: dict) -> Tuple[int, float]:
    dates: List[float] = []
    games = manifest.get("games") if isinstance(manifest.get("games"), list) else []
    for game in games:
        if not isinstance(game, dict):
            continue
        ts = parse_date_timestamp(game.get("date"))
        if ts is not None:
            dates.append(ts)
    if dates:
        return 0, min(dates)
    for key in ("startDate", "endDate"):
        ts = parse_date_timestamp(manifest.get(key))
        if ts is not None:
            return 0, ts
    return 1, 0.0


def format_date_only(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%m/%d/%Y")


def format_date_only_from_value(value: Optional[str]) -> str:
    if value is None:
        return ""
    ts = parse_date_timestamp(value)
    if ts is not None:
        return format_date_only(ts)
    text = str(value).strip()
    if not text:
        return ""
    if " " in text:
        return text.split(" ")[0]
    if "T" in text:
        return text.split("T")[0]
    return text


def get_manifest_date_range_text(manifest: dict) -> str:
    start = manifest.get("startDate")
    end = manifest.get("endDate")
    start_text = format_date_only_from_value(start) if start else ""
    end_text = format_date_only_from_value(end) if end else ""
    if start_text and end_text:
        return start_text if start_text == end_text else f"{start_text} - {end_text}"
    if start_text:
        return start_text
    if end_text:
        return end_text

    dates: List[float] = []
    games = manifest.get("games") if isinstance(manifest.get("games"), list) else []
    for game in games:
        if not isinstance(game, dict):
            continue
        ts = parse_date_timestamp(game.get("date"))
        if ts is not None:
            dates.append(ts)
    if not dates:
        return ""
    start_text = format_date_only(min(dates))
    end_text = format_date_only(max(dates))
    return start_text if start_text == end_text else f"{start_text} - {end_text}"


def is_hax_player(tag: Optional[str], code: Optional[str]) -> bool:
    code_value = str(code or "")
    if code_value in ("XX#02", "HAX#472"):
        return True
    tag_value = str(tag or "").lower()
    return "hax" in tag_value or "b0xx" in tag_value


def get_non_hax_player(game: dict) -> Optional[dict]:
    players = game.get("players") if isinstance(game.get("players"), list) else []
    codes = game.get("codes") if isinstance(game.get("codes"), list) else []
    total = max(len(players), len(codes))
    if total == 0:
        return None
    entries = []
    for idx in range(total):
        tag = players[idx] if idx < len(players) else ""
        code = codes[idx] if idx < len(codes) else ""
        entries.append({"tag": tag, "code": code})

    hax_indices = [idx for idx, entry in enumerate(entries) if is_hax_player(entry["tag"], entry["code"])]
    if len(hax_indices) == 1:
        for idx, entry in enumerate(entries):
            if idx != hax_indices[0]:
                return entry
    for entry in entries:
        if not is_hax_player(entry["tag"], entry["code"]):
            return entry
    return entries[0]


def format_player_label(entry: Optional[dict]) -> str:
    if not entry:
        return "Unknown"
    tag = str(entry.get("tag") or "").strip()
    code = str(entry.get("code") or "").strip()
    if tag and code:
        return f"{tag} ({code})"
    if tag:
        return tag
    if code:
        return code
    return "Unknown"


def get_base_name_from_path(file_path: Optional[str]) -> Optional[str]:
    if not file_path:
        return None
    base = os.path.basename(file_path)
    name, _ = os.path.splitext(base)
    return name or None


def get_manifest_base_name(manifest: dict, manifest_path: str) -> Optional[str]:
    return get_base_name_from_path(manifest.get("stitchedPath")) or get_base_name_from_path(
        manifest_path
    )


def collect_manifests(final_dir: str) -> List[str]:
    entries = []
    for name in os.listdir(final_dir):
        if name.endswith(MANIFEST_SUFFIX):
            entries.append(os.path.join(final_dir, name))
    return sorted(entries)


def load_uploads_index(uploads_path: str) -> Tuple[Dict[str, str], Dict[str, str]]:
    try:
        with open(uploads_path, "r") as handle:
            entries = json.load(handle)
    except FileNotFoundError:
        return {}, {}
    if not isinstance(entries, list):
        return {}, {}
    by_base_name: Dict[str, str] = {}
    by_title: Dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("videoId")
        if not video_id:
            continue
        base_name = get_base_name_from_path(entry.get("stitchedPath"))
        if base_name and base_name not in by_base_name:
            by_base_name[base_name] = video_id
        title = entry.get("title")
        if title and title not in by_title:
            by_title[title] = video_id
    return by_base_name, by_title


def escape_reportlab(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main() -> None:
    args = set(sys.argv[1:])
    markdown_only = "--md-only" in args
    pdf_only = "--pdf-only" in args
    if markdown_only and pdf_only:
        raise SystemExit("Use at most one of --md-only or --pdf-only.")

    output_dir = load_env_value("OUTPUT_DIR")
    if not output_dir:
        raise RuntimeError("Missing OUTPUT_DIR in environment or .env file.")

    final_dir = os.path.join(output_dir, "final")
    uploads_path = os.path.join(output_dir, "uploads.json")
    by_base_name, by_title = load_uploads_index(uploads_path)

    if not os.path.isdir(final_dir):
        print(f"No final directory found at {final_dir}")
        return

    manifests = collect_manifests(final_dir)
    if not manifests:
        print(f"No manifest files found in {final_dir}")
        return

    manifest_entries = []
    skipped = 0
    for manifest_path in manifests:
        try:
            with open(manifest_path, "r") as handle:
                manifest = json.load(handle)
        except Exception as err:  # pylint: disable=broad-except
            print(f"Skipping {manifest_path}: {err}")
            skipped += 1
            continue
        missing_flag, sort_ts = get_manifest_sort_key(manifest)
        manifest_entries.append(
            {
                "path": manifest_path,
                "manifest": manifest,
                "sort_missing": missing_flag,
                "sort_ts": sort_ts,
            }
        )

    if not manifest_entries:
        print(f"No readable manifest files found in {final_dir}")
        return

    manifest_entries.sort(
        key=lambda entry: (entry["sort_missing"], entry["sort_ts"], entry["path"])
    )

    tmp_dir = os.path.abspath("tmp")
    markdown_path = os.path.join(tmp_dir, "index.md")
    pdf_path = os.path.abspath("index.pdf")

    should_write_markdown = not pdf_only
    should_write_pdf = not markdown_only

    if should_write_markdown:
        os.makedirs(tmp_dir, exist_ok=True)

    story = None
    styles = None
    Paragraph = None
    Spacer = None
    SimpleDocTemplate = None
    Table = None
    TableStyle = None
    header_style = None
    row_text_style = None
    time_link_style = None
    table_style = None
    table_col_widths = None
    if should_write_pdf:
        try:
            from reportlab.lib.pagesizes import letter
            from reportlab.lib import colors
            from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
            from reportlab.platypus import SimpleDocTemplate as RLDoc
            from reportlab.platypus import Paragraph as RLParagraph
            from reportlab.platypus import Spacer as RLSpacer
            from reportlab.platypus import Table as RLTable
            from reportlab.platypus import TableStyle as RLTableStyle

            SimpleDocTemplate = RLDoc
            Paragraph = RLParagraph
            Spacer = RLSpacer
            Table = RLTable
            TableStyle = RLTableStyle
            styles = getSampleStyleSheet()
            story = []
            story.append(Paragraph("Hax Archive Index", styles["Title"]))
            story.append(Spacer(1, 12))
            pdf_doc = SimpleDocTemplate(pdf_path, pagesize=letter)
            header_style = ParagraphStyle(
                "TableHeader",
                parent=styles["BodyText"],
                textColor=colors.HexColor("#111111"),
                fontName="Helvetica-Bold",
            )
            row_text_style = ParagraphStyle(
                "RowText",
                parent=styles["BodyText"],
                textColor=colors.HexColor("#222222"),
            )
            time_link_style = ParagraphStyle(
                "TimeLink",
                parent=styles["BodyText"],
                textColor=colors.HexColor("#1a73e8"),
                underline=True,
            )
            table_style = TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f5f5f5")),
                    ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#d0d0d0")),
                    ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#e0e0e0")),
                    ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#d0d0d0")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
            table_col_widths = [
                70,
                max(140, pdf_doc.width - 190),
                120,
            ]
        except ImportError as err:
            raise RuntimeError(
                "reportlab is required for PDF output. Install with: pip install reportlab"
            ) from err
    else:
        pdf_doc = None

    markdown_lines: List[str] = []
    if should_write_markdown:
        markdown_lines.append("# Hax Archive Index")
        markdown_lines.append("")

    total_missing = 0

    for idx, entry in enumerate(manifest_entries, start=1):
        manifest_path = entry["path"]
        manifest = entry["manifest"]

        base_name = get_manifest_base_name(manifest, manifest_path)
        video_id = (
            manifest.get("videoId")
            or (base_name and by_base_name.get(base_name))
            or (manifest.get("title") and by_title.get(manifest.get("title")))
        )
        video_url = f"https://youtu.be/{video_id}" if video_id else None
        date_range = get_manifest_date_range_text(manifest)
        heading = date_range if date_range else "Unknown date"

        if should_write_markdown:
            markdown_lines.append(f"## {heading}")
            markdown_lines.append(
                f"Video link: [{video_url}]({video_url})"
                if video_url
                else "Video link: (missing videoId)"
            )
            markdown_lines.append("")

        if should_write_pdf and story and styles and Paragraph and Spacer:
            story.append(Paragraph(escape_reportlab(str(heading)), styles["Heading2"]))
            if video_url:
                link_markup = (
                    "Video link: "
                    f"<font color=\"#1a73e8\"><link href=\"{video_url}\">"
                    f"{escape_reportlab(video_url)}</link></font>"
                )
                story.append(Paragraph(link_markup, row_text_style or styles["BodyText"]))
            else:
                story.append(Paragraph("Video link: (missing videoId)", row_text_style or styles["BodyText"]))
            story.append(Spacer(1, 8))

        games = manifest.get("games") if isinstance(manifest.get("games"), list) else []
        indices = manifest.get("indices") if isinstance(manifest.get("indices"), list) else []
        if not indices:
            indices = [game.get("index") for game in games if isinstance(game, dict)]

        durations_seconds: List[float] = []
        missing_in_manifest = 0
        for game in games:
            if not isinstance(game, dict):
                durations_seconds.append(0.0)
                missing_in_manifest += 1
                continue
            duration, missing = resolve_game_duration_seconds(game)
            if missing and resolve_video_duration_seconds(game) is None:
                missing_in_manifest += 1
            durations_seconds.append(duration)

        if missing_in_manifest:
            total_missing += missing_in_manifest
            print(
                f"{os.path.basename(manifest_path)}: missing durations={missing_in_manifest}/{len(games)}"
            )

        if should_write_markdown:
            markdown_lines.append("| Game | Opponent | Video Timestamp |")
            markdown_lines.append("| --- | --- | --- |")

        table_data = None
        if should_write_pdf and story and Table and Paragraph and header_style and table_style:
            table_data = [
                [
                    Paragraph("Game", header_style),
                    Paragraph("Opponent", header_style),
                    Paragraph("Video Timestamp", header_style),
                ]
            ]

        elapsed_seconds = 0.0
        for game_index, duration in enumerate(durations_seconds):
            game = games[game_index] if game_index < len(games) else {}
            if not isinstance(game, dict):
                game = {}
            player_label = format_player_label(get_non_hax_player(game))
            label = indices[game_index] if game_index < len(indices) else game_index + 1
            label_text = label if isinstance(label, (int, float, str)) and str(label).strip() else game_index + 1
            timestamp_seconds = max(
                0, int(math.ceil((elapsed_seconds or 0) + TIMESTAMP_BUFFER_SECONDS))
            )
            formatted_timestamp = format_youtube_timestamp(elapsed_seconds)
            if video_url:
                link = f"{video_url}?t={timestamp_seconds}"
                if should_write_markdown:
                    md_time = f"[{formatted_timestamp}]({link})"
                    markdown_lines.append(f"| {label_text} | {player_label} | {md_time} |")
                if table_data is not None and Paragraph and row_text_style and time_link_style:
                    table_data.append(
                        [
                            Paragraph(escape_reportlab(str(label_text)), row_text_style),
                            Paragraph(escape_reportlab(player_label), row_text_style),
                            Paragraph(
                                f"<link href=\"{link}\">{escape_reportlab(formatted_timestamp)}</link>",
                                time_link_style,
                            ),
                        ]
                    )
            else:
                if should_write_markdown:
                    markdown_lines.append(
                        f"| {label_text} | {player_label} | {formatted_timestamp} |"
                    )
                if table_data is not None and Paragraph and row_text_style:
                    table_data.append(
                        [
                            Paragraph(escape_reportlab(str(label_text)), row_text_style),
                            Paragraph(escape_reportlab(player_label), row_text_style),
                            Paragraph(escape_reportlab(formatted_timestamp), row_text_style),
                        ]
                    )

            elapsed_seconds += duration

        if should_write_pdf and story and Table and table_data and table_style and table_col_widths:
            table = Table(table_data, colWidths=table_col_widths)
            table.setStyle(table_style)
            story.append(table)
        if should_write_markdown:
            markdown_lines.append("")
        if should_write_pdf and story and Spacer:
            story.append(Spacer(1, 12))

        print(f"Processed {idx}/{len(manifest_entries)}: {manifest_path}")

    if should_write_markdown:
        with open(markdown_path, "w") as handle:
            handle.write("\n".join(markdown_lines).strip() + "\n")
        print(f"Wrote {markdown_path}")

    if should_write_pdf and story and pdf_doc:
        pdf_doc.build(story)
        print(f"Wrote {pdf_path}")

    if total_missing:
        print(f"Done with missing durations in {total_missing} games.")
    if skipped:
        print(f"Skipped {skipped} unreadable manifest(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # pylint: disable=broad-except
        print(err)
        sys.exit(1)
