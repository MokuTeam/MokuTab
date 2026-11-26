/** The NetSuite part of the server instructions, sent while the module is on. */
export const NETSUITE_INSTRUCTIONS =
  'NetSuite: login page -> netsuite_session_ensure (imported: reload); ' +
  'log in only on none, then netsuite_session_publish.';
