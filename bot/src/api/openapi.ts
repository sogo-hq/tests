import {
  API_VERSION, CHAIN_ID, LAUNCHPAD, COMMITTED_CHECK_IDS, ADDITIONAL_CHECK_IDS,
  MAX_BATCH, MAX_LAG_BLOCKS,
} from './types.js';
import { RATES } from './auth.js';
import { API_CACHE_MS } from './handlers.js';

/**
 * The OpenAPI document, built from the same constants the handlers use.
 *
 * Not hand-written, and that is the point rather than a convenience: a schema
 * written beside a handler is two descriptions of one thing, and the one that
 * goes stale is always the one a partner is reading. Every enumerated value
 * here -- the check ids, the states, the batch ceiling, the rates -- is the
 * identifier the code branches on, so a rename that did not update the document
 * cannot compile.
 */

const CHECK_STATES = ['finding', 'undetermined', 'none'] as const;

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

export function openapiDocument(publicUrl = process.env.API_PUBLIC_URL || 'https://api.checkvitals.xyz') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'VITALS API',
      version: API_VERSION,
      description: [
        'Read-only facts about pons v2 launches on Robinhood Chain, read from the chain.',
        '',
        'Two guarantees this API makes, and will keep:',
        '',
        '1. `state` is one of exactly three words: "finding", "undetermined", "none".',
        '   There is no score, no grade, no risk level and no "safe" field, and there',
        '   will not be one. A consumer who wants to rank launches decides for',
        '   themselves what matters; publishing the checks instead of a number is the',
        '   whole design.',
        '',
        '2. `state: "none"` means the check ran and found nothing. It is not an',
        '   all-clear and is never described as clean. `state: "undetermined"` means',
        '   the check could not be answered from the data available, and such a check',
        '   never carries a `value`.',
        '',
        'Check `id`s are permanent. Adding a check is a compatible change; renaming or',
        'removing one is not.',
      ].join('\n'),
    },
    servers: [{ url: `${publicUrl.replace(/\/+$/, '')}/${API_VERSION}` }],
    paths: {
      '/launch/{address}': {
        get: {
          summary: 'One launch, as structured checks',
          parameters: [{
            name: 'address', in: 'path', required: true,
            schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          }],
          responses: {
            200: { description: 'the launch', content: { 'application/json': { schema: ref('Launch') } } },
            400: { description: 'not an address', content: { 'application/json': { schema: ref('Error') } } },
            404: {
              description: 'the factory has no record of this token. `resolved_as` says what the address turned out to be, when it was something.',
              content: { 'application/json': { schema: ref('Error') } },
            },
            429: { description: 'rate limited. See Retry-After.', content: { 'application/json': { schema: ref('Error') } } },
            503: {
              description: `the index is more than ${MAX_LAG_BLOCKS} blocks behind, or the chain could not be read`,
              content: { 'application/json': { schema: ref('Error') } },
            },
          },
        },
      },
      '/launches': {
        post: {
          summary: `Up to ${MAX_BATCH} launches at once, with per-item errors`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['addresses'],
                  properties: {
                    addresses: {
                      type: 'array', minItems: 1, maxItems: MAX_BATCH,
                      items: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'one entry per address, in the order given. A failed item carries its error and does not fail the batch.',
              content: { 'application/json': { schema: { type: 'array', items: ref('BatchItem') } } },
            },
            400: { description: 'malformed body, or more than the ceiling', content: { 'application/json': { schema: ref('Error') } } },
            429: { description: 'rate limited', content: { 'application/json': { schema: ref('Error') } } },
            503: { description: 'the index is lagging', content: { 'application/json': { schema: ref('Error') } } },
          },
        },
      },
      '/stats': {
        get: {
          summary: 'Index size and the exemption distribution',
          responses: { 200: { description: 'stats', content: { 'application/json': { schema: ref('Stats') } } } },
        },
      },
      '/health': {
        get: {
          summary: 'Index head and lag',
          responses: { 200: { description: 'health', content: { 'application/json': { schema: ref('Health') } } } },
        },
      },
      '/revenue': {
        get: {
          summary: 'Revenue and the declared split, in ETH',
          description:
            'Public and keyless. Creator income claimed to date, the declared split computed '
            + 'from it, every BLOCK ZERO payout with its transaction, and what is still owed. '
            + 'ETH only: no price, no USD and no projection. Cached 60 seconds.',
          responses: { 200: { description: 'The current figures' } },
        },
      },
      '/openapi.json': {
        get: { summary: 'This document', responses: { 200: { description: 'the document' } } },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: `partner keys: ${RATES.partner} rps` },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: `public keys: ${RATES.public} rps` },
      },
      schemas: {
        Check: {
          type: 'object',
          required: ['id', 'state', 'headline', 'value', 'reference', 'severity', 'source'],
          properties: {
            id: {
              type: 'string',
              enum: [...COMMITTED_CHECK_IDS, ...ADDITIONAL_CHECK_IDS],
              description: `the first ${COMMITTED_CHECK_IDS.length} are the committed set and are permanent; the rest were added later and may be ignored`,
            },
            state: {
              type: 'string',
              enum: [...CHECK_STATES],
              description: '"none" means the check found nothing. It is not an all-clear.',
            },
            headline: { type: 'string', description: 'one sentence, never a verdict about the launch' },
            value: {
              type: ['object', 'null'],
              additionalProperties: true,
              description:
                'the measured quantity, as an object, or null. Never a bare number, string or '
                + 'boolean. Keys are per check id: snipe_tax_exemptions {wallets, beyond_deployer, '
                + 'supply_share, slots}, creator_opening_buy {supply_share}, creator_tax {bps}, '
                + 'deployer_history {launches_7d}, ticker_collision {matches}, ticker_vs_pair '
                + '{differs}, pair_asset {asset, address}, buyback_vesting {enabled}, '
                + 'holder_concentration {top5_share, largest_share, holders}. Shares are FRACTIONS: '
                + '0.174 is 17.4% of supply. A key whose quantity was not read is null, never 0. '
                + 'The whole object is null whenever state is "undetermined".',
            },
            reference: {
              type: ['object', 'null'],
              additionalProperties: true,
              description:
                'what the value is measured against, as an object, or null when there is nothing '
                + 'to measure it against yet: creator_tax {median_bps, n}, creator_opening_buy '
                + '{median_share, n}, ticker_collision {indexed, flag_at_or_above}, '
                + 'deployer_history {flag_above}, holder_concentration {flag_at_share, percentile, '
                + 'n}. Always null when state is "undetermined".',
            },
            severity: {
              type: 'integer',
              description: 'ordering weight, higher first. Not a score, and not comparable between launches.',
            },
            source: { type: 'string', description: 'what this check was read from' },
          },
        },
        Launch: {
          type: 'object',
          required: ['token', 'chain', 'launchpad', 'symbol', 'launch_block', 'launch_tx',
            'age_seconds', 'pair', 'checks', 'summary', 'as_of', 'index'],
          properties: {
            token: { type: 'string' },
            chain: { type: 'integer', const: CHAIN_ID },
            launchpad: { type: 'string', const: LAUNCHPAD },
            symbol: { type: ['string', 'null'] },
            launch_block: { type: ['integer', 'null'] },
            launch_tx: { type: ['string', 'null'] },
            age_seconds: { type: 'integer' },
            pair: {
              type: 'object',
              required: ['asset', 'address'],
              properties: { asset: { type: ['string', 'null'] }, address: { type: 'string' } },
            },
            checks: { type: 'array', items: ref('Check') },
            summary: {
              type: 'object',
              required: ['checks_run', 'findings', 'undetermined'],
              properties: {
                checks_run: { type: 'integer' },
                findings: { type: 'integer' },
                undetermined: { type: 'integer' },
              },
            },
            as_of: { type: 'string', format: 'date-time' },
            index: {
              type: 'object', required: ['launches'],
              properties: { launches: { type: 'integer' } },
            },
          },
        },
        BatchItem: {
          type: 'object',
          required: ['address', 'ok'],
          properties: {
            address: { type: 'string' },
            ok: { type: 'boolean' },
            launch: ref('Launch'),
            error: ref('Error'),
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            resolved_as: {
              type: ['string', 'null'], enum: ['deployer', 'curve', null],
              description: 'on a 404, what the address turned out to be',
            },
          },
        },
        Stats: {
          type: 'object',
          required: ['index', 'exemptions', 'declarations', 'as_of'],
          properties: {
            index: {
              type: 'object',
              properties: {
                launches: { type: 'integer' },
                decoded: { type: 'integer' },
                read_from_curve_events: { type: 'integer' },
              },
            },
            exemptions: {
              type: 'object',
              properties: {
                with_any: { type: 'integer' },
                beyond_deployer: { type: 'integer' },
                beyond_deployer_pct: { type: 'number' },
                median_count_beyond_deployer: {
                  type: ['integer', 'null'],
                  description: 'null below the publishing floor: no median is published on a small sample',
                },
                median_sample: { type: 'integer' },
              },
            },
            declarations: { type: 'integer' },
            as_of: { type: 'string', format: 'date-time' },
          },
        },
        Health: {
          type: 'object',
          required: ['ok', 'head_block', 'indexed_to_block', 'lag_blocks', 'as_of'],
          properties: {
            ok: { type: 'boolean', description: `false once lag exceeds ${MAX_LAG_BLOCKS} blocks` },
            head_block: { type: ['integer', 'null'] },
            indexed_to_block: { type: ['integer', 'null'] },
            lag_blocks: { type: ['integer', 'null'], description: 'null when either end could not be read, which is not zero' },
            as_of: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    'x-rate-limits': {
      keyless: `${RATES.keyless} rps, for evaluating the contract`,
      public: `${RATES.public} rps`,
      partner: `${RATES.partner} rps`,
      cache: `answers are reused for ${Math.round(API_CACHE_MS / 1000)}s per token`,
    },
  };
}
