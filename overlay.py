import sys
import os
import subprocess
import json
from PIL import Image, ImageDraw, ImageFont

# Path to the font file
FONT_PATH = '/home/matt/Projects/video_tools/assets/cour_bold.ttf'

def get_video_dimensions(video_path):
    """Get the width and height of the video using ffprobe."""
    cmd = [
        'ffprobe',
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        video_path
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
    video_info = json.loads(result.stdout)
    width = video_info['streams'][0]['width']
    height = video_info['streams'][0]['height']
    return width, height

def create_text_overlay(video_path, text, overlay_image_path):
    """Create a transparent PNG overlay with text at the bottom left of the video dimensions."""
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
    x, y = 7, height - text_height - 5

    # Define the background rectangle for the text (with padding)
    rect_x0 = x - 10
    rect_y0 = y - 12
    rect_x1 = x + text_width + 6
    rect_y1 = y + text_height + 5

    # Draw a semi-transparent black rounded rectangle behind the text
    d.rounded_rectangle([rect_x0, rect_y0, rect_x1, rect_y1], fill="#202020", radius=2)

    # Add the text over the rectangle
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    # Save the overlay image to the specified path
    img.save(overlay_image_path)
    return overlay_image_path

def overlay_text_on_video(video_path, overlay_image_path, output_video_path):
    """Overlay the PNG image onto the video using FFmpeg."""
    cmd = (
        f"ffmpeg -i '{video_path}' -i {overlay_image_path} "
        f"-filter_complex "
        f"\"[0:v][1:v]scale2ref[vid][ovr];[vid][ovr]overlay=format=auto:0:0\" "
        f"-codec:a copy '{output_video_path}'"
    )

    print("Executing command:", cmd)
    os.system(cmd)

def textsize(text, font):
    """Calculate the width and height of the text using PIL."""
    im = Image.new(mode="P", size=(0, 0))
    draw = ImageDraw.Draw(im)
    _, _, width, height = draw.textbbox((0, 0), text=text, font=font)
    return width, height

if __name__ == "__main__":
    if len(sys.argv) != 5:
        print("Usage: python overlay.py <video_file_path> <video_output_path> <overlay_text> <overlay_image_path>")
        sys.exit(1)

    print("Processing video:", sys.argv[1])

    video_file_path = sys.argv[1]
    video_output_path = sys.argv[2]
    overlay_text = sys.argv[3]
    overlay_image_path = sys.argv[4]

    # Generate overlay
    create_text_overlay(video_file_path, overlay_text, overlay_image_path)

    # Overlay text onto the video
    overlay_text_on_video(video_file_path, overlay_image_path, video_output_path)

    sys.exit(0)