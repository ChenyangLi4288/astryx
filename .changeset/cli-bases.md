---
'@astryxdesign/cli': patch
---

[feat] Bases, first step: a run resolves one base. The new global `--base <package>` picks it; otherwise, in an integration package, the base it is or builds on; else the project's Core; else its one installed base; else Core. A package becomes a base by declaring `base` in its integration manifest. Commands and options that need a platform step the base does not serve (theme build, add, use, targets, and template; `template --skeleton` and `--cdn`; `integration add theme`; `experimental render`) are hidden from help and refused with `ERR_BASE_CAPABILITY`. Commands do not call base adapters yet, so a base other than Core serves no platform step. Content commands do not read a non-Core base yet; in such a run, templates, topics, bundled themes, codemods, and search leave out Core's content, and component and hook lookups fail with `ERR_CORE_NOT_FOUND`. A project with no base-declaring integration answers exactly as before.

@josephfarina
