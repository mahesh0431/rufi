// A help page, drawn from its Markdown as written. No HTML and no images;
// links to other pages stay in Rufi, a link to Settings opens it at its
// group, and links to the web open outside it.
import { Link } from "@tanstack/react-router";
import { type ComponentProps, useEffect } from "react";
import Markdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HELP, helpLink, slug } from "./help.ts";
import { SettingsLink } from "./settings-link.tsx";

type Node = { type: string; value?: string; children?: Node[] };
const textOf = (node: Node): string =>
  node.value ?? (node.children ?? []).map(textOf).join("");

function Heading({
  as: Tag,
  node,
  ...props
}: ComponentProps<"h1"> & { as: "h1" | "h2" | "h3"; node?: Node }) {
  return <Tag id={node ? slug(textOf(node)) : undefined} {...props} />;
}

const components: Components = {
  h1: (props) => <Heading as="h1" {...props} />,
  h2: (props) => <Heading as="h2" {...props} />,
  h3: (props) => <Heading as="h3" {...props} />,
  a: ({ href = "", children }) => {
    const target = helpLink(href);
    if (target?.kind === "settings") {
      return <SettingsLink group={target.group}>{children}</SettingsLink>;
    }
    if (target?.kind === "page") {
      return (
        <Link
          to="/help/$page"
          params={{ page: target.page }}
          hash={target.anchor}
        >
          {children}
        </Link>
      );
    }
    if (target?.kind === "anchor") return <a href={href}>{children}</a>;
    if (target?.kind === "web") {
      return (
        <a href={target.url} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return <span>{children}</span>; // points to nothing Rufi has
  },
};

export function HelpPage({ page, hash }: { page: string; hash: string }) {
  const text = HELP[page];
  // Opening a page at an anchor shows that part.
  useEffect(() => {
    if (hash !== "") document.getElementById(hash)?.scrollIntoView();
  }, [page, hash]);

  return (
    <article className="prose mx-auto max-w-[720px] px-6 py-8">
      {text === undefined ? (
        <p>There is no help page called “{page}”.</p>
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={components}
          disallowedElements={["img"]}
          unwrapDisallowed
          skipHtml
          // A link to Settings (rufi:/settings/…) is kept; helpLink checks it.
          urlTransform={(url) =>
            url.startsWith("rufi:") ? url : defaultUrlTransform(url)
          }
        >
          {text}
        </Markdown>
      )}
    </article>
  );
}
