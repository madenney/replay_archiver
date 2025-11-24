import path from 'path'
import { config } from './config.js'

export const stitchStatePath = path.join(config.outputDir, 'stitch_state.json')
export const runLogPath = path.join(config.outputDir, 'run.log')
export const uploadsLogPath = path.join(config.outputDir, 'uploads.json')
