// Rufi's own lint rules, for what oxlint has no rule for.
const noSilentCatch = {
  meta: { type: "problem" },
  create(context) {
    return {
      CatchClause(node) {
        if (node.body.body.length === 0) {
          context.report({
            node,
            message:
              "Handle the error or rethrow it with { cause }; a comment is not handling.",
          });
        }
      },
    };
  },
};

/**
 * A throw that belongs to this catch: not one inside a function, static block
 * or nested catch, which has its own error.
 */
function throwsIn(node) {
  if (!node || typeof node.type !== "string") return false;
  if (node.type === "ThrowStatement") return true;
  if (/Function|StaticBlock|CatchClause/.test(node.type)) return false;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value) ? value.some(throwsIn) : throwsIn(value)),
  );
}

// A catch that throws a new error needs the caught one, to keep it as cause.
const noLostCause = {
  meta: { type: "problem" },
  create(context) {
    return {
      CatchClause(node) {
        if (node.param === null && throwsIn(node.body)) {
          context.report({
            node,
            message:
              "Name the caught error and pass it on as { cause }: this catch throws without it.",
          });
        }
      },
    };
  },
};

// Colours come only from the brand tokens (packages/brand/tokens.css, named
// for Tailwind in apps/web/src/themes.css): no
// Tailwind palette class, hex value or colour function in the code. A link's
// fragment (/help/page#add) is not a hex value.
const RAW_COLOUR =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|placeholder|decoration|caret|accent)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b|(?<![\w/])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b|(?<![a-z])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

const noRawColour = {
  meta: { type: "problem" },
  create(context) {
    const check = (node, text) => {
      if (typeof text === "string" && RAW_COLOUR.test(text)) {
        context.report({
          node,
          message:
            "Use a theme token (bg-surface, text-ink, …; packages/brand/tokens.css), not a raw colour.",
        });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
};

export default {
  meta: { name: "rufi" },
  rules: {
    "no-silent-catch": noSilentCatch,
    "no-lost-cause": noLostCause,
    "no-raw-colour": noRawColour,
  },
};
