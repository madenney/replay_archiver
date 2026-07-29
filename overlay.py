import sys
import os
import subprocess
import json
from PIL import Image, ImageDraw, ImageFont

# Path to the font file
FONT_PATH = '/path/to/replay_archiver/cour_bold.ttf'
BITRATE_DEFAULT = os.getenv('BITRATE_KBPS', '15000')
# Encoding defaults favor quality-per-bit; CRF is capped by maxrate to avoid huge files.
CRF_DEFAULT = os.getenv('FFMPEG_CRF', '18')
MAXRATE_DEFAULT = os.getenv('FFMPEG_MAXRATE_KBPS')
BUFSIZE_DEFAULT = os.getenv('FFMPEG_BUFSIZE_KBPS')
PRESET_DEFAULT = os.getenv('FFMPEG_PRESET', 'slow')
PROFILE_DEFAULT = os.getenv('FFMPEG_PROFILE', 'high')
USE_NVENC = os.getenv('USE_NVENC', '').strip().lower() in ('1', 'true', 'yes', 'on')


def parse_int(value, fallback=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def parse_crf(value, fallback=None):
    if value is None:
        return fallback
    normalized = str(value).strip().lower()
    if normalized in ('', 'none', 'off'):
        return None
    return parse_int(value, fallback)

def get_video_dimensions(video_path):
    """Get the width and height of the video using ffprobe."""
    print(f"Getting dimensions for video: {video_path}")
    cmd = [
        'ffprobe',
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        video_path
    ]
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, text=True, check=True)
        video_info = json.loads(result.stdout)
        width = video_info['streams'][0]['width']
        height = video_info['streams'][0]['height']
        print(f"Video dimensions: {width}x{height}")
        return width, height
    except subprocess.CalledProcessError as e:
        print(f"Error in ffprobe: {e}", file=sys.stderr)
        print(f"ffprobe stdout: {e.stdout}", file=sys.stderr)
        print(f"ffprobe stderr: {e.stderr}", file=sys.stderr)
        raise
    except Exception as e:
        print(f"Unexpected error in ffprobe: {e}", file=sys.stderr)
        raise

def create_text_overlay(video_path, text, overlay_image_path):
    """Create a transparent PNG overlay with text at the bottom left of the video dimensions."""
    print(f"Creating text overlay with text: '{text}'")
    try:
        # Get video dimensions
        width, height = get_video_dimensions(video_path)
 
        # Create a transparent image matching the video dimensions
        img = Image.new('RGBA', (width, height), (255, 0, 0, 0))
        d = ImageDraw.Draw(img)

        # Define font and size (dynamic based on video height)
        font_size = int(height / 45)
        font = ImageFont.truetype(FONT_PATH, font_size)

        # Calculate text dimensions
        text_width, text_height = textsize(text, font=font)

        # Position text at the bottom left with a small margin
        x, base_y = 7, height - text_height - 5
        text_y = base_y - 1

        # Define the background rectangle for the text (with padding)
        rect_x0 = x - 10
        rect_y0 = base_y - 9
        rect_x1 = x + text_width + 6
        rect_y1 = base_y + text_height + 5

        # Draw a semi-transparent black rounded rectangle behind the text
        d.rounded_rectangle([rect_x0, rect_y0, rect_x1, rect_y1], fill="#202020", radius=2)

        # Add the text over the rectangle
        d.text((x, text_y), text, font=font, fill=(255, 255, 255, 255))

        # Save the overlay image to the specified path
        img.save(overlay_image_path)
        print(f"Saved overlay image to: {overlay_image_path}")
        img.close()  # Explicitly close the image
        return overlay_image_path
    except Exception as e:
        print(f"Error in create_text_overlay: {e}", file=sys.stderr)
        raise

def overlay_text_on_video(video_path, overlay_image_path, output_video_path):
    """Overlay the PNG image onto the video using FFmpeg."""
    print(f"Overlaying image {overlay_image_path} onto video {video_path}")
    bitrate_kbps = parse_int(BITRATE_DEFAULT, 15000)
    crf = parse_crf(CRF_DEFAULT, 18)
    maxrate_kbps = parse_int(MAXRATE_DEFAULT, bitrate_kbps)
    bufsize_kbps = parse_int(BUFSIZE_DEFAULT, maxrate_kbps * 2 if maxrate_kbps else None)
    preset = PRESET_DEFAULT
    profile = PROFILE_DEFAULT
    cmd = [
        'ffmpeg',
        '-y',
        '-i', video_path,
        '-i', overlay_image_path,
        # Ensure overlay matches source, then pad to even dimensions (yuv420p requirement)
        '-filter_complex', '[0:v][1:v]scale2ref[vid][ovr];[vid][ovr]overlay=format=auto:0:0,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0',
    ]
    if USE_NVENC:
        cmd.extend([
            '-c:v', 'hevc_nvenc',
            '-preset', 'p7',
            '-rc', 'vbr',
            '-pix_fmt', 'yuv420p',
        ])
        quality_flag = '-cq'
    else:
        cmd.extend([
            '-c:v', 'libx264',
            '-preset', preset,
            '-profile:v', profile,
            '-pix_fmt', 'yuv420p',
        ])
        quality_flag = '-crf'
    if crf is not None:
        cmd.extend([quality_flag, str(crf)])
        if maxrate_kbps:
            cmd.extend(['-maxrate', f'{maxrate_kbps}k'])
        if bufsize_kbps:
            cmd.extend(['-bufsize', f'{bufsize_kbps}k'])
    else:
        cmd.extend([
            '-b:v', f'{bitrate_kbps}k',
            '-maxrate', f'{bitrate_kbps}k',
            '-bufsize', f'{bitrate_kbps * 2}k',
        ])
    cmd.extend([
        '-codec:a', 'copy',
        output_video_path
    ])
    print(f"Executing FFmpeg command: {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True
        )
        print(f"FFmpeg stdout: {result.stdout}")
        if result.stderr:
            print(f"FFmpeg stderr: {result.stderr}")
        print(f"FFmpeg completed successfully, output saved to: {output_video_path}")
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg failed with exit code {e.returncode}", file=sys.stderr)
        print(f"FFmpeg stdout: {e.stdout}", file=sys.stderr)
        print(f"FFmpeg stderr: {e.stderr}", file=sys.stderr)
        raise
    except Exception as e:
        print(f"Unexpected error in FFmpeg: {e}", file=sys.stderr)
        raise

def textsize(text, font):
    """Calculate the width and height of the text using PIL."""
    try:
        im = Image.new(mode="P", size=(0, 0))
        draw = ImageDraw.Draw(im)
        _, _, width, height = draw.textbbox((0, 0), text=text, font=font)
        im.close()  # Explicitly close the image
        return width, height
    except Exception as e:
        print(f"Error in textsize: {e}", file=sys.stderr)
        raise

if __name__ == "__main__":
    try:
        if len(sys.argv) != 5:
            print("Usage: python overlay.py <video_file_path> <video_output_path> <overlay_text> <overlay_image_path>", file=sys.stderr)
            sys.exit(1)

        print("Starting overlay.py")
        print("Processing video:", sys.argv[1])

        video_file_path = sys.argv[1]
        video_output_path = sys.argv[2]
        overlay_text = sys.argv[3]
        overlay_image_path = sys.argv[4]

        # Generate overlay
        create_text_overlay(video_file_path, overlay_text, overlay_image_path)

        # Overlay text onto the video
        overlay_text_on_video(video_file_path, overlay_image_path, video_output_path)

        print("overlay.py completed successfully")
        sys.exit(0)
    except Exception as e:
        print(f"Error in overlay.py: {e}", file=sys.stderr)
        sys.exit(1)
