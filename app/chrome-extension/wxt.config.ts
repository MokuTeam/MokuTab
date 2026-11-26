import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

// Public RSA key (NOT a secret — Chrome publishes the `key` field in every installed
// manifest). Pinning it makes the unpacked-extension ID deterministic across machines,
// so everyone who builds this repo gets the same extension ID and the bridge's
// native-messaging `allowed_origins` whitelist works out of the box.
// Derived ID: bpjpdgkeelhkijkllcmogemkmndgeana
const DEFAULT_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6GcfzFpYKGf9KZNpdXCWXSK3JpsXE5kBnT0tGRrkXYYclQA3iIHbQtu6e7L8Hh8uDelB6+T64IIKU4lxMsruChCTshgdS51F6OT3+KNDGijeliZifV5nV6JR0h2X9qyMlvC+N727FziYjqbEIn+8o9skR8wP/1qsZbknB6nz2nZxhMtyqMOmI+fFw9dIsTcxEpz/0U15oMAeV8MpKgUHELij/obv90kC80E+5o1W+SMqzno5Aa5msBdq/57mQoTwmVyQ/fiRTHltAfC/NtN7uWtIz1HD8Ra52sjJN2JR19eAyZPg7bnfi1SfifnpVNylgTT53D0ANtcxpJlsjqyIYwIDAQAB';
const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY ?? DEFAULT_EXTENSION_KEY;
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';

// One stamp per build: baked into the bundle as __BUILD_TIME__ and written to
// build-info.json. The extension compares the two to tell a stale running build
// from the dist/ on disk (chrome_reload_extension).
const BUILD_TIME = new Date().toISOString();

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // Build into dist/ instead of WXT's default .output/ — dot-folders are hidden
  // in macOS Finder, which made "Load unpacked" painful for Mac users.
  outDir: 'dist',
  runner: {
    disabled: true,

    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: CHROME_EXTENSION_KEY,
    default_locale: 'en',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'activeTab',
      'scripting',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'history',
      'bookmarks',
      'offscreen',
      'storage',
      // NetSuite module: the session store reads and sets one account host's
      // cookies (httpOnly included) without a tab or the debugger banner.
      'cookies',
      // chrome_watch_start readings without the debugger banner (needs the
      // per-extension "Allow User Scripts" toggle; falls back to CDP without it)
      'userScripts',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_popup: 'popup.html',
      default_title: 'MokuTab',
    },
    web_accessible_resources: [
      {
        resources: ['/inject-scripts/*'],
        matches: ['<all_urls>'],
      },
    ],
    // CSP is production-only: dev server assets are blocked by strict CSP in dev mode.
    ...(IS_DEV
      ? {}
      : {
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails
            extension_pages:
              "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
          },
        }),
  },
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push({
        relativeDest: 'build-info.json',
        contents: JSON.stringify({ built_at: BUILD_TIME }),
      });
    },
  },
  vite: (env) => ({
    define: {
      __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    },
    plugins: [
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Ensure static assets are available as early as possible to avoid race conditions in dev
      // Copy workers/_locales/inject-scripts into the build output before other steps
      viteStaticCopy({
        targets: [
          {
            src: 'inject-scripts/*.js',
            dest: 'inject-scripts',
          },
          {
            src: '_locales/**/*',
            dest: '_locales',
          },
        ],
        // Use writeBundle so outDir exists for dev and prod
        hook: 'writeBundle',
        // Enable watch so changes to these files are reflected during dev
        watch: {
          // Use default patterns inferred from targets; explicit true enables watching
          // Vite plugin will watch src patterns and re-copy on change
        } as any,
      }) as any,
    ],
    build: {
      target: 'es2015',
      sourcemap: env.mode !== 'production',
      reportCompressedSize: false,
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
