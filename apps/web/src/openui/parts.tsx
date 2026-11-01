// OpenUI's chat parts that draw text or links, drawn the same way with Rufi's
// links: every link in a reply opens by one rule (a page of Rufi in place, a
// web page outside Rufi, a file of the AI's shown), wherever OpenUI puts it.
// OpenUI's Markdown component opens every link in a new tab and its sources
// call `window.open`, so the parts that use them are Rufi's here, with the
// same props: TextContent (with OpenUI's [n] citations), Callout, Steps, and
// Card, whose sources and citations open by the rule. Callout, Steps and
// Card follow OpenUI's own (@openuidev/react-ui 0.18.1, MIT; see NOTICE).
import {
  useStateField,
  type ComponentRenderProps,
} from "@openuidev/react-lang";
import {
  Callout as OpenUICallout,
  Card as OpenUICard,
  CardSourceContext,
  MarkDownRenderer,
  Sources,
  Steps as OpenUISteps,
  StepsItem as OpenUIStepsItem,
  TextContentCitation,
  useCardSourceContext,
} from "@openuidev/react-ui";
import { createContext, use, useEffect, type ComponentProps } from "react";
import type { Options } from "react-markdown";

/** How a reply's Markdown text draws: the reply's own links and files. */
export const TextParts = createContext<Options>({});

/** Opens a link by the reply's rule. */
export const LinkOpener = createContext<(url: string) => void>(() => undefined);

const CITATIONS = /(\[\d+\]\s*)+/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: unknown;
}

/**
 * OpenUI's citations: `[1]` or `[1][2]` in text becomes a span that
 * OpenUI's TextContentCitation draws from the Card's sources.
 */
function remarkCitations() {
  const split = (node: MdNode): MdNode[] => {
    if (node.type !== "text" || node.value === undefined) {
      if (node.children) node.children = node.children.flatMap(split);
      return [node];
    }
    const text = node.value;
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(CITATIONS)) {
      if (match.index > last) {
        parts.push({ type: "text", value: text.slice(last, match.index) });
      }
      const numbers = [...match[0].matchAll(/\[(\d+)\]/g)].map((n) => n[1]);
      parts.push({
        type: "citation",
        data: {
          hName: "span",
          hProperties: {
            "data-component-type": "citation",
            "data-citation-indices": numbers.join(","),
          },
        },
        children: [{ type: "text", value: match[0].trim() }],
      });
      last = match.index + match[0].length;
    }
    if (last === 0) return [node];
    if (last < text.length)
      parts.push({ type: "text", value: text.slice(last) });
    return parts;
  };
  return (tree: MdNode) => {
    split(tree);
  };
}

/** A Card's source, opened by the reply's rule instead of `window.open`. */
interface Source {
  title: string;
  sourceName: string;
  faviconUrl: string;
  link?: string;
  onClick?: () => void;
}

/**
 * OpenUI's citation, whose list opens a source by the reply's rule: OpenUI's
 * citation items open their address themselves, and these have none.
 */
function Citation(props: ComponentProps<typeof TextContentCitation>) {
  const open = use(LinkOpener);
  const sources = useCardSourceContext() as Source[];
  const indices = props.node?.properties?.["data-citation-indices"];
  if (typeof indices !== "string") return <TextContentCitation {...props} />;
  const cited = indices
    .split(",")
    .map((index) => sources[Number(index) - 1])
    .filter((source) => source?.title.trim() && source.sourceName.trim());
  return (
    <span
      onClickCapture={(event) => {
        const item = (event.target as Element).closest(".openui-citation-item");
        const index = item
          ? [...(item.parentElement?.children ?? [])].indexOf(item)
          : -1;
        const link = cited[index]?.link;
        if (link !== undefined) open(link);
      }}
    >
      <TextContentCitation {...props} />
    </span>
  );
}

const VARIANTS = ["clear", "card", "sunk"] as const;
const variantOf = (value: unknown) =>
  VARIANTS.find((variant) => variant === value);

/** OpenUI's Markdown component, with a reply's links and files. */
function Markdown({
  text,
  variant,
  cited = false,
  className,
}: {
  text: string;
  variant?: (typeof VARIANTS)[number] | undefined;
  /** With OpenUI's [n] citations of the Card's sources. */
  cited?: boolean;
  className?: string;
}) {
  const options = use(TextParts);
  return (
    <MarkDownRenderer
      textMarkdown={text}
      {...(variant && { variant })}
      {...(className && { className })}
      options={
        cited
          ? {
              ...options,
              remarkPlugins: [
                ...(options.remarkPlugins ?? []),
                remarkCitations,
              ],
              components: { ...options.components, span: Citation },
            }
          : options
      }
    />
  );
}

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

const SIZES: Record<string, string> = {
  small: "--openui-text-body-sm",
  large: "--openui-text-body-lg",
  "small-heavy": "--openui-text-body-sm-heavy",
  "large-heavy": "--openui-text-body-lg-heavy",
};

/** OpenUI's TextContent: Markdown text at its size, with citations. */
export function TextContentView({ props }: ComponentRenderProps) {
  const size = SIZES[textOf(props["size"])];
  return (
    <div
      style={
        size === undefined
          ? undefined
          : {
              ["--openui-text-body-default" as string]: `var(${size})`,
              ["--openui-text-body-default-letter-spacing" as string]: `var(${size}-letter-spacing)`,
            }
      }
    >
      <div className="openui-text-content">
        <Markdown
          text={textOf(props["text"])}
          cited
          className="openui-text-content-markdown"
        />
      </div>
    </div>
  );
}

/** OpenUI's MarkDownRenderer, with a reply's links and files. */
export function MarkDownRendererView({ props }: ComponentRenderProps) {
  return (
    <Markdown
      text={textOf(props["textMarkdown"])}
      variant={variantOf(props["variant"])}
    />
  );
}

/** OpenUI's chat Card; its sources open by the reply's rule. */
export function CardView({ props, renderNode }: ComponentRenderProps) {
  const open = use(LinkOpener);
  const given = Array.isArray(props["sources"]) ? props["sources"] : [];
  const sources: Source[] = given.map((source: Record<string, unknown>) => {
    const link = textOf(source["url"]).trim();
    return {
      title: textOf(source["title"]),
      sourceName: textOf(source["sourceName"]),
      faviconUrl: "",
      ...(link && {
        link,
        onClick: () => {
          open(link);
        },
      }),
    };
  });
  return (
    <CardSourceContext value={sources}>
      <OpenUICard
        width="full"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--openui-space-m-l)",
        }}
      >
        {renderNode(props["children"])}
        <Sources />
      </OpenUICard>
    </CardSourceContext>
  );
}

const CALLOUT_VARIANTS: Record<
  string,
  "info" | "warning" | "success" | "neutral"
> = {
  info: "info",
  warning: "warning",
  success: "success",
  error: "warning",
  neutral: "neutral",
};

/** OpenUI's Callout; its description is a reply's Markdown text. */
export function CalloutView({ props }: ComponentRenderProps) {
  const field = useStateField("visible", props["visible"]);
  const bound = field.isReactive;
  const visible = bound ? field.value === true || field.value === "true" : true;
  // OpenUI's Callout: one bound to $visible goes away after 3 s.
  useEffect(() => {
    if (!bound || !visible) return;
    const timer = setTimeout(() => {
      field.setValue(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [bound, visible, field]);
  if (!visible) return null;
  const variant = CALLOUT_VARIANTS[textOf(props["variant"])];
  return (
    <OpenUICallout
      variant={variant ?? "info"}
      title={textOf(props["title"])}
      description={<Markdown text={textOf(props["description"])} />}
      {...(bound && { duration: 3000 })}
    />
  );
}

/** OpenUI's Steps; a step's details are a reply's Markdown text. */
export function StepsView({ props, renderNode }: ComponentRenderProps) {
  const items = Array.isArray(props["items"]) ? props["items"] : [];
  return (
    <OpenUISteps>
      {items.map((item: { props: Record<string, unknown> }, index: number) => {
        const details = item.props["details"];
        return (
          <OpenUIStepsItem
            key={index}
            number={index + 1}
            title={textOf(item.props["title"])}
            details={
              typeof details === "string" ? (
                <Markdown text={details} />
              ) : (
                renderNode(details)
              )
            }
          />
        );
      })}
    </OpenUISteps>
  );
}
