# Bring Your Own Components

ShitRat components are semantic prompt primitives. A custom component should make a piece of context easier for agents to validate, compose, and reason about.

Example:

```mdx
<ToolPolicy id="visual-truth" harness="codex-desktop">
  Use browser or computer-use tools when visual layout truth matters.
</ToolPolicy>
```

The component can later compile to plain Markdown for a harness prompt, appear in a parity report, or become part of a doctor check.
