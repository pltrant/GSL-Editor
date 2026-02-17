# AGENTS

## Communication Preferences for Agents

- Be concise and direct.
- Make the requested change end-to-end rather than stopping at
  analysis.
- If a preference is ambiguous, choose the simplest implementation that
  matches these notes.

## Writing Code

- After code changes, always run:
  - `npm run format`
- After formatting, verify the code compiles by running:
  - `npm run compile`

## Reviewing Code

- Verify the code compiles.
- Verify there is no prettier diff.
- Ensure the code adheres to the standards in this file, including the
  rules under `Writing Code`.

### Scope Discipline

- Avoid touching code that is unrelated to the current task and
  untouched by the work in progress.
- Keep edits tightly scoped to the files/paths required for the
  request.
- Treat refactors as an explicit decision: do not perform broad or
  opportunistic refactors unless the developer and agent have clearly
  agreed to do so.
- Keep `extension.ts` thin. New feature logic should live in focused
  modules (for example under `gsl/commands/`) with `extension.ts`
  delegating to those modules.

### Type & Parameter Preferences

- Inline parameter object types when they are only used in one place.
- Extract a named interface/type only when the shape is reused in
  multiple places.
- Prefer destructuring for parameters and object reads where it
  improves clarity and removes repetitive access.

### Control Flow Preferences

- Prefer direct, traditional control flow over callback-heavy designs.
- Avoid introducing callbacks that create unnecessary inversion of
  control when straightforward sequencing is possible.
- Pass concrete values/results rather than function callbacks when
  practical.
- Callbacks are acceptable when they are idiomatic or required (for
  library APIs, event handlers, async framework hooks, or genuinely
  generic behavior).
- If callbacks are used, keep them small, obvious, and localized.

### Naming Preferences (General)

- Prefer names that match behavior and return shape, not implementation
  history.
- Use explicit suffixes for specialized variants.
  - Example pattern: use `fetchX()` for the base/raw fetch and
    `fetchXDiff()` for compare/diff workflows.
- Avoid pairs where both names sound like raw fetches but one actually
  computes comparison output.
- When renaming, update all call sites for consistency in one pass.

### Examples

#### 1) Imports: avoid aliasing unless required

Prefer:

```ts
import { fetchResource } from "./services/resourceService";
```

Avoid unless necessary for real conflicts:

```ts
import { fetchResource as fetchResourceViaService } from "./services/resourceService";
```

#### 2) Dependencies: prefer primitives over function providers

Prefer:

```ts
interface Dependencies {
  downloadLocation: string;
}
```

Avoid when a value is already available:

```ts
interface Dependencies {
  getDownloadLocation: () => string;
}
```

#### 3) Preconditions: validate in caller when practical

Prefer caller-owned preconditions before invoking a shared service:

```ts
await waitForConnectionToSettle();
return fetchResourceDiff(id, localDocument, deps);
```

Instead of injecting precondition callbacks into service dependencies.

#### 4) Cleanup loop after refactors

After deleting or moving code:

1. Check symbol usages.
2. Remove newly-unused helpers/wrappers.
3. Repeat usage check until stable.

This avoids leaving stale wrappers behind after incremental refactors.


## Testing

- Run tests with:
  - `npm run test`
- Use this command as the default test workflow for this repository.

## Commit Messages

- Keep the subject line to 54 characters or fewer.
- Use tags to indicate whether something is a feature, bugfix, tech debt, etc.
- Include a short body that summarizes:
  - what changed
  - newly exposed tools/features/etc
  - important decisions/tradeoffs (if applicable)
- Wrap commit message body text at 70 characters.

## Updating Changelog

- When asked to update the changelog, follow the existing style and
  structure in `CHANGELOG.md`.
- Keep entries consistent with existing headings and tone.
- Mark internal-only changes clearly when they do not affect extension
  consumers.
