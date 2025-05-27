import json
import sys

def calculate_total_frames(json_path):
    try:
        # Read the replays.json file
        with open(json_path, 'r') as f:
            replays = json.load(f)

        # Sum the game_length_frames for all replays
        total_frames = sum(replay['game_length_frames'] for replay in replays if 'game_length_frames' in replay)

        print(f"Total frames across {len(replays)} replays: {total_frames}")
        return total_frames

    except Exception as e:
        print(f"Error in calculate_total_frames: {e}")
        raise e

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 total_frames.py <json_path>")
        sys.exit(1)

    json_path = sys.argv[1]
    total_frames = calculate_total_frames(json_path)