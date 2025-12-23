import sys

TOTAL_HOURS = 5200
SECONDS_PER_BLOCK = 10
UPLOAD_MEGABITS_PER_SECOND = 10


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 calc_video_size.py <mb_per_10_seconds>")
        sys.exit(1)

    try:
        mb_per_10_seconds = float(sys.argv[1])
    except ValueError:
        print("Error: mb_per_10_seconds must be a number.")
        sys.exit(1)
    if mb_per_10_seconds <= 0:
        print("Error: mb_per_10_seconds must be greater than 0.")
        sys.exit(1)

    total_seconds = TOTAL_HOURS * 60 * 60
    blocks = total_seconds / SECONDS_PER_BLOCK
    total_mb = mb_per_10_seconds * blocks
    total_gb = total_mb / 1024
    total_tb = total_gb / 1024

    total_megabits = total_mb * 8
    upload_seconds = total_megabits / UPLOAD_MEGABITS_PER_SECOND
    upload_hours = upload_seconds / 3600
    upload_days = upload_hours / 24

    print(f"{total_mb:.2f} MB ({total_gb:.2f} GB, {total_tb:.2f} TB)")
    print(
        f"Estimated upload time at {UPLOAD_MEGABITS_PER_SECOND} Mbps: "
        f"{upload_seconds:.0f} seconds ({upload_hours:.2f} hours, {upload_days:.2f} days)"
    )


if __name__ == "__main__":
    main()
