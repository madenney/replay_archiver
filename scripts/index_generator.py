import json
import math
import os
import sys
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
    if should_write_pdf:
        try:
            from reportlab.lib.pagesizes import letter
            from reportlab.lib.styles import getSampleStyleSheet
            from reportlab.platypus import SimpleDocTemplate as RLDoc
            from reportlab.platypus import Paragraph as RLParagraph
            from reportlab.platypus import Spacer as RLSpacer

            SimpleDocTemplate = RLDoc
            Paragraph = RLParagraph
            Spacer = RLSpacer
            styles = getSampleStyleSheet()
            story = []
            story.append(Paragraph("Replay Index", styles["Title"]))
            story.append(Spacer(1, 12))
            pdf_doc = SimpleDocTemplate(pdf_path, pagesize=letter)
        except ImportError as err:
            raise RuntimeError(
                "reportlab is required for PDF output. Install with: pip install reportlab"
            ) from err
    else:
        pdf_doc = None

    markdown_lines: List[str] = []
    if should_write_markdown:
        markdown_lines.append("# Replay Index")
        markdown_lines.append("")

    skipped = 0
    total_missing = 0

    for idx, manifest_path in enumerate(manifests, start=1):
        try:
            with open(manifest_path, "r") as handle:
                manifest = json.load(handle)
        except Exception as err:  # pylint: disable=broad-except
            print(f"Skipping {manifest_path}: {err}")
            skipped += 1
            continue

        base_name = get_manifest_base_name(manifest, manifest_path)
        video_id = (
            manifest.get("videoId")
            or (base_name and by_base_name.get(base_name))
            or (manifest.get("title") and by_title.get(manifest.get("title")))
        )
        video_url = f"https://youtu.be/{video_id}" if video_id else None
        heading = manifest.get("title") or base_name or os.path.basename(manifest_path)

        if should_write_markdown:
            markdown_lines.append(f"## {heading}")
            markdown_lines.append(f"Video: {video_url}" if video_url else "Video: (missing videoId)")
            markdown_lines.append("")

        if should_write_pdf and story and styles and Paragraph and Spacer:
            story.append(Paragraph(escape_reportlab(str(heading)), styles["Heading2"]))
            if video_url:
                story.append(
                    Paragraph(
                        f"Video: <link href=\"{video_url}\">{escape_reportlab(video_url)}</link>",
                        styles["BodyText"],
                    )
                )
            else:
                story.append(Paragraph("Video: (missing videoId)", styles["BodyText"]))
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

        elapsed_seconds = 0.0
        for game_index, duration in enumerate(durations_seconds):
            label = indices[game_index] if game_index < len(indices) else game_index + 1
            label_text = label if isinstance(label, (int, float, str)) and str(label).strip() else game_index + 1
            timestamp_seconds = max(
                0, int(math.ceil((elapsed_seconds or 0) + TIMESTAMP_BUFFER_SECONDS))
            )
            formatted_timestamp = format_youtube_timestamp(elapsed_seconds)
            if video_url:
                link = f"{video_url}?t={timestamp_seconds}"
                line = f"- {label_text}: [{formatted_timestamp}]({link})"
                pdf_line = (
                    f"- {escape_reportlab(str(label_text))}: "
                    f"<link href=\"{link}\">{formatted_timestamp}</link>"
                )
            else:
                line = f"- {label_text}: {formatted_timestamp}"
                pdf_line = f"- {escape_reportlab(str(label_text))}: {formatted_timestamp}"

            if should_write_markdown:
                markdown_lines.append(line)
            if should_write_pdf and story and Paragraph and styles:
                story.append(Paragraph(pdf_line, styles["BodyText"]))

            elapsed_seconds += duration

        if should_write_markdown:
            markdown_lines.append("")
        if should_write_pdf and story and Spacer:
            story.append(Spacer(1, 12))

        print(f"Processed {idx}/{len(manifests)}: {manifest_path}")

    if should_write_markdown:
        with open(markdown_path, "w") as handle:
            handle.write("\n".join(markdown_lines).strip() + "\n")
        print(f"Wrote {markdown_path}")

    if should_write_pdf and story and pdf_doc:
        pdf_doc.build(story)
        print(f"Wrote {pdf_path}")

    if total_missing:
        print(f"Done with missing durations in {total_missing} games.")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # pylint: disable=broad-except
        print(err)
        sys.exit(1)
