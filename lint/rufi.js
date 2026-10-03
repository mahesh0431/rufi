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

export default {
  meta: { name: "rufi" },
  rules: { "no-silent-catch": noSilentCatch },
};
