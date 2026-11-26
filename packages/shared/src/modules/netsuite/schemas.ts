/**
 * NetSuite module tool schemas. Every result is metadata only: names, hosts,
 * states and an 8-char fingerprint, never a cookie value.
 */
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { NETSUITE_TOOL_NAMES } from './tool-names';

const T = NETSUITE_TOOL_NAMES.NETSUITE_SESSION;

export const NETSUITE_TOOL_SCHEMAS: Tool[] = [
  {
    name: T.STATUS,
    description:
      'The NetSuite sessions the shared store holds: account, user, role, ' +
      'state (live, dying, dead), login and expiry times, last activity, holders, lock, fp ' +
      '(8-char fingerprint). Metadata only. state store_unconfigured: this machine has no store ' +
      'token; no_store: the store is not reachable (behave as without it).',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          ...{
            type: 'string',
            pattern: '^([0-9]+|[Tt][Dd][0-9]+|[Tt][Ss][Tt][Dd][Rr][Vv][0-9]+)([_-][A-Za-z0-9]+)?$',
            description:
              'NetSuite account id: 1234567, 1234567_SB2, td3125712, tstdrv1234567 (any case).',
          },
          description: 'Only this account.',
        },
      },
    },
  },
  {
    name: T.ENSURE,
    description:
      "Give this Chrome profile the store's live session for an account, so it needs no login. " +
      'Returns state imported (cookies set in the profile; reload the NetSuite page), ' +
      'partial_import (Chrome refused some cookies), ' +
      'already_live (the profile already has that session), none (nothing alive: log in, then ' +
      'netsuite_session_publish), locked_by {holder, until} (another machine is logging in), ' +
      'store_unconfigured or no_store (no store: behave as without it). The user is the vault ' +
      "item's username when vault_item is given (only an item for this account's site; the name " +
      'is not echoed, user_source: vault), else the one this profile used last for the ' +
      'account, else the only live one. Never returns a cookie value.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          pattern: '^([0-9]+|[Tt][Dd][0-9]+|[Tt][Ss][Tt][Dd][Rr][Vv][0-9]+)([_-][A-Za-z0-9]+)?$',
          description:
            'NetSuite account id: 1234567, 1234567_SB2, td3125712, tstdrv1234567 (any case).',
        },
        user: { type: 'string', description: 'NetSuite user email to take the session of.' },
        vault_item: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          description:
            "Bitwarden item id: its username is the user (the item's password is never read).",
        },
        wait_for_lock: {
          type: 'boolean',
          default: false,
          description:
            'When another machine holds the login lock, wait (polling every 3 s) until it publishes or the lock ends.',
        },
      },
      required: ['account'],
    },
  },
  {
    name: T.PUBLISH,
    description:
      "Put this profile's live session for an account into the store, so other machines can use " +
      'it. Returns published, unchanged (the store already has it), no_session (no session ' +
      'cookie for the account in this profile), store_unconfigured or no_store. The user and ' +
      'role come from an open tab of the account, else from vault_item or user.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          pattern: '^([0-9]+|[Tt][Dd][0-9]+|[Tt][Ss][Tt][Dd][Rr][Vv][0-9]+)([_-][A-Za-z0-9]+)?$',
          description:
            'NetSuite account id: 1234567, 1234567_SB2, td3125712, tstdrv1234567 (any case).',
        },
        user: {
          type: 'string',
          description: 'NetSuite user email, when no tab of the account is open.',
        },
        vault_item: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          description: 'Bitwarden item id whose username is the user, when no tab is open.',
        },
        login_at: {
          type: 'boolean',
          default: false,
          description: 'This session was just logged in (sets login_at to now).',
        },
      },
      required: ['account'],
    },
  },
  {
    name: T.LOCK,
    description:
      'Take the login lock for an account and user before a login, so two machines do not log ' +
      'in at once (each would end the other). Returns locked {until}, locked_by {holder, until}, ' +
      'store_unconfigured or no_store. A publish or netsuite_session_unlock releases it; it ends by itself after ttl_s.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          pattern: '^([0-9]+|[Tt][Dd][0-9]+|[Tt][Ss][Tt][Dd][Rr][Vv][0-9]+)([_-][A-Za-z0-9]+)?$',
          description:
            'NetSuite account id: 1234567, 1234567_SB2, td3125712, tstdrv1234567 (any case).',
        },
        user: { type: 'string', description: 'NetSuite user email.' },
        vault_item: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          description: 'Bitwarden item id whose username is the user.',
        },
        run_id: { type: 'string', description: 'Run id for the lock holder (shown to others).' },
        ttl_s: {
          type: 'integer',
          minimum: 10,
          maximum: 120,
          default: 120,
          description: 'Seconds the lock lasts.',
        },
      },
      required: ['account'],
    },
  },
  {
    name: T.UNLOCK,
    description:
      'Release the login lock this machine and profile hold for an account and user. Returns ' +
      'unlocked, store_unconfigured or no_store.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          pattern: '^([0-9]+|[Tt][Dd][0-9]+|[Tt][Ss][Tt][Dd][Rr][Vv][0-9]+)([_-][A-Za-z0-9]+)?$',
          description:
            'NetSuite account id: 1234567, 1234567_SB2, td3125712, tstdrv1234567 (any case).',
        },
        user: { type: 'string', description: 'NetSuite user email.' },
        vault_item: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          description: 'Bitwarden item id whose username is the user.',
        },
        run_id: { type: 'string', description: 'The run id the lock was taken with, if any.' },
      },
      required: ['account'],
    },
  },
];
