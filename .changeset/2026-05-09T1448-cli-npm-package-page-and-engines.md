---
'@psraghuveer/memento': patch
---

Polish the npm package page and declare the Node engine.

- The published `README.md` is now marketing-grade — opens with the project tagline + link to runmemento.com, includes the install command, the three-step Quickstart, and a feature summary, with the architectural reference preserved as a footer. Replaces the previous 928-byte package-internal reference, which was fine in-repo but didn't help anyone landing on npmjs.com from a search result. All internal links are now absolute GitHub URLs so they work when rendered on the npm page (relative paths 404 from npmjs.com).
- `engines.node` is now declared as `>=22.11.0`, matching the root workspace and `.nvmrc`. npm will surface a clear engine warning on incompatible installs instead of failing at runtime. No behavioural change for in-range Node versions — this just documents what was already required.
- `keywords` expanded from 7 to 20 entries — added `ai-memory`, `ai-assistant`, `mcp-server`, `model-context-protocol`, `llm`, `llm-memory`, `claude`, `claude-code`, `cursor`, `copilot`, `cline`, `opencode`, `aider`. Improves npm-search ranking on the queries developers actually type when looking for an MCP-native memory layer; no runtime impact.
