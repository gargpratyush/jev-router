---
name: jev-tiers
description: Choose which model tiers Jev Router may route to, or show the current list.
---

When invoked, use the text after `$jev-tiers` as the arguments. Run:

```bash
node "{{ROOT}}/bin/jev-tiers.mjs" <arguments>
```

For example, `$jev-tiers haiku,sonnet` runs `node "{{ROOT}}/bin/jev-tiers.mjs" haiku,sonnet`. Valid arguments are a list of tiers, `reset`, or nothing to show the current list. Return the command output without other changes. The change applies to the next prompt in every Jev-enabled session.
