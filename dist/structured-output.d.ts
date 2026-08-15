import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
export interface StructuredOutputCapture<T = unknown> {
    value: T | undefined;
    called: boolean;
}
export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
    schema: TSchemaDef;
    capture: StructuredOutputCapture<Static<TSchemaDef>>;
    name?: string;
}
/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export declare function createStructuredOutputTool<TSchemaDef extends TSchema>({ schema, capture, name, }: StructuredOutputToolOptions<TSchemaDef>): ReturnType<typeof defineTool<TSchemaDef, Static<TSchemaDef>>>;
