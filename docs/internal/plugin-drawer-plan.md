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

## Install scope: for this project, or for all of them

Victor's, and the other half of the same problem. Plugins are project-level by
construction — the registry and the files live at `{project}/.shipstudio/plugins/`
— so a plugin you want everywhere has to be linked or installed again in every
project you open. For a hosting plugin, or for one like Pedidos that is about how
*you* work rather than about a particular repository, that is pure friction.

So the install dialog should ask, once, at the moment you paste the URL:
**install for all projects**, or **install for this project only**. Both are
right answers for different plugins, and the app currently only offers the
narrower one.

This decides the pin-scope question above rather than sitting beside it. A
globally installed plugin wants a global pin — "the plugins I use" is a property
of the person. A project-scoped plugin wants a pin that lives and dies with the
project. So scope is chosen once at install, and pinning inherits it instead of
being a second question the user has to answer.

It also gives the drawer its shape: two groups, "everywhere" and "this project",
rather than one flat list that hides where a plugin came from.

Storage: a global root beside the per-project one, most likely under
`~/.ship-studio/`, with `list_plugins` merging the two and the project's copy
winning on an id collision — so a project can pin a specific version of
something you also run globally.

## One URL, several plugins

Install-from-URL requires `plugin.json` at the repo root, so a repository holding
several plugins in subfolders cannot be installed at all — only dev-linked, one
folder at a time, per project. That is the friction that started this whole
thread.

Splitting into one repo per plugin would satisfy the installer and bring the
friction straight back: a URL to paste per plugin, in every project. The
installer should learn packs instead — a repo whose root declares the plugins it
contains, each in its own subfolder, installed together.

With install scope above, that collapses the whole problem into one gesture:
paste one URL, choose "all projects", done. Every plugin you own, everywhere,
forever. Worth building in that order, because a pack installed per-project would
still need repeating.

Publishing to `ship-studio/plugin-registry` stays one repo per plugin — its
entries carry a single `repo` field. A pack is for the plugins you keep, not for
the ones you list.

## What it touches

- Manifest: nothing new required. Pinning is user state, not plugin metadata.
- Pin state follows install scope (see above), so it is not a separate question.
- A one-time migration seeding pins for `vercel`, `cloudflare` and `netlify`, so
  no one loses a button they already had.
- `WorkspaceView`: the tab strip renders pinned `panel` plugins instead of every
  one, plus the constant puzzle entry.
- `WorkspaceHeader`: `toolbarPlugins.hosting` gives way to "pinned `toolbar`
  plugins", removing the hardcoded name list.
- The drawer: two groups — everywhere, and this project — with a pin toggle per
  row.
- A global plugin root beside `{project}/.shipstudio/plugins/`, and `list_plugins`
  merging both.
- The install dialog: a scope choice next to the URL field.
- `install_plugin`: recognise a pack manifest at the repo root and install every
  plugin it names, instead of assuming one plugin per clone.
- `WorkspaceTab` already addresses plugin tabs as `plugin:{id}`, so selecting
  from the drawer needs no new tab model.
