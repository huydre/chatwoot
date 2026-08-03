# Codebase Summary — Chatwoot (chattize fork)

**Last updated:** 2026-04-09
**Version:** 4.12.1 (per `package.json`)
**Branch:** develop

## What this is

Chatwoot — open-source, self-hosted, omnichannel customer support platform. Alternative to Intercom/Zendesk. Ships with **Captain** AI agent, help center portal, omnichannel inbox (web chat, email, FB, IG, WhatsApp, Telegram, SMS, Line, Twitter), automations, reports.

## Stack

| Layer | Tech |
|---|---|
| Backend | Ruby 3.4.4, Rails ~7.1 |
| Frontend | Vue 3 (Composition API + `<script setup>`), Vite, Tailwind CSS |
| DB | Postgres (primary), Redis (cache/queues/pubsub) |
| Jobs | Sidekiq |
| Realtime | ActionCable |
| Search | pg_search / built-in search pipeline |
| Testing | RSpec (Ruby), Vitest (JS/Vue), Histoire (component stories) |
| Lint | RuboCop, ESLint (Airbnb + Vue3) |
| Packaging | Docker, Helm, Heroku/DO buttons |
| Process mgr | Overmind / Foreman (`Procfile.dev`) |

## Top-level layout

```
app/                Rails app code
  controllers/      api/ (v1/v2/platform), dashboard, portal, widget, integrations (google, microsoft, instagram, linear, notion)
  models/           ~51 ActiveRecord models (Account, User, Conversation, Message, Inbox, Contact, ...)
  services/         Business logic, external integrations
  builders/         Object construction / complex creation flows
  finders/          Query objects
  policies/         Pundit authorization
  jobs/             Sidekiq jobs
  listeners/        Event listeners (Wisper-style)
  dispatchers/      Event dispatch
  mailers/          ActionMailer
  mailboxes/        ActionMailbox inbound email
  channels/         ActionCable channels
  drops/            Liquid template drops
  javascript/
    dashboard/      Agent dashboard Vue SPA
    widget/         Customer-facing web widget
    portal/         Help center portal
    sdk/            Embeddable JS SDK
    survey/         CSAT survey
    v3/             Next-gen UI (in progress)
    design-system/  Shared UI primitives
    shared/         Cross-app utilities, composables (incl. useBranding)
enterprise/         EE overlay (prepend/include_mod_with extensions; EE-only features)
config/             routes, initializers, i18n (en.yml canonical), features.yml, llm.yml, integration/, languages/
db/                 migrations, schema, seeds
lib/                custom_exceptions/, rake tasks, integrations shims
spec/               RSpec tests (mirror app/ + enterprise/ overlay)
swagger/            OpenAPI specs
public/             static + built assets
components-next/    new message-bubble components (other frontend bubbles deprecated)
```

## Architecture highlights

- **Multi-tenant SaaS model**: `Account` is the tenant root; `User`s belong to accounts via `AccountUser`.
- **Omnichannel**: `Inbox` abstracts each channel type (`Channel::WebWidget`, `Channel::Email`, `Channel::Api`, `Channel::FacebookPage`, `Channel::Whatsapp`, etc.). `Conversation` + `Message` belong to an inbox.
- **Event-driven**: Dispatchers + listeners fire on model lifecycle events — used for automation rules, reporting, integrations, notifications.
- **Automation**: Rule engine on conversation events (`automation_rules`), conditions/actions configured per account.
- **Captain (AI)**: AI assistant subsystem; copilot / assistant flows referenced in recent commits (v2 handoff, assignment v2).
- **Enterprise overlay**: `enterprise/` mirrors `app/` structure. Core code should stay OSS-safe; EE extends via `prepend_mod_with` / `include_mod_with` or EE-only files. Specs under `spec/enterprise`.
- **APIs**: Public API (`/api/v1`, `/api/v2`), Platform API (super-admin), Client API (widget/portal).
- **White-labeling**: `shared/composables/useBranding` → `replaceInstallationName` for user-facing strings instead of hardcoding "Chatwoot".

## Key commands

| Action | Command |
|---|---|
| Install | `bundle install && pnpm install` |
| Dev | `overmind start -f ./Procfile.dev` or `pnpm dev` |
| Ruby tests | `bundle exec rspec spec/path/to/file_spec.rb[:LINE]` |
| JS tests | `pnpm test` / `pnpm test:watch` |
| Lint Ruby | `bundle exec rubocop -a` |
| Lint JS/Vue | `pnpm eslint:fix` |
| Seed minimal | `bundle exec rails db:seed` |
| Seed rich account | `bundle exec rails runner "Internal::SeedAccountJob.perform_now(Account.find(<id>))"` |
| Build widget SDK | `pnpm build:sdk` |

## Conventions (from CLAUDE.md)

- Vue: PascalCase components, camelCase events, Composition API + `<script setup>` **always**.
- Styling: **Tailwind only** — no custom CSS, no scoped CSS, no inline styles. Colors from `tailwind.config.js`.
- i18n: only edit `en.yml` (backend) and `en.json` (frontend); community handles translations.
- Models: validate presence/uniqueness; add proper indexes.
- Commits: Conventional Commits (`feat(auth): ...`). No "Claude" references.
- MVP focus: happy-path first, minimal guards, no speculative abstractions.
- Frontend message bubbles: use `components-next/`; the rest is deprecated.
- EE changes: always search both `app/` and `enterprise/` before editing shared logic.

## Worktree workflow (Codex)

- Separate git worktree + branch per task. Per-worktree config under `.codex/`, using `Procfile.worktree`. Dynamic DB/port allocation in `.codex/environments/environment.toml` to avoid collisions. Separate Overmind socket per worktree.

## Recent activity (top of `develop`)

- `f13f3ba44` fix: log only on system api key failures (#13968)
- `f1da7b8af` feat: enable assignment v2 by default for new accounts (#14031)
- `bd14e96ed` chore: allow article to create without content (#14007)
- `00837019b` fix(captain): display handoff message to customer in V2 flow (#13885)
- `45124c3b4` fix(i18n): improve zh-TW translation coverage and quality (#14004)

Signals: active work on **Captain v2** (AI assistant handoffs), **assignment v2** rollout, article/help-center tweaks, i18n cleanup.

## Notable config files

- `config/features.yml` — feature flag registry
- `config/llm.yml` — LLM provider config (Captain)
- `config/integration/` — per-integration setup
- `config/installation_config.yml` — installation-level settings
- `tailwind.config.js` — design tokens (colors, spacing)
- `histoire.config.ts` — component story runner
- `vite.config.ts` — frontend bundler
- `Procfile.dev` / `Procfile.worktree` — dev process orchestration
- `rubocop/` — custom cops
- `swagger/` — API contract

## Unresolved questions

- `docs/` directory did not exist before this run — no pre-existing project-overview / architecture docs to cross-reference. Should `/ck:docs init` be run next to generate the full set (PDR, architecture, roadmap, deployment, code-standards)?
- `v3/` frontend directory scope/timeline vs. `dashboard/` — migration status unclear without scanning code.
- "chattize" rename: repo is `/chattize` but code identifies as Chatwoot. Is this a white-label fork, and are there local-only diffs beyond upstream?
