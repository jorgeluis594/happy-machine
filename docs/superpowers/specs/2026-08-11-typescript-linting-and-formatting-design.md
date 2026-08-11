# TypeScript Linting and Formatting Design

## Goal

Add one project-level quality command that checks TypeScript code quality with ESLint and repository formatting with Prettier. The setup must follow the current community-supported configuration style and fit the project's ESM, strict TypeScript, and Node.js configuration.

## Tooling

- ESLint uses Flat Config through `eslint.config.js`.
- `@eslint/js` supplies the recommended JavaScript rules.
- `typescript-eslint` supplies `recommendedTypeChecked` rules and obtains type information through `parserOptions.projectService`.
- Prettier owns formatting. Its configuration keeps Prettier's defaults rather than introducing project-specific cosmetic choices.
- ESLint does not enable stylistic presets that duplicate Prettier's responsibility.

## Files and Scope

The change adds an ESLint configuration, a Prettier configuration, and a Prettier ignore file. It updates `package.json` and `package-lock.json` with the required development dependencies and scripts.

ESLint checks the repository's JavaScript and TypeScript configuration and source files while ignoring generated artifacts and dependencies. Prettier checks supported code and root configuration files while ignoring documentation, dependencies, build output, coverage output, and local generated runtime state. Documentation is excluded so adopting the formatter does not rewrite existing prose.

## Commands

- `npm run lint` runs `eslint .` followed by `prettier . --check`. A failure from either tool makes the command fail.
- `npm run lint:fix` runs `eslint . --fix` followed by `prettier . --write`.

These scripts provide one read-only validation command and one explicit mutation command. No separate command is required for CI to validate formatting.

## Validation

The implementation is complete when all of the following pass:

1. `npm run lint`
2. `npm test`
3. `npm run typecheck`

The linter must also successfully resolve type information for the TypeScript files already included by the project configuration.

## Non-goals

- Reformatting unrelated project files as part of installation.
- Adding import-sorting plugins or third-party style guides.
- Changing TypeScript compiler options, application architecture, or product behavior.
- Adding CI configuration.
