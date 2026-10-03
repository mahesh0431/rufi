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

export default {
  meta: { name: "rufi" },
  rules: { "no-silent-catch": noSilentCatch, "no-lost-cause": noLostCause },
};
