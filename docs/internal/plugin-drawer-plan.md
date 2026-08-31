# Plugin drawer and pinning — plan

Not built. Recorded while the `panel` slot was fresh, so the reasoning survives.

## What prompted it

The `panel` slot gives a plugin its own workspace tab. The first one shipped
with the generic puzzle glyph, because a plugin has no icon of its own that the
tab strip could use — `icon` is reserved in the manifest and never rendered, and
the `toolbar` component that doubles as an icon elsewhere is a whole button.

The obvious fix is to make plugins supply a tab icon. The better move is to stop
treating the puzzle glyph as a placeholder and make it mean something.

## The idea

One puzzle entry in the tab strip, permanently. Clicking it opens the list of
installed plugins; picking one opens that plugin in the right pane. The pane is
the same surface the `panel` slot already renders into — the drawer only changes
how you get there.

A plugin you reach for constantly can then be **pinned**, and a pinned plugin
graduates to its own button in the tab strip, with its own name, the way Pedidos
has one today.

## Why it is the right shape

It fixes a problem the current slot creates rather than papering over one. Every
`panel` plugin installed today adds a permanent tab; four plugins and the strip
that holds Focus, Code, Branches and PRs is no longer legible. The drawer makes
the default cost of installing a plugin zero — nothing moves in your workspace
until you say so — and pinning makes the strip a statement of what *you* use
rather than of what you happen to have installed.

It also matches how the app already behaves elsewhere: the Plugins dropdown in
the header is already a drawer of exactly this kind. This gives the same gesture
a destination that is a full pane instead of a popover.

## Decided: pinning covers every plugin, not just panel ones

Pinning is a general answer to a question the codebase currently answers by
hardcoding. Today `toolbar` plugins are split in two by name: the hosting ones
(`vercel`, `cloudflare`, `netlify`) get a real header button, and everything else
is buried in the dropdown — see `toolbarPlugins.hosting` in `WorkspaceHeader`.
That is a maintained list of favourites, decided for the user.

Victor's call is that pinning covers any plugin. So that list stops being a name
check in the source and becomes the user's own: hosting plugins ship *pinned by
default* rather than *special*, and one rule — pinned or not — decides who gets
space in the chrome. A pinned `toolbar` plugin keeps rendering its button in the
header exactly as it does now; a pinned `panel` plugin gets its tab. The drawer
lists everything installed regardless of slot, each row with a pin toggle.

**This makes a migration mandatory.** Anyone already running Vercel, Cloudflare
or Netlify has that button today without ever having asked for it. If pins start
empty, those buttons vanish on upgrade and it reads as a regression, not as a
new feature. So the first run after the change has to seed pins for the plugins
that were previously promoted by name — after which the user can unpin them,
which is the whole point.

## What it touches

- Manifest: nothing new required. Pinning is user state, not plugin metadata.
- Pin state: per project or global? Global is the likely answer — "the plugins I
  use" is a property of the person, not of the repository — but per-project is
  arguable for a plugin that only makes sense in some projects. Still open.
- A one-time migration seeding pins for `vercel`, `cloudflare` and `netlify`, so
  no one loses a button they already had.
- `WorkspaceView`: the tab strip renders pinned `panel` plugins instead of every
  one, plus the constant puzzle entry.
- `WorkspaceHeader`: `toolbarPlugins.hosting` gives way to "pinned `toolbar`
  plugins", removing the hardcoded name list.
- The drawer: a list, and a pin toggle per row.
- `WorkspaceTab` already addresses plugin tabs as `plugin:{id}`, so selecting
  from the drawer needs no new tab model.
