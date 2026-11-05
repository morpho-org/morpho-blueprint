// @vitest-environment node
/**
 * Repository guard: the app reads Morpho's Core REST API only, so Morpho GraphQL must not come back.
 *
 * Fails when one of these returns:
 * - a GraphQL endpoint, module or client in the code of `src/` or `next.config.ts`: any string, template
 *   or regex literal containing "graphql", or an identifier named `gql`, `executeMorphoQuery` or containing
 *   "graphql" (covers `/graphql` URLs on any host, `gql`/`graphql(` tagged queries and GraphQL imports);
 * - a read of `MORPHO_API_URL`, the former GraphQL endpoint, outside the config module;
 * - a GraphQL dependency in package.json, or a script mentioning GraphQL;
 * - a GraphQL schema snapshot, generated client or codegen config.
 *
 * Comments are not scanned: they may explain the migration. ALLOWED lists the deliberate exceptions, each
 * matched by exact source text in one file; an entry that matches nothing fails too, so the list stays narrow.
 *
 * The same file runs in morpho-blueprint and blueprint-anchorage: keep both copies identical.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

const ALLOWED: readonly { file: string; text: string; why: string }[] = [
  {
    file: "src/common/utils/morphoApiConfig.ts",
    text: '"MORPHO_API_URL"',
    why: "Deployments that only set the former GraphQL endpoint keep its host for Core REST.",
  },
  {
    file: "src/common/utils/morphoApiConfig.ts",
    text: "graphqlUrl",
    why: "The local variable holding that legacy MORPHO_API_URL value.",
  },
  {
    file: "src/common/utils/morphoApiConfig.ts",
    text: "/\\/graphql$/",
    why: "Strips the /graphql path from MORPHO_API_URL to get the Core REST host.",
  },
];

const SCANNED_ROOTS = ["src", "next.config.ts"];
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FORBIDDEN_PATHS = [
  "schema/morpho-api.graphql",
  "src/generated/gql",
  "codegen.ts",
  "codegen.yml",
  "codegen.yaml",
  "graphql.config.ts",
  "graphql.config.yml",
];
const GRAPHQL_FILE = /\.(graphql|gql)$/;
const GRAPHQL_DEPENDENCY = /graphql|^gql$|^@apollo\/|^@?urql(\/|$)/i;

function listFiles(relative: string): string[] {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => listFiles(path.join(relative, entry.name)));
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

function isGraphqlToken(node: ts.Node, text: string): boolean {
  if (LITERAL_KINDS.has(node.kind)) return /graphql/i.test(text) || /^["'`]MORPHO_API_URL["'`]$/.test(text);
  if (ts.isIdentifier(node)) return /graphql/i.test(text) || /^(gql|executeMorphoQuery|MORPHO_API_URL)$/.test(text);
  return false;
}

// Code tokens only: comments are trivia in the TypeScript AST, so they are never visited.
function findGraphqlTokens(file: string): { file: string; line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: { file: string; line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    const text = node.getText(source);
    if (isGraphqlToken(node, text)) {
      found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no Morpho GraphQL", () => {
  const codeFiles = SCANNED_ROOTS.flatMap(listFiles).filter((file) => CODE_FILE.test(file));
  const tokens = codeFiles.flatMap(findGraphqlTokens);
  const isAllowed = (token: { file: string; text: string }) =>
    ALLOWED.some((entry) => entry.file === token.file && entry.text === token.text);

  it("scans the app's code", () => {
    expect(codeFiles.length).toBeGreaterThan(100);
  });

  it("has no GraphQL endpoint, client, query or MORPHO_API_URL read in the code", () => {
    expect(tokens.filter((token) => !isAllowed(token)).map((t) => `${t.file}:${t.line} ${t.text}`)).toEqual([]);
  });

  it("uses every allow-list entry", () => {
    const unused = ALLOWED.filter((entry) => !tokens.some((t) => t.file === entry.file && t.text === entry.text));
    expect(unused).toEqual([]);
  });

  it("has no GraphQL dependency or script in package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys(pkg[field] ?? {}),
    );
    const scripts = Object.entries<string>(pkg.scripts ?? {}).map(([name, command]) => `${name}: ${command}`);
    expect([
      ...dependencies.filter((name) => GRAPHQL_DEPENDENCY.test(name)).map((name) => `dependency ${name}`),
      ...scripts.filter((script) => /graphql|\bgql\b/i.test(script)).map((script) => `script ${script}`),
    ]).toEqual([]);
  });

  it("has no GraphQL schema snapshot, generated client or codegen config", () => {
    const found = new Set([
      ...FORBIDDEN_PATHS.filter((file) => fs.existsSync(path.join(ROOT, file))),
      ...["src", "schema"].flatMap(listFiles).filter((file) => GRAPHQL_FILE.test(file)),
    ]);
    expect([...found]).toEqual([]);
  });
});
