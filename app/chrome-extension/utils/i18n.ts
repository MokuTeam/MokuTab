/**
 * Chrome Extension i18n utility
 * Provides safe access to chrome.i18n.getMessage with fallbacks
 */

// Fallback messages for when Chrome APIs aren't available (English)
const fallbackMessages: Record<string, string> = {
  extensionName: 'MokuTab',
  extensionDescription:
    "Chrome extension that exposes the user's logged-in browser session as MCP tools for AI agents.",
  lastUpdatedLabel: 'Last Updated:',
  connectButton: 'Connect',
  disconnectButton: 'Disconnect',
  connectingStatus: 'Connecting...',
  detectingStatus: 'Detecting...',
  serviceRunningStatus: 'Service Running (Port: {0})',
  serviceNotConnectedStatus: 'Service Not Connected',
  connectedServiceNotStartedStatus: 'Connected, Service Not Started',
  mcpServerConfigLabel: 'MCP Server Configuration',
  connectionPortLabel: 'Connection Port',
  profileNameLabel: 'Profile Name',
  profileNamePlaceholder: 'e.g. prod, staging, dev',
  settingsSectionLabel: 'Settings',
  refreshStatusButton: 'Refresh Status',
  copyShortButton: 'Copy',
  copiedShortLabel: 'Copied',
  copyFailedShortLabel: 'Failed',
  bookmarksBarLabel: 'Bookmarks Bar',
  modulesSectionLabel: 'Modules',
  moduleDescription_workato:
    'Recipes, jobs, connections, tables and Workflow App pages in Workato.',
  moduleDescription_netsuite:
    'NetSuite sessions shared between machines through the session store.',
  modulesBridgeOffNote:
    'Connect to the bridge to change modules. The switch applies to every Chrome profile on this machine.',
  modulesBridgeOldNote: 'This bridge cannot switch modules. Update the bridge to change them.',
  modulesSaveFailed: 'Could not change the switch: {0}',
  nsSessionsSectionLabel: 'NetSuite sessions',
  nsSessionsLoading: 'Checking sessions...',
  nsSessionsEmpty: 'No active sessions',
  nsSessionsUnreachable: 'Session store not reachable',
  nsSessionStateLive: 'live',
  nsSessionStateDying: 'dying',
  nsSessionOpenFailed: 'Could not open session',
  nsSessionOpenTooltip: 'Open {0} in a new tab',
  nsTimeLessThanMinute: '< 1 min',
  nsTimeHoursMinutes: '{0} h {1} min',
  nsTimeHours: '{0} h',
  nsTimeMinutes: '{0} min',
  nsAgoJustNow: 'just now',
  nsAgoMinutes: '{0} min ago',
  nsAgoHours: '{0} h ago',
  nsAgoDays: '{0} d ago',
  nsErrorStoreUnreachable: 'Session store not reachable',
  nsErrorModuleOff: 'The NetSuite module is off',
  nsErrorOtherUser:
    'This profile is logged in to the account as another user. Log out there first.',
  nsErrorCouldNotCheck: 'Could not check the open session. Nothing was changed.',
  guideLinkLabel: 'Guide',
  guideLinkTitle: 'View installation guide',
  docsLinkLabel: 'Docs',
  docsLinkTitle: 'Troubleshooting',
  footerTagline: 'browser tools for ai agents',
};

/**
 * Safe i18n message getter with fallback support
 * @param key Message key
 * @param substitutions Optional substitution values
 * @returns Localized message or fallback
 */
export function getMessage(key: string, substitutions?: string[]): string {
  try {
    // Check if Chrome extension APIs are available
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
      const message = chrome.i18n.getMessage(key, substitutions);
      if (message) {
        return message;
      }
    }
  } catch (error) {
    console.warn(`Failed to get i18n message for key "${key}":`, error);
  }

  // Fallback to English messages
  let fallback = fallbackMessages[key] || key;

  // Handle substitutions in fallback messages
  if (substitutions && substitutions.length > 0) {
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(`{${index}}`, value);
    });
  }

  return fallback;
}
