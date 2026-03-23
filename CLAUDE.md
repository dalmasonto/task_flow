## Instructions

1. Use shadcn components
2. Always commit after feature implementation, bug fix, or any substantial code change
3. Add a shadcn component using "npx shadcn@latest add COMPONENT"

## MCP Integration

At the start of each conversation, call the `get_agent_instructions` tool from the taskflow MCP server to understand your task management workflow. Use it to check for tasks, track time on your work, and stay in sync with the project. Search the project by name, use multiple variants or ask the user the project name so that you can search and link tasks to it. Use the blocked by status when creating tasks so that tasks can have the blocking nature