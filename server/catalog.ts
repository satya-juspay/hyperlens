import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { parse } from 'acorn';
import type { Comment } from 'acorn';
import type { CatalogEntry, Json, StaticValue } from '../shared/model.js';
import { category, entries, formatPath } from './paths.js';
import { LiteralReader, toJson } from './parser.js';

export async function repositoryCatalog(widget: string, readerRepo: string): Promise<{
  definitions: CatalogEntry[];
  notes: string[];
}> {
  const definitions = new Map<string, CatalogEntry>();
  const notes: string[] = [];
  const deprecated = new WeakSet<StaticValue>();
  const modules = new Map<string, Map<string, StaticValue>>();

  function upsert(path: string, key: string, fields: Partial<CatalogEntry>): void {
    const previous = definitions.get(path);
    definitions.set(path, {
      key, path, category: category(path), source: 'repository',
      ...previous, ...fields, types: [...new Set([...previous?.types ?? [], ...fields.types ?? []])]
    });
  }

  try {
    const base = await realpath(widget);
    async function readModule(path: string): Promise<Map<string, StaticValue>> {
      const file = await realpath(path);
      if (!file.startsWith(base + sep) || extname(file) !== '.js') throw new Error('Unsupported import.');
      const cached = modules.get(file);
      if (cached) return cached;
      const exported = new Map<string, StaticValue>();
      modules.set(file, exported);
      try {
        const source = await readFile(file, 'utf8');
        const comments: Comment[] = [];
        const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
        const deprecatedComments = comments.filter(comment => /\bdeprecated\b/i.test(comment.value));
        const literal = new LiteralReader(source, (property, value) => {
          if (deprecatedComments.some(comment => comment.start >= property.end
            && /^\s*,?[ \t]*$/.test(source.slice(property.end, comment.start))
            && !source.slice(property.end, comment.start).includes('\n'))) deprecated.add(value);
        });
        const scope = new Map<string, StaticValue>();
        for (const node of program.body) {
          if (node.type !== 'ImportDeclaration' || typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue;
          try {
            const imported = await readModule(resolve(dirname(file), node.source.value));
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportNamespaceSpecifier') continue;
              const key = specifier.type === 'ImportDefaultSpecifier' ? 'default'
                : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
              const value = typeof key === 'string' ? imported.get(key) : undefined;
              if (value) scope.set(specifier.local.name, value);
            }
          } catch {
            notes.push(`Skipped a HyperWidget import in ${file.slice(base.length + 1)}.`);
          }
        }
        for (const node of program.body) {
          literal.bind(node, scope);
          if (node.type === 'ExportDefaultDeclaration' && node.declaration.type !== 'ClassDeclaration'
            && node.declaration.type !== 'FunctionDeclaration') {
            exported.set('default', literal.read(node.declaration, scope));
          }
          if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
          if (node.declaration?.type === 'VariableDeclaration') {
            for (const { id } of node.declaration.declarations) {
              if (id.type !== 'Identifier') continue;
              const value = scope.get(id.name);
              if (value) exported.set(id.name, value);
            }
          }
        }
        for (const node of program.body) {
          if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
          for (const { exported: name, local } of node.specifiers) {
            if (local.type !== 'Identifier') continue;
            const value = scope.get(local.name);
            if (value) exported.set(name.type === 'Identifier' ? name.name : String(name.value), value);
          }
        }
        return exported;
      } catch (error) {
        modules.delete(file);
        throw error;
      }
    }

    const root = (await readModule(resolve(base, 'config/config.js'))).get('Config');
    if (root?.type !== 'object') throw new Error('HyperWidget has no supported configuration root.');
    for (const entry of entries(root)) {
      if (!entry.path.startsWith('mainConfig')) continue;
      const { logicalPath, logicalKey, value } = entry;
      const fieldType = ['unresolved', 'hole'].includes(value.type) ? [] : [value.type];
      const defaultValue = ['boolean', 'number', 'string', 'null'].includes(value.type) ? toJson(value) : undefined;
      upsert(logicalPath, logicalKey, { types: fieldType, defaultValue, ...(deprecated.has(value) && { deprecated: true }) });
    }
    const mapping = root.entries.componentMapping;
    if (mapping?.type === 'object') {
      for (const [alias, mapped] of Object.entries(mapping.entries)) {
        if (mapped.type !== 'string' || typeof mapped.value !== 'string') continue;
        const path = mapped.value;
        const entry = definitions.get(path);
        if (entry) entry.aliases = [...entry.aliases ?? [], alias];
      }
    }

    try {
      const rules = (await readModule(resolve(base, 'constants/rules.js'))).get('default');
      if (rules?.type === 'object') {
        for (const rule of Object.values(rules.entries)) {
          if (rule.type !== 'object') continue;
          const { description, keys } = rule.entries;
          if (keys?.type !== 'object') continue;
          const descriptionValue = description?.type === 'string' ? String(description.value) : undefined;
          for (const group of Object.values(keys.entries)) {
            if (group.type !== 'object') continue;
            for (const [name, properties] of Object.entries(group.entries)) {
              const segments = name.split('.');
              function add(path: string[], value: StaticValue): void {
                if (value.type !== 'object') return;
                const { type, defaultValue } = value.entries;
                if (type || defaultValue) {
                  const fieldType = readRuleType(type);
                  upsert(formatPath(path), path.at(-1)!, {
                    types: fieldType ? [fieldType] : [], defaultValue: defaultValue && toJson(defaultValue),
                    ...(descriptionValue && { description: descriptionValue })
                  });
                  return;
                }
                for (const [child, property] of Object.entries(value.entries)) add([...path, child], property);
              }
              add(segments, properties);
            }
          }
        }
      }
    } catch {
      notes.push('HyperWidget feature descriptions were unavailable.');
    }
  } catch {
    notes.push('HyperWidget definitions were unavailable. The observed catalog is built from indexed data.');
  }

  try {
    const example = JSON.parse(await readFile(resolve(readerRepo, 'example.json'), 'utf8')) as Record<string, Json>;
    const descriptions: Record<string, string> = {
      mainConfig: 'Configuration sections and their explicitly declared properties.',
      componentMapping: 'Component path aliases that point to configuration sections.',
      context: 'Inputs used by the config-reader runtime.'
    };
    for (const [key, description] of Object.entries(descriptions)) {
      if (Object.hasOwn(example, key)) upsert(key, key, { description, types: [Array.isArray(example[key]) ? 'array' : 'object'] });
    }
  } catch {
    notes.push('Config-reader schema examples were unavailable.');
  }
  return { definitions: [...definitions.values()], notes: [...new Set(notes)] };
}

function readRuleType(node: StaticValue | undefined): StaticValue['type'] | undefined {
  if (node?.type === 'array' && node.items[0]?.type === 'string') {
    if (node.items[0].value === 'Maybe') return readRuleType(node.items[1]);
    if (node.items[0].value === 'Array') return 'array';
  }
  if (node?.type !== 'string' || typeof node.value !== 'string') return undefined;
  switch (node.value.toLowerCase()) {
    case 'int':
    case 'number': return 'number';
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    case 'array': return 'array';
  }
}
