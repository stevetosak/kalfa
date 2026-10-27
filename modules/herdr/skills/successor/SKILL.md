---
name: successor
description: Starts the next session on the open kalfa Task, so the work goes on with a clean context, in a new Herdr tab (inside Herdr) or as a background session. Use only when the Operator says start a new session, continue in a new tab, hand over to a fresh session, or when the idle guard reports a stale session and the Operator wants a successor. Not for the context meter (it asks for /compact) and not at the end of a Task.
---

# Start a successor session

The Task Record is the handoff: a new session reads it with
`kalfa task show --handoff`. This skill only makes sure the record is up to
date, then starts the session that reads it. Start a successor at the end of
a logical Section, never in the middle of a change.

1. **Stop the watchers.** Stop each background task and monitor this session
   started that still runs. Their notices would wake this session later.
2. **Record the Section** with `kalfa section close "<title>"`. Its **Next**
   part is the first thing the new session does: one step first, then the
   Task's other Sections, numbered. Put what the new session would get wrong
   in **Found**, and write "Operator chooses:" with the options when the
   Operator must decide. If a push waits for approval, the first step is to
   ask for it.
3. **Ask once**: "Start the next session on Task `<id>` now?", with the Next
   step in the question. Anything but a clear yes: stop. The record waits; a
   `/clear` in this repository shows its Handoff.
4. **Start it**: `kalfa herdr continue` (add `--task <id>` when the Task is
   not the one of the checked-out branch, `--model <model>` when the
   Operator names one).
   - Exit 3: a usage limit is near. Say so with the reset time and stop. Use
     `--force` only when the Operator says so in this session.
   - "Waits at a prompt": the harness runs in the tab but waits, most often
     at the trust prompt of a new folder. Tell the Operator to answer it in
     that tab.
   - A failed `agent start` may still have started a session: say what it
     printed and start nothing more.
5. **Say two lines**: where the session runs (the Herdr tab and agent name,
   or the background session id and how to attach), and that this session
   stops here. Then end the turn. The new session owns the work.
