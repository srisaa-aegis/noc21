# e2e — browser suite

`smoke.mjs` drives the real portal in Chromium (Playwright) against the running backend and
checks all three portals (64 checks):

- **B1** — sign-in, dashboards, detail and print pages, the reference cache (no bundle refetched on
  a second visit), the httpOnly refresh cookie, silent refresh, the deactivated account;
- **B2** — the citizen journey (upload from the wizard, online payment, confirmation with
  undertakings, submission and numbering, revision history, one-time download links),
  registration with the e-mailed **"set your password" link**, forgot password;
- **B3** — the **Section Note** with the **"challan verified"** tick, every officer of the workflow
  (through the API, `scripts/lib/workflow.mjs`), the **final decision** in the browser with the live
  preview and the **signed NOC** upload, the citizen seeing and printing the NOC, a report exported as
  **CSV**, the admin **statuses** (add and remove), the **audit** trail, the escalation preview, the
  unassigned tasks; the DG's audit page and a district officer's jurisdictional reports.

```bash
npm start            # in one shell: API :3000 + Angular :4200
npm run test:e2e     # in another
```

Each part runs on its own: a failure is reported with a screenshot under `/tmp/e2e-*.png` and the
other parts still run. The suite adds applications, a citizen and audit entries to the
development database; `npm run dev:reset-demo -- --yes --i-understand-this-deletes-data` removes them.

It uses the Chromium that Playwright already has (`PLAYWRIGHT_BROWSERS_PATH`); the
`@playwright/test` version is pinned to the 1.56 line so it matches that build.
