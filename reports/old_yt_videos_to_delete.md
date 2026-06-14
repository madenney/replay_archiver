# Old broken YouTube videos to delete after re-stitches complete

These 22 YouTube videos were uploaded with truncated content (ffmpeg concat aborted on a corrupt source AVI, but stitcher.js had no post-stitch duration check so it shipped the partial MKV anyway). Each will be re-stitched + re-uploaded from `.slp` source via the auto pipeline. After the new versions go live on YouTube, delete the originals listed below.

**One additional note**: `Yy2ZNlYRPjM` (09/16-09/17/2022) is already gone from YouTube (abandoned mid-processing). It's not in the delete list — but its `uploads.json` entry should be removed after its replacement is uploaded.

## Cleanup commands

After the auto-pipeline finishes re-uploading the replacements:

```
# Dry-run — shows what would be deleted
node scripts/delete_old_broken_uploads.js

# Actually delete
node scripts/delete_old_broken_uploads.js --execute
```

The script reads `reports/restitch_log.json` (populated by `restitch_manifest.js`). If the auto-pipeline runs without going through that script, you can derive the old→new videoId mapping by matching manifest basenames in `uploads.json` and pass them in manually, or just delete via YouTube Studio.

## Delete list (22 videos)

### Catastrophic truncations (≥50% missing) — 9 videos

| videoId | Title | YT duration | Expected |
|---|---|---|---|
| dRixauTreFY | Hax Archive: 03/19/2022 - 03/20/2022 | 0:16:24 | 8:00:22 |
| xBDZ2xwfvF0 | Hax Archive: 09/18/2022 - 09/19/2022 | 1:41:06 | 8:01:31 |
| b_xOLz2u2Qo | Hax Archive: 09/19/2022 - 09/20/2022 | 1:46:09 | 8:00:26 |
| mX5VigUOxYU | Hax Archive: 10/07/2022 - 10/08/2022 | 1:35:31 | 8:00:54 |
| 4_G2ODl4cr4 | Hax Archive: 10/11/2022 - 10/13/2022 | 2:30:03 | 8:02:33 |
| 8BRnNBwqP0k | Hax Archive: 11/15/2022 - 12/01/2022 | 2:30:21 | 8:00:25 |
| vXkWv0dd5vo | Hax Archive: 02/22/2023 - 02/24/2023 | 2:04:12 | 8:00:14 |
| _1Z-u9H2QOQ | Hax Archive: 03/21/2023 - 03/23/2023 | 1:03:56 | 8:02:19 |
| 5FXMSTGK5Ks | Hax Archive: 04/26/2023 - 04/27/2023 | 1:30:32 | 8:02:23 |

### Significant truncations (10–50% missing) — 7 videos

| videoId | Title | YT duration | Expected |
|---|---|---|---|
| LUOgSepTGRE | Hax Archive: 03/02/2022 - 03/03/2022 | 4:54:10 | 8:00:01 |
| 3MdOf3mTDKI | Hax Archive: 03/16/2022 - 03/19/2022 | 5:40:03 | 8:02:55 |
| GgI-YGnHpMw | Hax Archive: 09/24/2022 - 09/25/2022 | 6:56:22 | 8:02:00 |
| Kuao3Wnir1M | Hax Archive: 10/28/2022 - 10/29/2022 | 4:56:21 | 8:01:07 |
| rzHke85f1B8 | Hax Archive: 03/20/2023 - 03/21/2023 | 6:53:16 | 8:02:36 |
| pjWN3dF8QeI | Hax Archive: 03/23/2023 - 03/24/2023 | 6:06:15 | 8:01:09 |
| bSh42y8Qs20 | Hax Archive: 04/27/2023 - 04/29/2023 | 6:52:38 | 8:00:05 |

### Minor real truncations (1–6 games dropped) — 6 videos

| videoId | Title | YT duration | Expected | games dropped |
|---|---|---|---|---|
| f6Vhojo4htA | Hax Archive: 08/03/2022 - 08/05/2022 | 7:58:00 | 8:00:09 | 1 |
| O9LsLYcZLt0 | Hax Archive: 08/05/2022 - 08/06/2022 | 7:48:37 | 8:01:21 | 6 |
| 6i2DhBDE-kc | Hax Archive: 08/08/2022 - 08/10/2022 | 7:59:08 | 8:01:30 | 1 |
| 2MCr4abzN9M | Hax Archive: 10/06/2022 - 10/07/2022 | 7:49:50 | 8:02:26 | 2 |
| aKG9gEh1RSg | Hax Archive: 01/09/2023 - 01/10/2023 | 7:56:07 | 8:01:08 | 2 |
| KHBxumrbh2c | Hax Archive: 04/24/2023 - 04/26/2023 | 7:59:34 | 8:01:16 | 1 |

## How to verify before deleting

For any individual video, you can confirm it's the old broken one:

```bash
# Check YT duration via API
node -e "
import('googleapis').then(async ({google}) => {
  await import('dotenv/config');
  const o = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  o.setCredentials({refresh_token: process.env.YOUTUBE_REFRESH_TOKEN});
  const yt = google.youtube({version:'v3',auth:o});
  const r = await yt.videos.list({part:['contentDetails','snippet'],id:['VIDEO_ID_HERE']});
  console.log(JSON.stringify(r.data.items[0],null,2));
});"
```
