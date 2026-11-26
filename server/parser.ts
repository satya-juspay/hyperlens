import { parse } from 'acorn';
import type {
  Expression, ModuleDeclaration, Node, PrivateIdentifier, Program, Property, Statement, Super
} from 'acorn';
import type { Json, StaticValue } from '../shared/model.js';

export interface ParsedConfig { tree: StaticValue; structuralWarnings: number }
export type Scope = Map<string, StaticValue>;
export const parseScript = (source: string) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function memberName(node: Expression | Super): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return undefined;
  const parent = memberName(node.object);
  const property = staticKey(node.property, node.computed);
  return parent && property !== undefined ? `${parent}.${property}` : undefined;
}

function staticKey(node: Expression | PrivateIdentifier, computed: boolean): string | undefined {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) {
    return String(node.value);
  }
  if (node.type === 'TemplateLiteral' && !node.expressions.length) {
    return node.quasis[0].value.cooked ?? undefined;
  }
}

const copyEntries = (entries: Record<string, StaticValue>) =>
  Object.assign(Object.create(null) as Record<string, StaticValue>, entries);

export class LiteralReader {
  structuralWarnings = 0;

  constructor(
    private readonly source: string,
    private readonly onProperty?: (property: Property, value: StaticValue) => void
  ) {}

  private unresolved(node: Node): StaticValue {
    return { type: 'unresolved', syntax: 'javascript', expression: this.source.slice(node.start, node.end) };
  }

  read(node: Expression, scope: Scope): StaticValue {
    switch (node.type) {
      case 'Literal': {
        const { value } = node;
        if (value === null) return { type: 'null', value };
        if (typeof value === 'string') return { type: 'string', value };
        if (typeof value === 'boolean') return { type: 'boolean', value };
        if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
        break;
      }
      case 'Identifier':
        return scope.get(node.name) ?? this.unresolved(node);
      case 'TemplateLiteral': {
        const text = staticKey(node, true);
        if (text !== undefined) return { type: 'string', value: text };
        break;
      }
      case 'UnaryExpression':
        if (['-', '+'].includes(node.operator) && node.argument.type === 'Literal'
          && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) {
          return { type: 'number', value: node.operator === '-' ? -node.argument.value : node.argument.value };
        }
        break;
      case 'ObjectExpression': {
        const entries = copyEntries({});
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') {
            const value = this.read(property.argument, scope);
            if (value.type === 'object') Object.assign(entries, value.entries);
            else this.structuralWarnings++;
            continue;
          }
          const key = staticKey(property.key, property.computed);
          if (key === undefined || (key === '__proto__' && !property.computed && !property.method
            && !property.shorthand && property.kind === 'init')) {
            this.structuralWarnings++;
            continue;
          }
          entries[key] = property.kind === 'init' ? this.read(property.value, scope) : this.unresolved(property);
          this.onProperty?.(property, entries[key]);
        }
        return { type: 'object', entries };
      }
      case 'ArrayExpression': {
        const items: StaticValue[] = [];
        for (const item of node.elements) {
          if (!item) items.push({ type: 'hole' });
          else if (item.type !== 'SpreadElement') items.push(this.read(item, scope));
          else {
            const value = this.read(item.argument, scope);
            if (value.type !== 'array') {
              this.structuralWarnings++;
              return this.unresolved(node);
            }
            for (const element of value.items) items.push(element);
          }
        }
        return { type: 'array', items };
      }
    }
    return this.unresolved(node);
  }

  bind(statement: Statement | ModuleDeclaration, scope: Scope): void {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') return;
    for (const { id, init } of declaration.declarations) {
      if (id.type === 'Identifier' && init) scope.set(id.name, this.read(init, scope));
    }
  }

  merchantReturn(node: Expression, scope: Scope): StaticValue {
    if (node.type !== 'FunctionExpression' && node.type !== 'ArrowFunctionExpression') {
      return this.read(node, scope);
    }
    const local = new Map(scope);
    for (const param of node.params) if (param.type === 'Identifier') local.delete(param.name);
    const readReturned = (returned: Expression) => {
      if (returned.type === 'CallExpression' && memberName(returned.callee) === 'JSON.stringify'
        && returned.arguments.length === 1 && returned.arguments[0].type !== 'SpreadElement' && !local.has('JSON')) {
        return this.read(returned.arguments[0], local);
      }
      return this.read(returned, local);
    };
    if (node.body.type !== 'BlockStatement') return readReturned(node.body);
    for (const statement of node.body.body) {
      if (statement.type === 'ReturnStatement' && statement.argument) return readReturned(statement.argument);
      if (statement.type === 'VariableDeclaration') this.bind(statement, local);
      else if (statement.type !== 'EmptyStatement' && !(statement.type === 'ExpressionStatement' && statement.directive)) {
        return this.unresolved(node);
      }
    }
    return this.unresolved(node);
  }
}

const roots = new Set(['config', 'configuration', 'hyperpayConfig', 'merchantConfig', 'Config']);
const assignmentRoots = new Set([
  ...roots, 'module.exports', 'window.configuration', 'window.hyperpayConfig',
  'window.merchantConfig', 'globalThis.configuration'
]);
const merchantGetters = new Set(['window.getMerchantConfig', 'globalThis.getMerchantConfig', 'getMerchantConfig']);

function readProgram(program: Program, reader: LiteralReader): StaticValue | undefined {
  const scope: Scope = new Map();
  let candidate: StaticValue | undefined;
  let explicitRoot = false;
  for (const statement of program.body) {
    reader.bind(statement, scope);
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration;
      if (declaration.type !== 'FunctionDeclaration' && declaration.type !== 'ClassDeclaration') {
        candidate = reader.read(declaration, scope);
        explicitRoot = true;
      }
    } else if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const specifier of statement.specifiers) {
        const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
        if ((name === 'default' || typeof name === 'string' && roots.has(name)) && specifier.local.type === 'Identifier') {
          candidate = scope.get(specifier.local.name);
          explicitRoot = true;
        }
      }
    } else if (statement.type === 'ExpressionStatement') {
      const expression = statement.expression;
      if (program.body.length === 1 && (expression.type === 'ObjectExpression' || expression.type === 'ArrayExpression')) {
        return reader.read(expression, scope);
      }
      if (expression.type !== 'AssignmentExpression' || expression.left.type === 'ObjectPattern'
        || expression.left.type === 'ArrayPattern' || expression.left.type === 'RestElement' || expression.left.type === 'AssignmentPattern') continue;
      const name = memberName(expression.left);
      if (!name) continue;
      if ([...assignmentRoots].some(root => name.startsWith(root + '.'))) {
        throw new Error('Incremental configuration property assignments are unsupported.');
      }
      if (expression.operator !== '=') continue;
      if (merchantGetters.has(name)) {
        candidate = reader.merchantReturn(expression.right, scope);
        explicitRoot = true;
      } else if (assignmentRoots.has(name)) {
        candidate = reader.read(expression.right, scope);
        if (expression.left.type === 'Identifier') scope.set(name, candidate);
        explicitRoot = true;
      } else if (expression.left.type === 'Identifier' && scope.has(name)) {
        scope.set(name, reader.read(expression.right, scope));
      }
    }
  }
  if (explicitRoot) return candidate;
  const bindings = [...roots].filter(name => scope.has(name));
  if (bindings.length === 1) return scope.get(bindings[0]);
}

export function parseConfiguration(source: string): ParsedConfig {
  let text = source.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('Empty hyperpay-config response.');
  if (text.startsWith('{') || text.startsWith('[')) {
    let json: Json | undefined;
    try { json = JSON.parse(text) as Json; } catch { /* JavaScript configuration follows the AST path. */ }
    if (json !== undefined) return { tree: fromJson(json), structuralWarnings: 0 };
    if (text.startsWith('{')) text = `(${text.replace(/;\s*$/, '')}\n)`;
  }
  let program: Program;
  try {
    program = parseScript(text);
  } catch (error) {
    const { loc } = error as { loc?: { line: number; column: number } };
    throw new Error(loc ? `Invalid JavaScript at line ${loc.line}, column ${loc.column + 1}.` : 'JavaScript could not be parsed.');
  }
  const reader = new LiteralReader(text);
  const tree = readProgram(program, reader);
  if (tree?.type !== 'object' && tree?.type !== 'array') {
    throw new Error('No supported static configuration declaration found.');
  }
  const main = tree.type === 'object' && tree.entries.mainConfig;
  if (main && main.type !== 'object') reader.structuralWarnings++;
  return { tree, structuralWarnings: reader.structuralWarnings };
}

function fromJson(value: Json): StaticValue {
  if (value === null) return { type: 'null', value };
  if (Array.isArray(value)) return { type: 'array', items: value.map(fromJson) };
  switch (typeof value) {
    case 'object': return { type: 'object', entries: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fromJson(child)])) };
    case 'boolean': return { type: 'boolean', value };
    case 'string': return { type: 'string', value };
    case 'number':
      return Number.isFinite(value) ? { type: 'number', value }
        : { type: 'unresolved', expression: String(value), syntax: 'javascript' };
  }
}

export function toJson(value: StaticValue): Json {
  switch (value.type) {
    case 'object': return Object.fromEntries(Object.entries(value.entries).map(([key, child]) => [key, toJson(child)]));
    case 'array': return value.items.map(toJson);
    case 'hole': return null;
    case 'unresolved': return { unresolved: value.expression, syntax: value.syntax };
    default: return value.value;
  }
}

export function asConfigReaderValue(value: StaticValue): StaticValue {
  if (value.type !== 'object') return value;
  const keys = Object.keys(value.entries);
  if (keys.length !== 1 || !/^#[A-Za-z]/.test(keys[0])) return value;
  const literal = toJson(value);
  return { type: 'unresolved', expression: keys[0], syntax: 'config-reader', literal };
}
