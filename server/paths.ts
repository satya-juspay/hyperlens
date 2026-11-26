import type { Path, StaticValue } from '../shared/model.js';
import { asConfigReaderValue } from './parser.js';

const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/u;
const plainKey = new RegExp(identifier.source + '$', 'u');
const bracket = /^\[(?:(0|[1-9][0-9]*)|("(?:[^"\\\u0000-\u001f]|\\.)*"))\]/u;
const compound = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

export function formatPath(path: Path): string {
  return path.map((segment, index) => {
    if (typeof segment === 'number') return `[${segment}]`;
    if (!plainKey.test(segment)) return `[${JSON.stringify(segment)}]`;
    return index ? `.${segment}` : segment;
  }).join('');
}

export function parsePath(input: string): Path {
  const path: Path = [];
  let offset = 0;
  while (offset < input.length) {
    if (input[offset] === '[') {
      const parts = bracket.exec(input.slice(offset));
      if (!parts) throw new Error('Use [0] for array indices and ["key.with.dots"] for literal dotted keys.');
      const segment = parts[1] === undefined ? JSON.parse(parts[2]) as string : Number(parts[1]);
      if (typeof segment === 'number' && !Number.isSafeInteger(segment)) throw new Error('Invalid array index.');
      path.push(segment);
      offset += parts[0].length;
      continue;
    }
    if (path.length) {
      if (input[offset] !== '.') throw new Error('Separate nested keys with dots or brackets.');
      offset++;
    }
    const match = identifier.exec(input.slice(offset));
    if (!match) throw new Error('Use ["key"] for property names containing special characters.');
    path.push(match[0]);
    offset += match[0].length;
  }
  if (!path.length) throw new Error('A configuration path is required.');
  return path;
}

export interface Entry {
  key: string;
  path: string;
  logicalPath: string;
  unwrappedPath?: string;
  logicalKey: string;
  value: StaticValue;
}

export function* entries(tree: StaticValue): Generator<Entry> {
  const wrapped = tree.type === 'object' && tree.entries.mainConfig?.type === 'object';

  function* visit(node: StaticValue, raw: Path, logical: Path, inMain: boolean): Generator<Entry> {
    const value = inMain ? asConfigReaderValue(node) : node;
    if (raw.length && value.type !== 'hole') {
      const path = formatPath(raw);
      yield {
        key: String(raw.at(-1)), path, logicalPath: formatPath(logical),
        logicalKey: String(logical.at(-1)), value,
        ...(inMain && { unwrappedPath: path.slice('mainConfig'.length).replace(/^\./, '') })
      };
    }
    if (node.type === 'object') {
      for (const [key, child] of Object.entries(node.entries)) {
        const path = [...raw, key];
        if (value.type === 'unresolved') {
          // The second argument to #override contains fully explicit fields.
          if (key === '#override' && child.type === 'array' && child.items[1]?.type === 'object') {
            for (const [override, item] of Object.entries(child.items[1].entries)) {
              const segments = compound.test(override) ? override.split('.') : [override];
              yield* visit(item, [...path, 1, override], [...logical, ...segments], true);
            }
          }
          continue;
        }
        const alias = inMain && compound.test(key) ? key.split('.') : [key];
        if (wrapped && raw.length === 0 && key === 'mainConfig' && child.type === 'object') {
          yield { key, path: key, logicalKey: key, logicalPath: key, value: child };
          for (const [section, config] of Object.entries(child.entries)) {
            yield* visit(config, [key, section], compound.test(section) ? section.split('.') : [section], true);
          }
        } else {
          yield* visit(child, path, [...logical, ...alias], inMain);
        }
      }
    } else if (node.type === 'array') {
      for (const [index, child] of node.items.entries()) {
        yield* visit(child, [...raw, index], [...logical, index], inMain);
      }
    }
  }
  yield* visit(tree, [], [], false);
}

export function category(path: string): string {
  const root = path.split(/[.[]/, 1)[0];
  if (root === 'flowConfig') return 'Flow';
  if (root === 'screenConfig') return 'Screen';
  if (root === 'globalConfig') return 'Global';
  if (root === 'componentMapping' || root === 'context') return 'Config reader';
  return 'Other';
}
