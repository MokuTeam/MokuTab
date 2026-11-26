/**
 * Chrome Extension Constants
 * Centralized configuration values and magic constants
 *
 * Author: Roman Chikalenko
 * Version: 1.4.0
 */

// Native Host Configuration
export const NATIVE_HOST = {
  NAME: 'com.chromemcp.nativehost',
  DEFAULT_PORT: 12306,
} as const;

// Timeouts and Delays (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_WAIT: 1000,
  KEYBOARD_DELAY: 50,
} as const;

// Limits and Thresholds
export const LIMITS = {
  MAX_NETWORK_REQUESTS: 100,
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  NATIVE_CONNECTION_FAILED: 'Failed to connect to native host',
  NATIVE_DISCONNECTED: 'Native connection disconnected',
  SERVER_STATUS_LOAD_FAILED: 'Failed to load server status',
  SERVER_STATUS_SAVE_FAILED: 'Failed to save server status',
  TOOL_EXECUTION_FAILED: 'Tool execution failed',
  INVALID_PARAMETERS: 'Invalid parameters provided',
  TAB_NOT_FOUND: 'Tab not found',
} as const;

// Success Messages
export const SUCCESS_MESSAGES = {
  TOOL_EXECUTED: 'Tool executed successfully',
  SERVER_STARTED: 'Server started successfully',
  SERVER_STOPPED: 'Server stopped successfully',
} as const;

// External Links
export const LINKS = {
  REPO: 'https://github.com/MokuTeam/MokuTab',
  TROUBLESHOOTING: 'https://github.com/MokuTeam/MokuTab#manual-smoke-test',
} as const;

// Network Filtering
export const NETWORK_FILTERS = {
  // Substring match against full URL (not just hostname) to support patterns like 'facebook.com/tr'
  EXCLUDED_DOMAINS: [
    // Google
    'google-analytics.com',
    'googletagmanager.com',
    'analytics.google.com',
    'doubleclick.net',
    'googlesyndication.com',
    'googleads.g.doubleclick.net',
    'stats.g.doubleclick.net',
    'adservice.google.com',
    'pagead2.googlesyndication.com',
    // Amazon
    'amazon-adsystem.com',
    // Microsoft
    'bat.bing.com',
    'clarity.ms',
    // Facebook
    'connect.facebook.net',
    'facebook.com/tr',
    // Twitter
    'analytics.twitter.com',
    'ads-twitter.com',
    // Other ad networks
    'ads.yahoo.com',
    'adroll.com',
    'adnxs.com',
    'criteo.com',
    'quantserve.com',
    'scorecardresearch.com',
    // Analytics & session recording
    'segment.io',
    'amplitude.com',
    'mixpanel.com',
    'optimizely.com',
    'static.hotjar.com',
    'script.hotjar.com',
    'crazyegg.com',
    'clicktale.net',
    'mouseflow.com',
    'fullstory.com',
    // LinkedIn (tracking pixels)
    'linkedin.com/px',
  ],
  // Static resource extensions (used when includeStatic=false)
  STATIC_RESOURCE_EXTENSIONS: [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.bmp',
    '.cur',
    '.css',
    '.scss',
    '.less',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.map',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.otf',
    '.mp3',
    '.mp4',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.ogg',
    '.wav',
    '.pdf',
    '.zip',
    '.rar',
    '.7z',
    '.iso',
    '.dmg',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
  ],
  // MIME types treated as static/binary (filtered when includeStatic=false)
  STATIC_MIME_TYPES_TO_FILTER: [
    'image/',
    'font/',
    'audio/',
    'video/',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'application/pdf',
    'application/zip',
    'application/octet-stream',
  ],
  // API-like MIME types (never filtered by MIME)
  API_MIME_TYPES: [
    'application/json',
    'application/xml',
    'text/xml',
    'text/plain',
    'text/event-stream',
    'application/x-www-form-urlencoded',
    'application/graphql',
    'application/grpc',
    'application/protobuf',
    'application/x-protobuf',
    'application/x-json',
    'application/ld+json',
    'application/problem+json',
    'application/problem+xml',
    'application/soap+xml',
    'application/vnd.api+json',
  ],
  STATIC_RESOURCE_TYPES: ['stylesheet', 'image', 'font', 'media', 'other'],
} as const;

// Storage Keys
export const STORAGE_KEYS = {
  SERVER_STATUS: 'serverStatus',
  NATIVE_SERVER_PORT: 'nativeServerPort',
  NATIVE_AUTO_CONNECT_ENABLED: 'nativeAutoConnectEnabled',
  PROFILE_NAME: 'profileName',
  /** The bridge's module switch, as last pushed (see common/module-state.ts). */
  MODULES_STATE: 'modulesState',
  /** NetSuite transparent mode in this profile: off only when set to false. */
  NS_TRANSPARENT: 'nsTransparent',
} as const;
