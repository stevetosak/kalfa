---
name: meter
description: Sets the context meter for this session. `/meter off` stops the /compact reminders, `/meter 300k` moves the compact point, `/meter on` puts the project's compact point back, `/meter` alone shows the setting. Typed by the Operator only.
disable-model-invocation: true
argument-hint: off | on | <N>k
---

The kalfa `meter` Module answers `/meter` in the prompt hook, before the
prompt reaches the model, so this text is normally never read.

If you read it, the hook did not answer and the setting did not change. Say
so to the Operator in one line, and name the likely cause: the `meter` Module
is not on in this repository's `kalfa.yaml`, the prompt hook is not wired
(`kalfa doctor`), or `kalfa build` has not run since the Module was turned on.
Do nothing else.
