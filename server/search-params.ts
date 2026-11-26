import { environments, modes, platforms, sortFields } from '../shared/model.js';
import type { Json, SearchQuery } from '../shared/model.js';

export class BadRequest extends Error {}

export function number(input: string | null, fallback: number, max: number, min = 1): number {
  if (input === null) return fallback;
  const value = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BadRequest(`Expected a whole number between ${min} and ${max}.`);
  }
  return value;
}

function choice<T extends string>(input: string|null, allowed: readonly T[], fallback: T): T {
  if (input === null) return fallback;
  if (!allowed.includes(input as T)) throw new BadRequest(`Use one of ${allowed.join(', ')}.`);
  return input as T;
}

function choices<T extends string>(input: string[], allowed: readonly T[]): T[] {
  return [...new Set(input.map(value => choice(value, allowed, allowed[0])))];
}

export function searchParams(params: URLSearchParams): SearchQuery {
  const query = params.get('q') ?? '';
  const clientIds = params.getAll('clientId');
  const rawValue = params.get('value');
  if (query.length > 1024) throw new BadRequest('Configuration names and paths must be at most 1,024 characters.');
  if (clientIds.length > 50 || clientIds.some(value => !/^[a-z0-9_.-]{1,120}$/.test(value))) {
    throw new BadRequest('Use up to 50 valid client IDs.');
  }
  let valueFilter: Json | undefined;
  if (rawValue !== null) {
    if (rawValue.length > 2000) throw new BadRequest('The value filter must be at most 2,000 characters.');
    try { valueFilter = JSON.parse(rawValue); }
    catch { throw new BadRequest('Enter a JSON value, for example true, 3, null or "UPI".'); }
    function validate(value: Json): void {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new BadRequest('Use finite numbers.');
      if (value && typeof value === 'object') for (const child of Object.values(value)) validate(child);
    }
    validate(valueFilter as Json);
  }
  return {
    query: query.trim(), mode: choice(params.get('mode'), modes, 'exact-key'),
    platforms: choices(params.getAll('platform'), platforms), environments: choices(params.getAll('environment'), environments),
    clientIds, valueFilter, includeValues: choice(params.get('includeValues'), ['true', 'false'], 'true') === 'true',
    page: number(params.get('page'), 1, 1_000_000), pageSize: number(params.get('pageSize'), 25, 100),
    sort: choice(params.get('sort'), sortFields, 'clientId'),
    direction: choice(params.get('direction'), ['asc', 'desc'], 'asc')
  };
}

