import json
import sys
from datetime import datetime, timezone

def sort_replays_by_date(input_path, output_path):
    try:
        # Read the replays.json file
        with open(input_path, 'r') as f:
            replays = json.load(f)

        print(f"Loaded {len(replays)} replays from {input_path}")

        # Sort replays by date in ascending order
        def parse_date(date_str):
            if date_str == "Unknown":
                return datetime.max.replace(tzinfo=timezone.utc)
            try:
                # Parse the date string, handling both offset-aware and offset-naive cases
                dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
                # Ensure the datetime is offset-aware (add UTC timezone if naive)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError as e:
                print(f"Error parsing date {date_str}: {e}")
                return datetime.max.replace(tzinfo=timezone.utc)

        replays.sort(key=lambda x: parse_date(x['date']))

        # Reassign index fields sequentially starting from 0
        for i, replay in enumerate(replays):
            replay['index'] = i

        # Write the updated replays to the output file
        with open(output_path, 'w') as f:
            json.dump(replays, f, indent=2)
        print(f"Sorted replays by date and saved to {output_path} with updated indices")

        return replays

    except Exception as e:
        print(f"Error in sort_replays_by_date: {e}")
        raise e

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 sort_replays.py <input_json_path> <output_json_path>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    sorted_replays = sort_replays_by_date(input_path, output_path)
    print("First few sorted replays:", json.dumps(sorted_replays[:5], indent=2))