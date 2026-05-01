---
"@psraghuveer/memento-schema": patch
"@psraghuveer/memento-core": patch
"@psraghuveer/memento-server": patch
"@psraghuveer/memento": patch
---

Improve MCP tool usability for AI agents

- Add `.describe()` annotations to all Zod input schemas with examples and format hints
- Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
- Include Zod issue summary in INVALID_INPUT error messages for self-correction
- Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
- Add usage examples to command descriptions
- Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes
