// Copy this file to config.js and edit the paths/values
// for your environment. You can also override values via
// environment variables:
//  OUTPUT_DIR
//  SSBM_ISO_PATH
//  DOLPHIN_PATH
//  QUALITY
//  BITRATE_KBPS
//  NUM_WORKERS

const outputDir =
  process.env.OUTPUT_DIR || '/path/to/output/dir';

const ssbmIsoPath =
  process.env.SSBM_ISO_PATH || '/path/to/ssbm/iso';

const dolphinPath =
  process.env.DOLPHIN_PATH ||
  '/path/to/dolphin/executable';

const quality = Number(
  process.env.QUALITY !== undefined
    ? process.env.QUALITY
    : 6,
);

const bitrateKbps = Number(
  process.env.BITRATE_KBPS !== undefined
    ? process.env.BITRATE_KBPS
    : 15000,
);

const numWorkers = Number(
  process.env.NUM_WORKERS !== undefined
    ? process.env.NUM_WORKERS
    : 2,
);

export { outputDir, ssbmIsoPath, dolphinPath, quality, bitrateKbps, numWorkers };
