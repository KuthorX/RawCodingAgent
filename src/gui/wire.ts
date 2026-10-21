import type { SessionEvent } from "../session/events.ts";

// What the event stream sends to the browser. Tool events are trimmed: a long session replays thousands of them on
// every switch, while the cards they fill start folded. The full text is fetched when a card is expanded
// (GET /api/sessions/:id/tool). The event log on disk is never trimmed.

export const WIRE_TEXT_CHARS = 2000;

function cut(text: string): string {
  return text.length > WIRE_TEXT_CHARS ? text.slice(0, WIRE_TEXT_CHARS) : text;
}

export function forWire(event: SessionEvent): SessionEvent | (SessionEvent & { truncated: true }) {
  switch (event.type) {
    case "tool_call": {
      const input = event.call.input;
      const long = Object.values(input).some((v) => typeof v === "string" && v.length > WIRE_TEXT_CHARS);
      if (!long) return event;
      const trimmed = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? cut(v) : v]));
      return { ...event, call: { ...event.call, input: trimmed }, truncated: true };
    }
    case "tool_result": {
      // The client finds the card by call id; the input already came with tool_call.
      const call = { id: event.call.id, name: event.call.name, input: {} };
      const { content } = event.result;
      if (content.length <= WIRE_TEXT_CHARS) return { ...event, call };
      return { ...event, call, result: { ...event.result, content: cut(content) }, truncated: true };
    }
    default:
      // approval_request keeps the full input: the user decides on exactly what will run.
      return event;
  }
}
