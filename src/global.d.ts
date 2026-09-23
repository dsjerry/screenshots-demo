import type { ScreenshotsApi } from './shared/api';

declare global {
  interface Window {
    api: ScreenshotsApi;
  }
}

export {};
