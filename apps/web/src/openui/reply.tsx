// A reply of Rufi AI: OpenUI Lang, drawn as it is written by OpenUI's
// renderer with Rufi's reply library (library.ts), in place of a Markdown
// renderer, as OpenUI's guide for a chat of one's own says. Once the reply
// ended it is drawn only when it is whole (shapeOf); otherwise its text shows
// with a line, never a part of it, and a reply with no OpenUI in it shows as
// Markdown. A follow-up or a button sends its words as the person's message,
// a form its values too; a link opens as a reply's links do. Display only:
// no tools, so nothing in a reply reaches the record.
import {
  BuiltinActionType,
  Renderer,
  useIsStreaming,
  type ActionEvent,
  type ComponentRenderProps,
} from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { createContext, use, useMemo, type ReactNode } from "react";
import type { Options } from "react-markdown";
import { boxFor } from "../boxes.ts";
import { Diagram, fileIn, Page, Picture } from "../files.tsx";
import { replyLibrary, replyParser, shapeOf } from "./library.ts";
import { TrendView } from "./trend-view.tsx";

/** How a reply's Markdown text draws: the reply's own links and files. */
const TextParts = createContext<Options>({});

const VARIANTS = ["clear", "card", "sunk"] as const;
type Variant = (typeof VARIANTS)[number];
const variantOf = (value: unknown): Variant | undefined =>
  VARIANTS.find((variant) => variant === value);

/** OpenUI's Markdown text, with a reply's links and files. */
function Text({ text, variant }: { text: string; variant?: Variant }) {
  const options = use(TextParts);
  return (
    <div className="openui-text-content">
      <MarkDownRenderer
        textMarkdown={text}
        {...(variant && { variant })}
        options={options}
      />
    </div>
  );
}

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
  TextContent: ({ props }) => (
    <Text text={typeof props["text"] === "string" ? props["text"] : ""} />
  ),
  MarkDownRenderer: ({ props }) => (
    <Text
      text={
        typeof props["textMarkdown"] === "string" ? props["textMarkdown"] : ""
      }
      {...(variantOf(props["variant"]) && {
        variant: variantOf(props["variant"]),
      })}
    />
  ),
  Image: ImageView,
});
const parser = replyParser(library);

/** What a click sends: its words, and a form's values as OpenUI gives them. */
const messageOf = (event: ActionEvent) =>
  event.formState
    ? `${event.humanFriendlyMessage}\nForm values: ${JSON.stringify(event.formState)}`
    : event.humanFriendlyMessage;

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

const WEB = /^https?:\/\//i;

export function OpenUIReply({
  text,
  streaming,
  personId,
  markdown,
  children,
}: {
  text: string;
  streaming: boolean;
  /** Whose chat it is: a click sends a message in it. */
  personId: string;
  /** How the reply's Markdown text draws its links and files. */
  markdown: Options;
  /** The reply as Markdown, when it has no OpenUI in it. */
  children: ReactNode;
}) {
  const shape = useMemo(
    () => (streaming ? "drawn" : shapeOf(parser, text)),
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
      if (typeof url === "string" && WEB.test(url)) {
        open(url, "_blank", "noopener,noreferrer");
      }
    }
  };
  return (
    <TextParts value={markdown}>
      <Renderer
        response={text}
        library={library}
        isStreaming={streaming}
        onAction={onAction}
        publishObservability={false}
      />
    </TextParts>
  );
}
