// A reply of Rufi AI: OpenUI Lang, drawn as it is written by OpenUI's
// renderer with Rufi's reply library (library.ts), in place of a Markdown
// renderer, as OpenUI's guide for a chat of one's own says. Once the reply
// ended it is drawn only when it is whole (shapeOf); otherwise its text shows
// with a line, never a part of it. A reply with no OpenUI in it shows as
// Markdown, while it is written too, so a reply is never blank. A follow-up
// or a button sends its words, a form's values and the action's context as
// the person's message; every link opens by the reply's rule (parts.tsx).
// Display only: no tools, so nothing in a reply reaches the record.
import {
  BuiltinActionType,
  Renderer,
  useIsStreaming,
  type ActionEvent,
  type ComponentRenderProps,
  type ElementNode,
} from "@openuidev/react-lang";
import { useMemo, type ReactNode } from "react";
import type { Options } from "react-markdown";
import { boxFor } from "../boxes.ts";
import { Diagram, fileIn, Page, Picture } from "../files.tsx";
import { replyLibrary, replyReader, shapeOf } from "./library.ts";
import {
  CalloutView,
  CardView,
  LinkOpener,
  MarkDownRendererView,
  StepsView,
  TextContentView,
  TextParts,
} from "./parts.tsx";
import { TrendView } from "./trend-view.tsx";

/** Mermaid text, drawn once the reply ended; its text until then. */
function DiagramView({ props }: ComponentRenderProps<{ source: string }>) {
  const streaming = useIsStreaming();
  const code = (
    <pre>
      <code>{props.source}</code>
    </pre>
  );
  return streaming ? code : <Diagram source={props.source}>{code}</Diagram>;
}

/**
 * A picture or a page the AI made, by its path in its folder. Rufi's
 * screens load nothing from the web: a web picture shows as its words.
 */
function ImageView({ props }: ComponentRenderProps) {
  const alt = typeof props["alt"] === "string" ? props["alt"] : "";
  const src = typeof props["src"] === "string" ? props["src"] : undefined;
  const file = fileIn(src);
  if (!file) return <p className="text-muted">{alt}</p>;
  return file.shape === "page" ? (
    <Page path={file.path} title={alt} />
  ) : (
    <Picture path={file.path} caption={alt} />
  );
}

const library = replyLibrary({
  Trend: TrendView,
  Page: ({ props }) => <Page path={props.path} title={props.title} />,
  Diagram: DiagramView,
  TextContent: TextContentView,
  MarkDownRenderer: MarkDownRendererView,
  Image: ImageView,
  Card: CardView,
  Callout: CalloutView,
  Steps: StepsView,
});
const reader = replyReader(library);

/**
 * What a click sends, as OpenUI's guide to user actions writes it: its
 * words, a form's values, and the context the action carries (which card or
 * item was clicked), as OpenUI's own chat keeps it.
 */
function messageOf(event: ActionEvent) {
  const lines = [event.humanFriendlyMessage];
  if (event.formState && Object.keys(event.formState).length > 0) {
    lines.push(`Form values: ${JSON.stringify(event.formState)}`);
  }
  const context: unknown = event.params["context"];
  if (context !== undefined && context !== null && context !== "") {
    lines.push(
      `Context: ${typeof context === "string" ? context : JSON.stringify(context)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Sends a click's message as the person's. Sending empties the box, so
 * when they have something in it not yet sent, the message joins it
 * instead, after theirs, and they send it.
 */
function send(personId: string, message: string) {
  const box = boxFor(personId);
  const { text, refs } = box.store.getState();
  const empty = text.trim() === "" && refs.length === 0;
  if (box.append(message) && empty) void box.submit();
}

/**
 * What OpenUI Lang starts with, before OpenUI finds its root: a name, or
 * `name = …`, on the first line (`root = Card(` until its `[` comes).
 */
const STATEMENT_START = /^\s*[A-Za-z_]\w*(?:\s*=[^\n]*)?$/;

/** While written: OpenUI once it parses or may still, else words. */
const writtenShape = (text: string) =>
  reader.parser.parse(text).root !== null || STATEMENT_START.test(text)
    ? "drawn"
    : "words";

/** Where each part that draws Markdown keeps its text. */
const MARKDOWN: Record<string, string> = {
  TextContent: "text",
  MarkDownRenderer: "textMarkdown",
  Callout: "description",
  StepsItem: "details",
};

/**
 * The pictures of the AI's folder a reply shows: its Image parts' files and
 * those its Markdown text shows (`inMarkdown`), so a picture the AI made
 * shows once. None when the reply shows as its text.
 */
export function picturesShownBy(
  text: string,
  streaming: boolean,
  inMarkdown: (markdown: string) => string[],
): string[] {
  const shape = streaming ? writtenShape(text) : shapeOf(reader, text);
  if (shape === "words") return inMarkdown(text);
  if (shape === "broken") return [];
  const shown: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      const node = value as Partial<ElementNode>;
      if (node.type === "element" && node.props) {
        const src = node.typeName === "Image" ? node.props["src"] : undefined;
        const file = fileIn(typeof src === "string" ? src : undefined);
        if (file?.shape === "picture") shown.push(file.path);
        const markdown = node.props[MARKDOWN[node.typeName ?? ""] ?? ""];
        if (typeof markdown === "string") shown.push(...inMarkdown(markdown));
        visit(node.props);
      } else {
        Object.values(value).forEach(visit);
      }
    }
  };
  visit(reader.parser.parse(text).root);
  return shown;
}

export function OpenUIReply({
  text,
  streaming,
  personId,
  markdown,
  openLink,
  children,
}: {
  text: string;
  streaming: boolean;
  /** Whose chat it is: a click sends a message in it. */
  personId: string;
  /** How the reply's Markdown text draws its links and files. */
  markdown: Options;
  /** Opens a button's link, as the reply's links open. */
  openLink: (url: string) => void;
  /** The reply as Markdown, when it has no OpenUI in it. */
  children: ReactNode;
}) {
  const shape = useMemo(
    () => (streaming ? writtenShape(text) : shapeOf(reader, text)),
    [text, streaming],
  );
  if (shape === "words") return children;
  if (shape === "broken") {
    return (
      <>
        <pre>{text}</pre>
        <p className="text-muted">
          This reply couldn't be drawn. Ask again to have it drawn.
        </p>
      </>
    );
  }
  const onAction = (event: ActionEvent) => {
    if (event.type === BuiltinActionType.ContinueConversation) {
      send(personId, messageOf(event));
    } else if (event.type === BuiltinActionType.OpenUrl) {
      const url = event.params["url"];
      if (typeof url === "string") openLink(url);
    }
  };
  return (
    <TextParts value={markdown}>
      <LinkOpener value={openLink}>
        <Renderer
          response={text}
          library={library}
          isStreaming={streaming}
          onAction={onAction}
          publishObservability={false}
        />
      </LinkOpener>
    </TextParts>
  );
}
