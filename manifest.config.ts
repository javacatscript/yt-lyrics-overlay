import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string;
};

/**
 * Paths point at source files; vite-plugin-web-extension rewrites them to the
 * built output.
 *
 * Permissions are deliberately minimal. Notably absent:
 *  - `tabs`: the content script announces itself, and `chrome.tabs.sendMessage`
 *    needs no permission, so there is never a reason to enumerate tabs.
 *  - `scripting`: the static content_scripts declaration is enough.
 *  - `web_accessible_resources`: overlay CSS is bundled into the content
 *    script as a string and applied through a shadow root.
 */
export default {
  manifest_version: 3,
  name: 'Lyrics Overlay',
  version,
  description:
    'Real-time synced lyrics for YouTube Music in a window that floats above every tab.',

  permissions: ['storage', 'sidePanel'],
  host_permissions: ['https://lrclib.net/*', 'https://api.lyrics.ovh/*'],

  background: {
    service_worker: 'src/background/sw.ts',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['https://music.youtube.com/*'],
      js: ['src/content/ytm.ts'],
      run_at: 'document_idle',
    },
    {
      // Regular YouTube. Detection is heuristic here — see normalizeTitle.ts —
      // and deliberately gives up rather than guessing on non-music videos.
      matches: ['https://www.youtube.com/*', 'https://youtube.com/*'],
      js: ['src/content/yt.ts'],
      run_at: 'document_idle',
    },
  ],

  side_panel: {
    default_path: 'src/sidepanel/panel.html',
  },

  action: {
    default_title: 'Lyrics Overlay',
  },
};
