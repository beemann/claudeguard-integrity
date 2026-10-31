import ts from "typescript";

/**
 * Where code reaches its host environment BY NAME: every use of a global, and every
 * `import.meta`. The input to the allowlist mode of `purity-closure`.
 *
 * A denylist asks "is this spelling forbidden?", and every other spelling of the
 * same thing passes — `globalThis.Date.now()`, `Date["now"]()`, `const D = Date`.
 * This module asks the question those spellings cannot dodge: which names in this
 * file are NOT declared in it? However `Date` is reached, the path starts at the
 * undeclared name `Date` or `globalThis`, and that start is what gets reported.
 *
 * "Declared" is the TypeScript binder's answer, not a hand-written scope walk: block
 * scoping, hoisting, shadowing, destructuring and catch clauses are its job, and a
 * second implementation of them here would be a second definition of scope. Each file
 * is bound in a program of its own, with no default library and no module
 * resolution — so nothing outside the file can declare a name for it, which is what
 * a module's scope means at run time. A name declared only with `declare` emits no
 * code, so it still counts as a global.
 *
 * Out of reach of any static check, and not claimed: reflective routes that never
 * name a global (`[].constructor.constructor("…")`), and methods on values that read
 * the host (`toLocaleString`). The threat model is honest drift, not an adversary
 * with commit access — who could simply change the decision.
 */

/** One use of a global, located. */
export interface AmbientReference {
  /** The global's name; `import.meta` for a module-metadata read. */
  readonly name: string;
  /**
   * The member read through it when the use is exactly `name.member` or
   * `name["member"]`, and undefined for every other use — an alias, a computed key,
   * an argument, a bare call.
   */
  readonly member: string | undefined;
  readonly node: ts.Node;
}

/**
 * A checker over `sf` alone. Nothing is read from disk: the host serves the one file
 * it was given and answers "absent" for everything else, including the default
 * library, so no declaration outside `sf` exists to resolve against.
 */
function bindingChecker(sf: ts.SourceFile): ts.TypeChecker {
  const own = sf.fileName.replaceAll("\\", "/");
  const isOwn = (name: string): boolean => name.replaceAll("\\", "/") === own;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (isOwn(name) ? sf : undefined),
    fileExists: isOwn,
    // The program is only ever bound and queried, never emitted or asked to read.
    readFile: () => undefined,
    writeFile: () => undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    allowJs: true,
  };
  return ts.createProgram([sf.fileName], options, host).getTypeChecker();
}

/** Does `node` itself carry the `declare` modifier? */
function hasDeclareModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

/**
 * Is `node` inside an ambient context — under a `declare` (which on a variable sits on
 * its statement, two levels up) or in a declaration file? Nothing there emits code.
 */
function isAmbient(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) {
      return current.isDeclarationFile;
    }
    if (hasDeclareModifier(current)) {
      return true;
    }
  }
  return false;
}

/** Does `symbol` have a declaration that emits code in this file? */
function hasRuntimeDeclaration(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((declaration) => !isAmbient(declaration));
}

/** A lower-case JSX tag is an intrinsic element, not a reference to a binding. */
function isIntrinsicTag(id: ts.Identifier): boolean {
  const parent = id.parent;
  const isTag =
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === id;
  return isTag && /^[a-z]/.test(id.text);
}

/**
 * Identifiers that are names rather than references: a member after a dot, a label,
 * an import or export binding, the key side of a destructuring, an import attribute,
 * a JSX attribute or intrinsic tag. The binder resolves none of them to a binding, so
 * without this list each would read as an undeclared name.
 */
function isNonReferenceName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isQualifiedName(parent) && parent.right === id) ||
    (ts.isBindingElement(parent) && parent.propertyName === id) ||
    ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) &&
      parent.label === id) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isNamespaceExport(parent) ||
    ts.isImportAttribute(parent) ||
    (ts.isJsxAttribute(parent) && parent.name === id) ||
    isIntrinsicTag(id)
  );
}

/** Is `node` the `extends` expression of a class — the one type-shaped runtime value? */
function isClassExtends(node: ts.ExpressionWithTypeArguments): boolean {
  const clause = node.parent;
  return (
    ts.isHeritageClause(clause) &&
    clause.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(clause.parent)
  );
}

/** The member read through `node`, when it is used exactly as `node.member` / `node["member"]`. */
function memberReadThrough(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text;
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === node &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return parent.argumentExpression.text;
  }
  return undefined;
}

/** Every use of a global, and every `import.meta`, in the code `sf` emits. */
export function ambientReferences(sf: ts.SourceFile): AmbientReference[] {
  if (sf.isDeclarationFile) {
    return [];
  }
  const checker = bindingChecker(sf);
  const found: AmbientReference[] = [];
  const reference = (name: string, node: ts.Node): void => {
    found.push({ name, member: memberReadThrough(node), node });
  };
  const visit = (node: ts.Node): void => {
    // `declare …` emits no code, so nothing inside it runs. The walk starts at the
    // file, so pruning at the first `declare` covers everything under it.
    if (hasDeclareModifier(node)) {
      return;
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      // `class K extends Date` reads `Date` at run time; `implements X` does not.
      if (isClassExtends(node)) {
        visit(node.expression);
      }
      return;
    }
    // Types are erased at build.
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isMetaProperty(node)) {
      if (node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        reference("import.meta", node);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (!isNonReferenceName(node)) {
        const parent = node.parent;
        // `{ fetch }` declares a property AND reads the binding `fetch`; the binder
        // answers the first question unless asked the second explicitly.
        const symbol =
          ts.isShorthandPropertyAssignment(parent) && parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(node);
        if (!hasRuntimeDeclaration(symbol)) {
          reference(node.text, node);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
