import { defineTool } from "@earendil-works/pi-coding-agent";
/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export function createStructuredOutputTool({ schema, capture, name = "structured_output", }) {
    return defineTool({
        name,
        label: "Structured Output",
        description: "Return the final structured result.",
        parameters: schema,
        async execute(_toolCallId, params) {
            capture.value = params;
            capture.called = true;
            return {
                content: [{ type: "text", text: "Structured output received." }],
                details: params,
                terminate: true,
            };
        },
    });
}
