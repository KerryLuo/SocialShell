# SocialShell

Team 3 · `hacktoberfest_oct_2027`

A mobile-first campus discovery demo built with Next.js App Router, TypeScript, Tailwind CSS, and native Pointer Events. One app, one dev command, no login or database.

## Run it

Use **Node.js 22 LTS** (Next.js requires Node 20.9+).

```sh
npm install
npm run dev
```

Open http://localhost:3000. No environment variables are needed for demo mode.

```sh
npm run build          # production build
npm start              # serve the production build
npm run typecheck
npm test               # validation and local-storage tests
npx playwright install chromium webkit  # first time only, for browser checks
npm run test:e2e        # starts its own production server on port 3100; build first
```

## What works

- **Home (`/`):** a welcome screen with your profile greeting, live discovery/saved counts, and links to start discovering or visit saved finds.
- **Discover (`/discover`):** a dedicated swipe screen with eight fictional UMD-themed groups/events; All / Groups / Events filters; drag horizontally or use Pass / Interested. A 90px horizontal drag commits; short and cancelled gestures reset. `touch-action: pan-y` preserves normal vertical touch scrolling.
- **Create:** editable manual group/event forms; required fields checked before publishing. New cards appear first in Discover. Events require title, location, date and time; groups require name and description. Campus times use America/New_York.
- **AI prefill:** paste an announcement and review editable drafts one at a time. Prefill never publishes. Unknown information stays blank. Selecting a new draft or switching type replaces the unsaved form.
- **Profile:** one editable demo student with an initials avatar, bio, major, interests and availability.
- **Saved:** interested bookmarks with remove actions. A bookmark is **not** membership or registration. Removing a saved card marks it passed so it stays out of discovery.
- **Flyer preview:** JPEG / PNG / WebP up to 3 MB, previewed locally. Image extraction is deliberately unavailable; files are never uploaded or attached to published cards.
- **Reset demo:** confirmation restores seeds and clears this app’s profile edits, created cards and decisions. It touches only `terplink.demo.v1`, never unrelated localStorage keys.

### Local data and demo mode

All profiles, groups, events and swipe decisions live in **localStorage in each browser**. They are not shared across devices, accounts, browsers or people. There is no backend publishing database. Seed data initializes once per browser. Browser storage must be enabled; storage failures show errors instead of pretending a save worked.

Seed cards carry **DEMO DATA** labels. They and their scheduled dates are fictional examples, not live campus listings. This project is not affiliated with UMD.

With Snowflake unconfigured, **Load sample announcement → Prefill with AI** returns two explicitly labeled, prewritten sample drafts. This is not an AI call or a parser. Only the exact supplied announcement (ignoring outer whitespace) gets that response. Arbitrary text gets a configuration-required error. Configured Snowflake errors never silently fall back to samples.

## Optional Snowflake text extraction

To align the existing `LIFEDATA.MAIN` tables with the web forms, see
[the database migration guide](./sql/README.md). This prepares the schema;
database-backed discovery and publishing are not yet connected.

1. Use an existing Snowflake account, user, and warehouse. Copy `.env.example` to `.env.local`, which is ignored by Git.
2. Fill in account identifier, username, warehouse, and role. The account is usually `organization-account`; use the identifier from Snowsight, not a URL.
3. Prefer **key-pair authentication**: register the public key on the user and put the private PKCS#8 PEM key outside the repository. Set its absolute path in `SNOWFLAKE_PRIVATE_KEY_PATH`; optionally set its passphrase. Key authentication takes priority. The alternative password variable works only if the account authentication policy permits it; MFA/SSO requirements can prevent unattended password login.
4. Have an administrator grant appropriate access. The example below uses existing objects; substitute your own identifiers. Do not give the app ACCOUNTADMIN.

```sql
USE ROLE ACCOUNTADMIN;
CREATE ROLE IF NOT EXISTS TERPLINK_DEMO;
GRANT USAGE ON WAREHOUSE YOUR_WAREHOUSE TO ROLE TERPLINK_DEMO;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE TERPLINK_DEMO;
GRANT USE AI FUNCTION AI_COMPLETE ON ACCOUNT TO ROLE TERPLINK_DEMO;
GRANT ROLE TERPLINK_DEMO TO USER YOUR_USER;
```

5. Choose an available text model supporting structured output. The default, `llama3.3-70b`, is demonstrated in Snowflake’s documentation. Model lifecycle, account/region availability and model access can vary: inspect `SHOW CORTEX BASE MODELS;` and confirm your role can use the model. An administrator may need a model application-role grant or an appropriate model allowlist. Configure `SNOWFLAKE_MODEL` rather than changing source code.
6. Test with the same role and warehouse in Snowsight, then restart `npm run dev` after updating the environment:

```sql
USE ROLE TERPLINK_DEMO;
USE WAREHOUSE YOUR_WAREHOUSE;
SELECT AI_COMPLETE(
  model => 'llama3.3-70b',
  prompt => 'Extract a title from: Board game night at Stamp.',
  response_format => {
    'type': 'json',
    'schema': {
      'type': 'object',
      'additionalProperties': false,
      'properties': {'title': {'type': 'string'}},
      'required': ['title']
    }
  },
  show_details => FALSE
);
```

No application database, schema, tables, or stage are required for text extraction. Snowflake calls incur the account’s applicable compute/inference charges. The pasted text goes to Snowflake only when configured; local form submission remains local.

### Integration details

`lib/server/snowflake.ts` is marked `server-only`. `/api/prefill` runs in the Node.js runtime. Model and prompt use SQL binds; the schema is a trusted SQL object literal. The text form of `AI_COMPLETE` uses a structured `response_format` and `show_details => FALSE`. Server validation checks field types, lengths, array sizes and date/time validity. Uncertain/invalid dates and times remain blank with review notes. The prompt treats pasted text as untrusted data, including instructions embedded in it; people still review every field before publishing.

Requests are limited to 8,000 characters and a 40KB JSON body. The Snowflake operation has a 30-second deadline; query cancellation and connection cleanup are attempted on timeout. Errors use generic messages and never return driver diagnostics, SQL or secrets. SDK logging is disabled. No `NEXT_PUBLIC_*` credentials are used.

Official references used for implementation:

- [AI_COMPLETE single-string signature and return type](https://docs.snowflake.com/en/sql-reference/functions/ai_complete-single-string)
- [Structured outputs and JSON schema](https://docs.snowflake.com/en/sql-reference/functions/ai_complete-structured-outputs)
- [Node.js authentication and key pairs](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-authenticate)
- [Cortex privileges and model access](https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-privileges-and-access)

### Image extraction: deferred stretch goal

There is no image endpoint, stage or vision integration in this skeleton. Do not claim the preview extracts anything. A future version would need a configured internal stage with server-side encryption, stage READ/WRITE permissions, generated filenames, server-side upload, `TO_FILE`, an available vision model, validated output and temporary/staged file cleanup. Verify the current vision signature independently: the prompt-object form does not share the text form’s structured-output parameters. See [AI_COMPLETE prompt objects](https://docs.snowflake.com/en/sql-reference/functions/ai_complete-prompt-object).

## Small project map

```text
app/                   Home, Discover, Create, Saved, Profile; shared layout/styles
app/api/prefill/        One server endpoint
components/            Card, swipe gesture, navigation, forms, data provider
lib/types.ts           Shared data types
lib/storage.ts         One localStorage key, initialization, persistence
lib/seeds.ts           Eight fictional campus cards and one profile
lib/sample.ts          Exact sample announcement and prewritten drafts
lib/validation.ts      Form and untrusted model-output validation
lib/server/            Snowflake service and extraction schema/prompt
tests/                 Unit tests and browser flow checks
```

This is a hackathon demo, not a public production service. Authentication, account sharing, registration, messaging, recommendations and a production database are out of scope. The prefill endpoint has bounded input but no per-user authentication or distributed rate limiting.

## Two-minute demo

1. **0:00–0:20:** Start on Home, then tap Start discovering. Point out fictional demo cards, groups/events filters, and browser-local data. Pass one card and save another with Interested.
2. **0:20–0:35:** Open Saved. Explain that Interested is a bookmark, not registration. Remove a saved card.
3. **0:35–0:55:** Open Profile. Change the name/interests, save, and reload to show persistence.
4. **0:55–1:15:** Open Create, choose a group, enter a name and description, publish, and show the new card first in Discover.
5. **1:15–1:45:** Return to Create. Load the sample announcement, prefill, explain “Sample demo · Not an AI result,” select the event draft, review fields, and publish it. Select the hiking draft to show unknown location/meeting details remain blank. With live Snowflake configured, explain the actual source label instead.
6. **1:45–2:00:** Show the flyer preview limitation, swipe a card, then Reset demo and confirm to return to the eight seeds.

## Verification

See [VERIFICATION.md](./VERIFICATION.md) for the build/browser checks actually run and remaining device/live-integration limits.
