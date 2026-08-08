## What and why

<!-- What changes, and what problem it solves. Link the Pine ticket id if there is one. -->

## Contract seams

<!-- Delete if untouched. These four files are FROZEN contracts; changing one ripples to
     both processes and to the drift tests. -->

- [ ] `src/shared/schema.ts` (data model)
- [ ] `src/shared/channels.ts` (control plane)
- [ ] `src/shared/jobs.ts` (streaming jobs)
- [ ] `src/preload/index.ts` (bridge)

## Verification

<!-- Paste the actual output, not a claim. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:e2e` (if the change is user-facing)

**For a bugfix:** which new test fails without this change?
