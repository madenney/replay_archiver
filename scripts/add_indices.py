import json
import sys

def add_index_to_replays(json_path):
    try:
        # Read the replays.json file
        with open(json_path, 'r') as f:
            replays = json.load(f)

        # Add an incrementing index to each replay
        for i, replay in enumerate(replays):
            replay['index'] = i

        # Write the updated replays back to the JSON file
        with open(json_path, 'w') as f:
            json.dump(replays, f, indent=2)
        print(f"Added index to {len(replays)} replays in {json_path}")

        return replays

    except Exception as e:
        print(f"Error in add_index_to_replays: {e}")
        raise e

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 add_index_to_replays.py <json_path>")
        sys.exit(1)

    json_path = sys.argv[1]
    updated_replays = add_index_to_replays(json_path)
    print("Updated Replays:", json.dumps(updated_replays, indent=2))