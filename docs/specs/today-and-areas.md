# Today and areas: one page instead of Home + Board

Approved by the owner on 2026-11-08. PRD: C-06 (revised), §D.2–D.4, §8.4. Web only, plus one contract change.

## Why

- The zoomable board was unreadable: 1440×900 fit the overview at ~34% zoom, so 14px text rendered at ~5px (phone ~3px).
- Zooming into a zone only produced a page, without the accessible list view the PRD asked for (§D.3).
- Home and Board showed the same work sorted two ways.

## What

One page: a header, a sidebar of areas, the active area in the middle column, and the Cofounder panel on the right.

- **Header:** logo + runner dot, the command bar (it keeps the stop, offline and runner-error banners), Inbox with count, theme toggle, Sign out.
  - Gone: Home | Board, Domains | Agents, Brief, and the All | Dev | Business switch.
- **Sidebar** (`nav` "Areas", `aria-current="page"` on the active item):
  - The scope control: workspace (All | Dev | Business, in its menu when both are shown) and project.
  - The areas, each with one live status line:
    - Today: decisions waiting, incidents included.
    - Code: running runs, repositories.
    - Systems: open incidents (dot + words), failing apps, runners.
    - Business: its connector. Shown only while the Business workspace is.
    - Research: watchlists, next brief.
    - Agents: count.
    - Plans: plans and queued runs.
  - Code and Systems hide with the Dev workspace, Business with the Business workspace.
  - Talk, Settings and STOP stay visible at the bottom.
- **Area pages:** a serif title on the area's tint, the status line, then the area's content without item limits. Cards flow in a responsive grid.
  - Agents adds a "By agent" view: each agent's autonomy and tools, which replaces the old Agents grouping.
  - Automations is no longer an area: it is Settings → Automations.
- **Today** (was the Cofounder home), in this order:
  1. Setup checklist, until it is done.
  2. Headline.
  3. Waiting on you: incidents first.
  4. Running now: the runs with stage bars, then agents busy outside those runs, then "N agents idle".
  5. Repositories (Dev only).
  6. Noticed for you.
  7. KPIs (Business KPIs in the business workspace).
  8. Results this week.
  - An empty section is one line, for example "Waiting on you · nothing right now".
  - Approvals happen only in drawers, after the preview.
- **Cofounder panel:** docked at ≥ 1280px (xl) on every page.
  - It can be hidden. The choice is remembered per device in `localStorage`; if storage is blocked, it lasts until the page reloads.
  - Below 1280px there is no dock: Talk opens the drawer.
- **Phone (< 768px):** no sidebar.
  - Bottom nav: Home · Inbox · Talk · Workspaces · Settings.
  - Workspaces is `area=list`: the scope, the areas, theme and Sign out.
  - STOP sits in the header.
- **Tablet (768–1279px):** narrower sidebar, no dock.

## Routes

- `/?area=code|systems|business|research|agents|plans|list`. Without `area` the page is Today.
- An area that isn't shown falls back to Today. So does `list` on a wide screen.
- `drawer=` is unchanged and opens over any page.
- Drawers and scope switches keep `area`: `Scope.keep` carries it.
- Old bookmarks with `view=board` or `view=home` redirect with `replace` to the same URL without `view`, keeping `drawer`.
- Switching areas scrolls the middle column back to the top. The header and the sidebar don't scroll.

## Contract

`packages/contracts/src/home.ts`:
- `HomeRef.kind` gains `INCIDENT`, which opens `drawer=incident:<id>`.
- `HomeDecisions.incidents` counts open incidents and is part of `headline.decisionsWaiting`.
- Open incidents appear in `decisions.top` with `expiresAt: null`.

The API side is built separately.

## Acceptance

- The sidebar lists the areas with their status in words; an open incident is said, not only coloured.
- Clicking an area shows its page, sets `area=` and moves `aria-current`. Drawers and scope switches keep the area.
- `/?view=board&drawer=jobs` ends on Today with the Jobs drawer open and no `view`.
- In Dev only, Business is not in the sidebar, and `area=business` shows Today.
- An open incident is listed first in Waiting on you and opens its drawer.
- Empty Today sections are one line.
- STOP is visible on every screen size.
- On a phone, the bottom nav has the 5 items and Workspaces lists the areas.
- Hiding the Cofounder panel persists, and toggling still works when storage throws.
- Tests: `Shell.test.tsx`, `home.test.tsx`, plus the area tests in each feature's test file.
