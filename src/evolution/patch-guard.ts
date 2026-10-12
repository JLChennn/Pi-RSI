import ts from 'typescript';

export const POLICY_FILE = 'src/harness/recovery-policy.ts';
export type EvolutionProposal = {
  decision: 'PATCH' | 'NO_CHANGE'; failureMode: string; evidence: string[]; hypothesis: string;
  targetFile: string; patch?: { oldText: string; newText: string }; expectedBenefit: string; risks: string[];
};
export const normalizeSource = (source: string) => source.replace(/\r\n/g, '\n');

export function parseProposal(value: unknown): EvolutionProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Proposal must be an object');
  const data = value as Record<string, unknown>;
  const allowed = ['decision', 'failureMode', 'evidence', 'hypothesis', 'targetFile', 'patch', 'expectedBenefit', 'risks'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unknown Proposal field');
  if (!['PATCH', 'NO_CHANGE'].includes(String(data.decision))) throw new Error('Invalid decision');
  for (const key of ['failureMode', 'hypothesis', 'targetFile', 'expectedBenefit'])
    if (typeof data[key] !== 'string' || !(data[key] as string).trim() || (data[key] as string).length > 4000)
      throw new Error(`Invalid ${key}`);
  for (const key of ['evidence', 'risks'])
    if (!Array.isArray(data[key]) || (data[key] as unknown[]).length > 30 ||
        (data[key] as unknown[]).some(item => typeof item !== 'string' || item.length > 2000)) throw new Error(`Invalid ${key}`);
  if (!(data.evidence as string[]).length) throw new Error('Evidence is required');
  if (data.targetFile !== POLICY_FILE) throw new Error('Target is outside exact file whitelist');
  if (data.decision === 'NO_CHANGE') {
    if (data.patch !== undefined) throw new Error('NO_CHANGE cannot include a patch');
  } else {
    const patch = data.patch as Record<string, unknown> | undefined;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length !== 2 ||
        !Object.hasOwn(patch, 'oldText') || !Object.hasOwn(patch, 'newText') ||
        typeof patch.oldText !== 'string' || !patch.oldText || typeof patch.newText !== 'string' || !patch.newText ||
        patch.oldText.length > 12000 || patch.newText.length > 12000) throw new Error('Invalid exact replacement patch');
  }
  return data as EvolutionProposal;
}

export function applyReplacement(source: string, proposal: EvolutionProposal): string {
  if (proposal.decision !== 'PATCH' || !proposal.patch) throw new Error('No patch to apply');
  const original = normalizeSource(source);
  const oldText = normalizeSource(proposal.patch.oldText);
  const newText = normalizeSource(proposal.patch.newText);
  const first = original.indexOf(oldText);
  if (first < 0 || original.indexOf(oldText, first + oldText.length) >= 0) throw new Error('Replacement must match exactly once');
  const result = original.slice(0, first) + newText + original.slice(first + oldText.length);
  if (result === original) throw new Error('PATCH did not change source');
  return result;
}

/** Deliberately small expression language, not a general JavaScript safety claim. */
export function guardPolicy(baseline: string, candidate: string): void {
  const parse = (source: string) => {
    const diagnostics = ts.transpileModule(source, { reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).diagnostics ?? [];
    if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('Invalid TypeScript syntax');
    return ts.createSourceFile(POLICY_FILE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  };
  const before = parse(baseline); const after = parse(candidate);
  const compact = (node: ts.Node) => node.getText().replace(/\s/g, '');
  const types = (file: ts.SourceFile) => file.statements.filter(ts.isTypeAliasDeclaration).map(compact);
  if (JSON.stringify(types(before)) !== JSON.stringify(types(after))) throw new Error('Exported types changed');
  if (after.statements.length !== 3 || after.statements.filter(ts.isTypeAliasDeclaration).length !== 2)
    throw new Error('Only original two types and one function are permitted; no imports or top-level effects');
  const fn = after.statements.find(ts.isFunctionDeclaration);
  if (!fn || fn.name?.text !== 'decideRecovery' || !fn.body || fn.asteriskToken || fn.typeParameters ||
      fn.modifiers?.length !== 1 || fn.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword ||
      fn.parameters.length !== 1 || !fn.type || fn.type.getText() !== 'RecoveryDecision') throw new Error('Function signature changed');
  const param = fn.parameters[0]!;
  if (!ts.isIdentifier(param.name) || param.type?.getText() !== 'ToolFailure' || param.initializer ||
      param.questionToken || param.dotDotDotToken || param.modifiers) throw new Error('Parameter signature changed');
  const argument = param.name.text;
  const locals = new Set<string>();
  const fields = new Set(['errorCode', 'message', 'attempt', 'maxAttempts', 'retrySafe']);
  const operators = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);
  const reject = (node: ts.Node): never => { throw new Error(`Forbidden AST node: ${ts.SyntaxKind[node.kind]}`); };
  const expression = (node: ts.Expression): void => {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return;
    if (ts.isIdentifier(node)) { if (locals.has(node.text)) return; return reject(node); }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === argument && fields.has(node.name.text)) return;
      return reject(node);
    }
    if (ts.isParenthesizedExpression(node)) return expression(node.expression);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return expression(node.operand);
    if (ts.isBinaryExpression(node) && operators.has(node.operatorToken.kind)) { expression(node.left); expression(node.right); return; }
    if (ts.isConditionalExpression(node)) { expression(node.condition); expression(node.whenTrue); expression(node.whenFalse); return; }
    if (ts.isObjectLiteralExpression(node) && node.properties.length === 1) {
      const property = node.properties[0]!;
      if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'action') return reject(node);
      expression(property.initializer); return;
    }
    if (ts.isCallExpression(node) && !node.typeArguments && node.arguments.length === 1 &&
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes' &&
        ts.isArrayLiteralExpression(node.expression.expression) && node.expression.expression.elements.length <= 16 &&
        node.expression.expression.elements.every(ts.isStringLiteral)) { expression(node.arguments[0]!); return; }
    return reject(node);
  };
  const statement = (node: ts.Statement): void => {
    if (ts.isBlock(node)) { for (const child of node.statements) statement(child); return; }
    if (ts.isIfStatement(node)) { expression(node.expression); statement(node.thenStatement); if (node.elseStatement) statement(node.elseStatement); return; }
    if (ts.isReturnStatement(node) && node.expression) return expression(node.expression);
    if (ts.isVariableStatement(node) && !node.modifiers && node.declarationList.flags === ts.NodeFlags.Const) {
      for (const item of node.declarationList.declarations) {
        if (!ts.isIdentifier(item.name) || item.name.text === argument || locals.has(item.name.text) || !item.initializer || item.type)
          return reject(item);
        expression(item.initializer); locals.add(item.name.text);
      }
      return;
    }
    return reject(node);
  };
  statement(fn.body);
}
