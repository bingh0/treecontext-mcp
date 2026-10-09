/**
 * Reading an MCP tool result, in one place.
 *
 * Every scenario that drives the server over a client gets its answer as
 * `{ content: [{ text }] }` and has to cast its way in — the SDK types the
 * block union widely enough that the text is not reachable without one.
 * Seven copies of that cast had accumulated across the design tier (plus
 * the journal tier's own `parseTool`, which now delegates here): a cast
 * repeated is a cast that stops being read, and the day the response shape
 * moves, one spelling of it survives to be updated.
 */

/** The text payload of a tool result's first content block. */
export function toolResultText(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0]!.text
}

/** That payload, parsed as JSON. Tool responses are JSON documents by
 *  construction — the servers stringify a record into the text block. */
export function parseToolResult<T = Record<string, unknown>>(res: unknown): T {
  return JSON.parse(toolResultText(res)) as T
}
