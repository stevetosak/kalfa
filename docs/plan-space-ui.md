---
title: "Space from the Herdr UI: a guided form for Tasks and Presets"
description: "A Herdr plugin action opens a popup form that starts a Task or opens a repository's Workspace from a Preset, with a default for every value."
type: plan
status: active
topics: [agents, tooling]
---

`kalfa space open` makes a Task's worktree, branch and Task Record and opens a
Preset's tabs, but every value is a flag, so in practice only the agent starts
a Task or a space. This Plan gives the Operator the same path from the Herdr
UI: a plugin action in Herdr's menu opens a popup pane, and the pane runs a
guided form, `kalfa space new`. The form has no logic of its own; it builds
the request the `space open` flags build and shows the matching command
before it runs, so the agent's path and the Operator's path stay one code
path.

Herdr runs a plugin action without a terminal, so the action cannot ask
anything itself; it opens a plugin pane with `placement = "popup"`, which has
one. The form sets the repository, the Preset, the Task (new, open, or only
the Workspace), the base branch, the model of each agent tab and the agent's
first prompt, and every value that can have a default has one. The prompts
come from `@inquirer/prompts`. The plugin and the popup are Herdr only; the
form runs in any terminal, but `space open` needs Herdr for its tabs, so the
whole feature stays in the herdr Module.

## 1. Spike the plugin route

**Done when:** a linked test plugin shows where Herdr lists its action, a `popup` pane has a TTY, the pane learns the focused Workspace's folder, and `kalfa` runs in it on Node 24; the test plugin is unlinked again.

- [x] Link a test plugin with one action and one popup pane; check the menu, the TTY, the context and `kalfa` with Node 24; unlink it.

The spike on herdr 0.9.3 held on every point but one detail. Herdr's
right-click pane menu lists the action. The action gets the focused
Workspace's folder in `HERDR_PLUGIN_CONTEXT_JSON`, and `herdr plugin pane open
--placement popup --cwd <dir>` gives a popup with a full TTY, in which Node's
raw mode works. The pane's command starts in that `--cwd` folder, not in the
plugin root, so a relative script path fails and the popup closes at once; the
plugin's scripts are found through `$HERDR_PLUGIN_ROOT`. Herdr's own PATH
starts `kalfa` on nvm's Node 20, which runs it.

## 2. One request, two front ends

**Done when:** `space open` runs through `openSpace(request)` with a typed `SpaceRequest`, and `--base`, `--model <tab>=<model>`, `--prompt` and `--no-prompt` work, with tests.

- [x] Move the body of `space open` into `openSpace(request)`.
- [x] `--base <ref>` for a new branch; `--model <tab>=<model>` (repeatable); `--prompt "<text>"` and `--no-prompt` for the first agent tab.

## 3. The form

**Done when:** `kalfa space new` asks for the repository, the mode, the Task fields, the Preset, each agent tab's model and first prompt, shows the matching `space open` command, and opens the space after a yes; tests drive it through a `Prompter` with set answers.

- [x] A `Prompter` interface over `@inquirer/prompts`.
- [x] `kalfa space new`: the form builds a `SpaceRequest` from its answers, shows the matching `space open` command and runs `openSpace` after a yes.
- [x] Defaults: the focused Workspace's repository, New Task, the only active Plan (else none), origin's default branch, the `default-preset`, each tab's model, the successor prompt on the first agent tab.

The form asks only what applies: the Open Task mode shows only when the
repository has an open Task with a branch, the Plan question only when it has
an open Plan, the base branch only when there is an origin, and the successor
prompt only for a Task. A default answer stays out of the request, so the
command the form shows is the shortest `space open` line that does the same;
the base list comes from a fresh fetch of origin, and a branch name is checked
with `git check-ref-format` before anything is made.

## 4. The plugin

**Done when:** the herdr Module ships a Herdr plugin whose actions "kalfa: New Task" and "kalfa: Open space" open the form in a popup, and `kalfa install` links it when `herdr` is on PATH and the herdr Module is on.

- [ ] The plugin manifest, its actions and its popup pane in `modules/herdr/herdr-plugin/`.
- [ ] `kalfa install` links the plugin and says so.

## 5. Proof and docs

**Done when:** one live run from Herdr's menu opens a Task from the form, and the Module docs and usage text describe the form and the new flags.

- [ ] One live run from the menu.
- [ ] The Module docs and the usage text.
