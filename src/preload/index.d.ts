import type { ElectronAPI } from '@electron-toolkit/preload'
import type { OpenClipBridge } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    /** The frozen OpenClip bridge surface (derived from ChannelMap + JobsAPI). */
    openclip: OpenClipBridge
  }
}

export {}
